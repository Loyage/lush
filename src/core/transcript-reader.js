import fs from 'node:fs';
import path from 'node:path';
import { check } from './types.js';
import { projectRecord, sessionFiles } from './transcript.js';

const MAX_LINE = 16 * 1024 * 1024;
const BODY_PAGE = 24000;
const KINDS = new Set(['', 'input', 'thinking', 'tool', 'result', 'text', 'meta']);

/** Stream all completed records, not the compatibility reader's first 8 MiB. Never cache full bodies. */
async function* stepsOf(config, taskId) {
  let seq = 0;
  for (const file of sessionFiles(config, taskId)) {
    const filename = path.join(config.home, 'sessions', file);
    const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      check(stat.isFile(), 'session is not a regular file');
      if (!stat.size) continue;
      const stream = handle.createReadStream({ autoClose: false, start: 0, end: stat.size - 1, highWaterMark: 65536 });
      let fragments = [], size = 0, line = 0;
      for await (const chunk of stream) {
        let start = 0;
        for (let at = 0; at < chunk.length; at++) {
          if (chunk[at] !== 10) continue;
          const tail = chunk.subarray(start, at);
          check(size + tail.length <= MAX_LINE, `会话 ${file} 第 ${line + 1} 行超过 16 MiB，无法完整检索；不是没有命中`);
          const text = Buffer.concat([...fragments, tail], size + tail.length).toString('utf8');
          fragments = []; size = 0; line++; start = at + 1;
          let record;
          try { record = JSON.parse(text); } catch { continue; }
          for (const step of projectRecord(record, Infinity)) {
            check(String(step.title).length <= 2000 && String(step.call_id ?? '').length <= 1024
              && String(step.tool_name ?? '').length <= 2000, '会话元数据过长，无法完整检索');
            yield { seq: ++seq, file, line, ...step };
          }
        }
        if (start < chunk.length) {
          const tail = Buffer.from(chunk.subarray(start)); size += tail.length; fragments.push(tail);
          check(size <= MAX_LINE, `会话 ${file} 第 ${line + 1} 行超过 16 MiB，无法完整检索；不是没有命中`);
        }
      }
      // An unfinished trailing line is not a committed record (same policy as the compatibility reader).
    } finally { await handle.close(); }
  }
}

function summary(step, query = '') {
  const body = step.body || '';
  const index = query ? body.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : 0;
  const start = Math.max(0, index - 160);
  return { ...step, body: body.slice(0, 1800), body_length: body.length,
    excerpt: `${start ? '…' : ''}${body.slice(start, start + 500)}`, body_truncated: body.length > 1800 };
}

export async function searchTranscript(config, taskId, { query = '', kind = '', tool = '', errors = false, after = 0, limit = 50 } = {}) {
  check(typeof query === 'string' && query.length <= 500, 'query must be at most 500 characters');
  check(KINDS.has(kind), 'invalid transcript kind');
  check(typeof tool === 'string' && tool.length <= 100, 'invalid tool filter');
  check(typeof errors === 'boolean', 'errors must be boolean');
  check(Number.isSafeInteger(after) && after >= 0, 'invalid transcript cursor');
  check(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'limit must be 1..100');
  const steps = [], needle = query.toLocaleLowerCase(), toolNeedle = tool.toLocaleLowerCase();
  let has_more = false, responseBytes = 0;
  for await (const step of stepsOf(config, taskId)) {
    if (step.seq <= after || (kind && step.kind !== kind) || (errors && !step.is_error)) continue;
    if (toolNeedle && !(step.tool_name || '').toLocaleLowerCase().includes(toolNeedle)) continue;
    if (needle && !`${step.title}\n${step.body}`.toLocaleLowerCase().includes(needle)) continue;
    const item = summary(step, query), bytes = Buffer.byteLength(JSON.stringify(item));
    if (steps.length === limit || responseBytes + bytes > 700000) { has_more = true; break; }
    steps.push(item); responseBytes += bytes;
  }
  return { task_id: taskId, steps, next: steps.at(-1)?.seq ?? after, has_more,
    files: sessionFiles(config, taskId), scope: 'all-complete-records', truncated: false };
}

/** Read one original step in bounded character pages; associated bodies are explicitly bounded snapshots. */
export async function transcriptStep(config, taskId, seq, offset = 0) {
  check(Number.isSafeInteger(seq) && seq > 0, 'invalid step seq');
  check(Number.isSafeInteger(offset) && offset >= 0, 'invalid body offset');
  let target;
  for await (const step of stepsOf(config, taskId)) if (step.seq === seq) { target = step; break; }
  check(target, '执行步骤已不存在，可能会话文件已被清理');
  const related = [], context = [];
  let calls = 0, pairedCount = 0;
  for await (const step of stepsOf(config, taskId)) {
    const paired = target.call_id && step.file === target.file && step.call_id === target.call_id
      && ['tool', 'result'].includes(step.kind);
    if (paired && step.kind === 'tool') calls++;
    if (step.seq === seq) continue;
    if (paired) pairedCount++;
    if (paired && related.length < 8) related.push(summary(step));
    else if (Math.abs(step.seq - seq) <= 2) context.push(summary(step));
  }
  const pairing_ambiguous = calls > 1;
  if (calls !== 1) related.length = 0;
  const full = target.body || '';
  check(offset <= full.length, 'body offset exceeds original text');
  return { task_id: taskId, step: { ...target, body: full.slice(offset, offset + BODY_PAGE), body_length: full.length },
    offset, next_offset: Math.min(full.length, offset + BODY_PAGE), has_more: offset + BODY_PAGE < full.length, related, context, pairing_ambiguous, related_truncated: pairedCount > 8 };
}
