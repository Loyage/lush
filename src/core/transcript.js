/**
 * Read-only projector for pi session records.
 *
 * A task's agent process (thinking, tool calls, tool output) is written by pi as
 * JSONL under `<home>/sessions`, never into SQLite: the daemon only stores the
 * final stdout as `tasks.result`. This module is the only reader of those files
 * and it never writes, moves or deletes them — the session file stays the
 * agent's own record, and the task's `result` stays the review artifact.
 */
import fs from 'node:fs';
import path from 'node:path';
import { check, bounded } from './types.js';

/** One step body is clipped: a single tool output can be megabytes. */
const MAX_BODY = 4000;
/** Per-request step window; the Web UI pages through the rest with `after`. */
export const MAX_STEPS = 200;
/** Total bytes read from one task's session files per request. */
const MAX_BYTES = 8 * 1024 * 1024;

function clip(value) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n…（已截断 ${text.length - MAX_BODY} 字符）` : text;
}

/** pi writes epoch milliseconds on messages and ISO strings on its own records. */
function stamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(Date.parse(value)).toISOString();
  return null;
}

const parts = content => (Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []);
const textOf = content => parts(content).map(part => part.text ?? part.thinking ?? '').filter(Boolean).join('\n');

function meta(record, at) {
  if (record.type === 'session') return [];
  if (record.type === 'model_change') return [{ kind: 'meta', title: `${record.provider}/${record.modelId}`, at, body: '' }];
  if (record.type === 'thinking_level_change') return [{ kind: 'meta', title: `思考等级 ${record.thinkingLevel}`, at, body: '' }];
  return [{ kind: 'meta', title: record.type, at, body: clip(Object.keys(record).filter(key => key !== 'type').join(', ')) }];
}

function fromMessage(record, at) {
  const message = record.message;
  if (!message || typeof message !== 'object') return [];
  if (message.role === 'user') return [{ kind: 'input', title: '任务上下文', at, body: clip(textOf(message.content)) }];
  if (message.role === 'toolResult') {
    return [{ kind: 'result', title: `${message.toolName}${message.isError ? '（失败）' : ''}`, at, body: clip(textOf(message.content)) }];
  }
  if (message.role !== 'assistant') return [{ kind: 'meta', title: `消息 ${message.role}`, at, body: clip(textOf(message.content)) }];
  return parts(message.content).map(part => {
    if (part.type === 'thinking') return { kind: 'thinking', title: '思考', at, body: clip(part.thinking) };
    if (part.type === 'toolCall') return { kind: 'tool', title: part.name || 'tool', at, body: clip(part.arguments ?? {}) };
    return { kind: 'text', title: '回答', at, body: clip(part.text) };
  }).filter(step => step.body || step.kind === 'meta');
}

/** One JSONL record becomes zero or more steps; an unparseable line is skipped, never fatal. */
function project(record) {
  if (!record || typeof record !== 'object') return [];
  const at = stamp(record.timestamp);
  if (record.type !== 'message') return meta(record, at);
  return fromMessage(record, at);
}

const sessionDir = config => path.join(config.home, 'sessions');

/** Session files for one task, oldest first; the name prefix is the session start time. */
export function sessionFiles(config, taskId) {
  const dir = sessionDir(config);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith(`_lush-task-${taskId}.jsonl`)).sort();
}

/**
 * Records of one task's sessions, oldest first. `budget` carries the byte count across the
 * iteration so one request never reads more than MAX_BYTES of session logs: running out is
 * not an error, the caller reports it as `truncated`.
 */
function* eachRecord(dir, files, budget) {
  for (const file of files) {
    if (budget.bytes > MAX_BYTES) return;
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    budget.bytes += raw.length;
    const lines = raw.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue;
      let record;
      // A killed agent can leave a half-written last line; that is not an error.
      try { record = JSON.parse(lines[index]); } catch { continue; }
      yield { file, line: index + 1, record };
    }
  }
}

/**
 * Steps of a task's agent process, oldest first, across every wake and session file.
 * `after` is the last `seq` the caller already has, so the window is stable while
 * the agent keeps appending.
 */
export function readTranscript(config, taskId, after = 0, limit = 100) {
  check(Number.isSafeInteger(after) && after >= 0, 'invalid transcript cursor');
  check(Number.isInteger(limit) && limit > 0 && limit <= MAX_STEPS, `transcript limit must be 1..${MAX_STEPS}`);
  const files = sessionFiles(config, taskId);
  const budget = { bytes: 0 };
  const steps = [];
  let seq = 0;
  let hasMore = false;
  for (const { file, line, record } of eachRecord(sessionDir(config), files, budget)) {
    for (const step of project(record)) {
      seq += 1;
      if (seq <= after) continue;
      if (steps.length >= limit) { hasMore = true; break; }
      steps.push({ seq, file, line, ...step });
    }
    if (hasMore) break;
  }
  const window = bounded(steps, 900000);
  return {
    task_id: taskId, files, steps: window, next: window.length ? window.at(-1).seq : after,
    has_more: hasMore, truncated: budget.bytes > MAX_BYTES,
  };
}

const num = value => (Number.isFinite(value) ? value : 0);
const tokensOf = row => num(row.totalTokens) || num(row.input) + num(row.output) + num(row.cacheRead) + num(row.cacheWrite);

/**
 * What one agent spent: the model it ran on, how full its context is and what the session cost
 * so far. Same files as the transcript, but nothing is projected into steps — the Web UI shows
 * this on every task detail, so it must not pay for ~4 KB bodies it will not render.
 */
export function readUsage(config, taskId) {
  const files = sessionFiles(config, taskId);
  const budget = { bytes: 0 };
  const totals = { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, tokens: 0, cost: 0 };
  const usage = {
    task_id: taskId, files, model: null, thinking_level: null, requests: 0,
    context_tokens: 0, compacted: 0, last_at: null, totals, truncated: false,
  };
  for (const { record } of eachRecord(sessionDir(config), files, budget)) {
    const at = stamp(record.timestamp);
    if (record.type === 'model_change') {
      usage.model = { provider: record.provider ?? null, model_id: record.modelId ?? null };
      continue;
    }
    if (record.type === 'thinking_level_change') { usage.thinking_level = record.thinkingLevel ?? null; continue; }
    if (record.type === 'compaction') { usage.compacted += 1; continue; }
    const message = record.type === 'message' ? record.message : null;
    if (!message || message.role !== 'assistant') continue;
    usage.requests += 1;
    // 每次请求都带 provider/model：模型中途被换掉时，界面显示的是最近一次真正用到的。
    if (message.provider || message.model) usage.model = { provider: message.provider ?? null, model_id: message.model ?? null };
    const row = message.usage;
    if (!row || typeof row !== 'object') continue;
    totals.input += num(row.input); totals.output += num(row.output);
    totals.cache_read += num(row.cacheRead); totals.cache_write += num(row.cacheWrite);
    totals.reasoning += num(row.reasoning); totals.tokens += tokensOf(row);
    totals.cost += num(row.cost?.total);
    // 上下文占用取最近一次请求：它等于那一刻上下文里真的有多少 token。
    usage.context_tokens = tokensOf(row);
    usage.last_at = at;
  }
  usage.truncated = budget.bytes > MAX_BYTES;
  return usage;
}
