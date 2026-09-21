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
/** 「最近一次执行内容」是给 UI 单行展示的预览，不重复 step 里可达 4000 字符的正文。 */
const MAX_PREVIEW = 200;

function preview(value) {
  const text = String(value ?? '');
  return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW - 1)}…` : text;
}

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

/** Records of one session file, lazily; `budget` is charged when the file is read. */
function* recordsOf(dir, file, budget) {
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

/**
 * Records of one task's sessions, oldest first. `budget` carries the byte count across the
 * iteration so one request never reads more than MAX_BYTES of session logs: running out is
 * not an error, the caller reports it as `truncated`.
 */
function* eachRecord(dir, files, budget) {
  for (const file of files) {
    if (budget.bytes > MAX_BYTES) return;
    yield* recordsOf(dir, file, budget);
  }
}

const num = value => (Number.isFinite(value) ? value : 0);
const tokensOf = row => num(row.totalTokens) || num(row.input) + num(row.output) + num(row.cacheRead) + num(row.cacheWrite);
/** 一次请求真正占用的上下文（输入侧）：input + 缓存读 + 缓存写，不含输出。 */
const contextOf = row => num(row.input) + num(row.cacheRead) + num(row.cacheWrite);

/** An assistant message's usage row, or null when the record is not a billed model request. */
function usageRow(record) {
  if (!record || record.type !== 'message') return null;
  const message = record.message;
  if (!message || typeof message !== 'object' || message.role !== 'assistant') return null;
  return message.usage && typeof message.usage === 'object' ? message.usage : null;
}

/** Exact, pi-recorded tokens of one assistant request: the whole reply's steps share them. */
function exactTokens(row, first) {
  return {
    input: num(row.input), output: num(row.output),
    cache_read: num(row.cacheRead), cache_write: num(row.cacheWrite),
    reasoning: num(row.reasoning), total: tokensOf(row), cost: num(row.cost?.total),
    exact: true, turn: true, ...(first ? { first: true } : {}),
  };
}

/**
 * Steps of a task's agent process, oldest first, across every wake and session file.
 * `after` is the last `seq` the caller already has, so the window is stable while
 * the agent keeps appending.
 *
 * Each step may carry `tokens`, in two mutually exclusive shapes:
 * - assistant steps of a billed request: `{input, output, cache_read, cache_write,
 *   reasoning, total, cost, exact: true, turn: true}`. Every step of one reply shares the
 *   same values; only the group's first step adds `first: true` so the UI prints it once.
 * - steps between two requests (`input` / `result` / `meta` / non-billed assistant):
 *   `{context_added, estimated: true, batch: true}`, again with `first: true` on the
 *   batch's first step. The estimate is a subtraction of adjacent requests:
 *   `N = (下一请求的 input + cacheRead + cacheWrite) − (上一请求的 tokensOf)`,
 *   i.e. how many tokens this batch (all its tool outputs and task context) pushed into
 *   the context. N ≤ 0 (before the first request, no next request, or compaction shrank
 *   the context) and file boundaries add no `tokens` at all: the estimate never crosses
 *   two session files, because the comparison point restarts with each file.
 */
export function readTranscript(config, taskId, after = 0, limit = 100) {
  check(Number.isSafeInteger(after) && after >= 0, 'invalid transcript cursor');
  check(Number.isInteger(limit) && limit > 0 && limit <= MAX_STEPS, `transcript limit must be 1..${MAX_STEPS}`);
  const dir = sessionDir(config);
  const files = sessionFiles(config, taskId);
  const budget = { bytes: 0 };
  const steps = [];
  let seq = 0;
  let hasMore = false;
  let draining = false;   // 窗口已满，只在当前会话文件里等未决批次的下一次请求
  let prev = null;        // 本文件里上一次 assistant 请求的 tokensOf；文件边界重置
  let batch = null;       // 上一个请求之后、下一个请求之前的步骤：{firstSeen, pending}

  const resolveBatch = row => {
    if (!batch) return;
    // 估算口径见函数注释：下一次请求的输入侧 − 上一次请求的总量。
    const added = contextOf(row) - prev;
    if (added > 0) {
      for (const { step, first } of batch.pending) {
        step.tokens = { context_added: added, estimated: true, batch: true, ...(first ? { first: true } : {}) };
      }
    }
    batch = null;
  };

  outer:
  for (const name of files) {
    if (budget.bytes > MAX_BYTES) break;
    prev = null;   // 跨会话文件不推算：文件边界重置「上一次请求」，未完成的批次就此断开
    batch = null;
    for (const item of recordsOf(dir, name, budget)) {
      const row = usageRow(item.record);
      if (draining) {
        if (!batch) break outer;                    // 窗口满且没有未决批次：不必再读
        if (row) { resolveBatch(row); break outer; } // 补上窗口末尾批次的 N 后收工
        continue;                                    // 同一文件里继续找下一次请求
      }
      const projected = project(item.record);
      if (row) {
        resolveBatch(row);
        let full = false;
        for (let index = 0; index < projected.length; index += 1) {
          seq += 1;
          if (seq <= after) continue;
          if (steps.length >= limit) { full = true; break; }
          steps.push({ seq, file: name, line: item.line, ...projected[index], tokens: exactTokens(row, index === 0) });
        }
        prev = tokensOf(row);
        if (full) { hasMore = true; draining = true; }
        if (draining) break;   // 精确组填满窗口：没有未决批次，本文件到此为止
        continue;
      }
      if (prev === null) {
        // 首个请求之前（或每个文件的开头）没有可比对的上下文，不给 tokens。
        let full = false;
        for (const step of projected) {
          seq += 1;
          if (seq <= after) continue;
          if (steps.length >= limit) { full = true; break; }
          steps.push({ seq, file: name, line: item.line, ...step });
        }
        if (full) { hasMore = true; draining = true; break; }
        continue;
      }
      if (!batch) batch = { firstSeen: false, pending: [] };
      let full = false;
      for (const step of projected) {
        const first = !batch.firstSeen;
        batch.firstSeen = true;
        seq += 1;
        if (seq <= after) continue;
        if (steps.length >= limit) { full = true; break; }
        const out = { seq, file: name, line: item.line, ...step };
        batch.pending.push({ step: out, first });
        steps.push(out);
      }
      if (full) {
        hasMore = true;
        draining = true;
        // 本批已发出步骤才需要继续读，去找下一次请求补 N；否则窗口已满即可收工。
        if (!batch.pending.length) break;
      }
    }
    if (draining) break;   // 窗口满：不读后续会话文件，lookahead 不超出本次预算
  }

  const window = bounded(steps, 900000);
  return {
    task_id: taskId, files, steps: window, next: window.length ? window.at(-1).seq : after,
    has_more: hasMore, truncated: budget.bytes > MAX_BYTES,
  };
}

/**
 * What one agent spent: the model it ran on, how full its context is, what the session cost
 * so far, and the last execution step (time + short preview). Same files as the transcript,
 * but steps are not returned wholesale: only the final one is previewed for the task detail.
 */
export function readUsage(config, taskId) {
  const files = sessionFiles(config, taskId);
  const budget = { bytes: 0 };
  const totals = { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, tokens: 0, cost: 0 };
  const usage = {
    task_id: taskId, files, model: null, thinking_level: null, requests: 0,
    context_tokens: 0, compacted: 0, last_at: null, last: null, totals, truncated: false,
  };
  for (const { record } of eachRecord(sessionDir(config), files, budget)) {
    // 「最近一次执行」= 执行过程最后一条可显示步骤（与 transcript 同一套 project()/stamp()）；
    // 若这一步没有时间戳，at 向前回退到最近一条有时间的步骤。
    // 最后一步来自带 usage 的 assistant 消息时，与 transcript 一样带上精确 tokens。
    const row = usageRow(record);
    const projected = project(record);
    for (let index = 0; index < projected.length; index += 1) {
      const step = projected[index];
      usage.last = {
        at: step.at ?? usage.last?.at ?? null, kind: step.kind, title: step.title, body: preview(step.body),
        ...(row ? { tokens: exactTokens(row, index === 0) } : {}),
      };
    }
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
    if (!row) continue;
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
