import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { readTranscript, readTranscriptLatest } from '../src/core/transcript.js';
import { LushError } from '../src/core/types.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../src/rpc/registry.js';

/** pi 的会话记录长这样：一行一条 JSON，消息正文按 part 排列。 */
function sessionFile(root, taskId, lines, name = `2026-01-01T00-00-00-000Z_lush-task-${taskId}.jsonl`) {
  const dir = path.join(root, '.lush', 'sessions');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, name), lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
  return path.join(dir, name);
}
const assistant = (text, timestamp) => ({ type: 'message', timestamp,
  message: { role: 'assistant', provider: 'mock', model: 'mock-1', content: [{ type: 'text', text }] } });
const billing = (text, usage, timestamp) => ({ type: 'message', timestamp,
  message: { role: 'assistant', provider: 'mock', model: 'mock-1', content: [{ type: 'text', text }], usage } });
const result = (name, text, timestamp) => ({ type: 'message', timestamp,
  message: { role: 'toolResult', toolCallId: 'call_1', toolName: name, isError: false, content: [{ type: 'text', text }] } });

test('latest returns the newest window with cursor metadata and read-direction defaults', async () => {
  const f = fixture();
  try {
    sessionFile(f.root, 1, Array.from({ length: 10 }, (_v, index) => assistant(`step ${index}`, 1000 + index)));
    const last = await readTranscriptLatest(f.config, 1, { limit: 3 });
    expect(last.steps.map(step => step.body)).toEqual(['step 7', 'step 8', 'step 9']);
    expect(last).toMatchObject({ task_id: 1, next: 10, oldest: 8, has_older: true, truncated: false });
    expect(last.files).toEqual(['2026-01-01T00-00-00-000Z_lush-task-1.jsonl']);
    // after 只看新增，has_older 对仍被截断的旧前缀为真；到末尾则空
    expect((await readTranscriptLatest(f.config, 1, { after: 7, limit: 100 })).steps.map(step => step.seq)).toEqual([8, 9, 10]);
    expect(await readTranscriptLatest(f.config, 1, { after: 10, limit: 100 }))
      .toMatchObject({ steps: [], next: 10, oldest: 0, has_older: false });
    // before 从当前窗口往回翻：范围是 (0, before)
    expect((await readTranscriptLatest(f.config, 1, { before: 4, limit: 100 })).steps.map(step => step.seq)).toEqual([1, 2, 3]);
    // 没有会话文件不是错误，也不冒充有数据
    expect(await readTranscriptLatest(f.config, 99, { limit: 5 }))
      .toEqual({ task_id: 99, steps: [], files: [], next: 0, oldest: 0, has_older: false, truncated: false });
    await expect(readTranscriptLatest(f.config, 1, { after: -1 })).rejects.toThrow(LushError);
    await expect(readTranscriptLatest(f.config, 1, { before: -1 })).rejects.toThrow(LushError);
    await expect(readTranscriptLatest(f.config, 1, { limit: 0 })).rejects.toThrow('limit');
    await expect(readTranscriptLatest(f.config, 1, { limit: 201 })).rejects.toThrow('limit');
  } finally { await f.close(); }
});

test('before pages backwards without overlap or gaps', async () => {
  const f = fixture();
  try {
    sessionFile(f.root, 2, Array.from({ length: 9 }, (_v, index) => assistant(`s${index}`, 1000 + index)));
    const collected = [];
    let cursor = 0;
    for (let page = 0; page < 3; page += 1) {
      const result = await readTranscriptLatest(f.config, 2, { before: cursor, limit: 4 });
      collected.unshift(...result.steps.map(step => step.seq));
      cursor = result.oldest;
      if (!result.has_older) break;
    }
    expect(collected).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const tail = await readTranscriptLatest(f.config, 2, { limit: 4 });
    expect(tail.steps.map(step => step.seq)).toEqual([6, 7, 8, 9]);
    expect(tail.has_older).toBe(true);
  } finally { await f.close(); }
});

test('after returns only appended steps and keeps earlier seq stable', async () => {
  const f = fixture();
  try {
    const file = sessionFile(f.root, 3, Array.from({ length: 3 }, (_v, index) => assistant(`old ${index}`, 1000 + index)));
    expect((await readTranscriptLatest(f.config, 3, { after: 3 })).steps).toEqual([]);
    fs.appendFileSync(file, Array.from({ length: 2 }, (_v, index) =>
      `${JSON.stringify(assistant(`new ${index}`, 2000 + index))}\n`).join(''));
    const appended = await readTranscriptLatest(f.config, 3, { after: 3 });
    expect(appended.steps.map(step => [step.seq, step.body])).toEqual([[4, 'new 0'], [5, 'new 1']]);
    expect(appended).toMatchObject({ next: 5, oldest: 4, has_older: false });
  } finally { await f.close(); }
});

test('latest keeps readTranscript token and clipping semantics for the same window', async () => {
  const f = fixture();
  try {
    sessionFile(f.root, 4, [
      assistant('first context', 1000),
      billing('a', { input: 100, output: 20, cacheRead: 200, cacheWrite: 5, reasoning: 7, totalTokens: 325, cost: { total: 0.001 } }, 2000),
      result('bash', 'out1', 2500),
      result('edit', 'out2', 2600),
      billing('b', { input: 1000, output: 30, cacheRead: 50, cacheWrite: 0, reasoning: 3, totalTokens: 1080, cost: { total: 0.002 } }, 3000),
      result('bash', 'x'.repeat(9000), 3500),
      billing('c', { input: 1500, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 1510, cost: { total: 0.003 } }, 4000),
    ]);
    const head = readTranscript(f.config, 4, 0, 100);
    const tail = await readTranscriptLatest(f.config, 4, { limit: 4 });
    const strip = ({ file: _file, ...step }) => step;
    expect(tail.steps.map(strip)).toEqual(head.steps.slice(-4).map(strip));
    // 窗口末尾的批次用下一条请求补 N：改读方向后同一批次的 first 只落在批首
    const mid = await readTranscriptLatest(f.config, 4, { after: 3, limit: 4 });
    expect(mid.steps.map(strip)).toEqual(head.steps.filter(step => step.seq > 3).map(strip));
    expect(mid.steps.find(step => step.seq === 4).tokens.first).toBeUndefined();   // 批首 seq3 已不在窗口
    // after 下界内仍取"最新 limit 步"，不是最早 limit 步
    expect((await readTranscriptLatest(f.config, 4, { after: 2, limit: 3 })).steps.map(step => step.seq)).toEqual([5, 6, 7]);
    // 超长正文按同一条「…（已截断 N 字符）」投影，不再有第二种裁剪口径
    const clipped = tail.steps.find(step => step.seq === 6);
    expect(clipped.body).toContain('已截断');
    expect(clipped.body).toBe(head.steps.find(step => step.seq === 6).body);
  } finally { await f.close(); }
});

test('latest reaches the tail beyond the 8 MiB head window', async () => {
  const f = fixture();
  try {
    const lines = Array.from({ length: 2100 }, (_v, index) => assistant('填'.repeat(1500), 1000 + index));
    lines.push(assistant('tail-needle', 9999));
    const file = sessionFile(f.root, 5, lines);
    expect(fs.statSync(file).size).toBeGreaterThan(8 * 1024 * 1024);
    const head = readTranscript(f.config, 5, 0, 100);
    expect(head.truncated).toBe(true);
    expect(head.steps.some(step => step.body.includes('tail-needle'))).toBe(false);
    const latest = await readTranscriptLatest(f.config, 5, { limit: 1 });
    expect(latest.steps).toHaveLength(1);
    expect(latest.steps[0].body).toBe('tail-needle');
    expect(latest.truncated).toBe(false);
    expect(latest.has_older).toBe(true);
  } finally { await f.close(); }
});

test('latest skips malformed lines and marks an over-long line truncated instead of empty', async () => {
  const f = fixture();
  try {
    sessionFile(f.root, 6, [assistant('good 1', 1000), '{"type":"message","message":{"role":"assist', assistant('good 2', 2000)]);
    const skipped = await readTranscriptLatest(f.config, 6, { limit: 10 });
    expect(skipped.steps.map(step => step.body)).toEqual(['good 1', 'good 2']);
    expect(skipped.truncated).toBe(false);
    expect(skipped.steps.map(step => step.seq)).toEqual([1, 2]);

    const huge = 'x'.repeat(16 * 1024 * 1024 + 1);
    sessionFile(f.root, 7, [`${huge}\n`, `${JSON.stringify(assistant('after huge', 1000))}\n`]);
    const marked = await readTranscriptLatest(f.config, 7, { limit: 10 });
    expect(marked.steps.map(step => step.body)).toEqual(['after huge']);
    expect(marked.truncated).toBe(true);

    sessionFile(f.root, 8, [`${huge}\n`]);
    const empty = await readTranscriptLatest(f.config, 8, { limit: 10 });
    expect(empty.steps).toEqual([]);
    expect(empty.truncated).toBe(true);
  } finally { await f.close(); }
});

test('latest scans across session files in the same order as the head reader', async () => {
  const f = fixture();
  try {
    sessionFile(f.root, 9, [assistant('old file', 1000)], '2026-01-01T00-00-00-000Z_lush-task-9.jsonl');
    sessionFile(f.root, 9, [assistant('new file', 2000)], '2026-02-01T00-00-00-000Z_lush-task-9.jsonl');
    const latest = await readTranscriptLatest(f.config, 9, { limit: 10 });
    expect(latest.steps.map(step => [step.body, step.file])).toEqual([
      ['old file', '2026-01-01T00-00-00-000Z_lush-task-9.jsonl'],
      ['new file', '2026-02-01T00-00-00-000Z_lush-task-9.jsonl'],
    ]);
    expect(latest.steps.map(step => step.seq)).toEqual([1, 2]);
    // 文件边界不跨文件推算：新文件的首个请求之前没有可比对上下文
    expect(latest.steps[0].tokens).toBeUndefined();
    expect(latest.steps[1].tokens).toBeUndefined();
  } finally { await f.close(); }
});

test('task.transcript_latest is a user-only read RPC with the documented params', () => {
  expect(PARAMS['task.transcript_latest']).toEqual(['id', 'after', 'before', 'limit']);
  expect(USER_ONLY.has('task.transcript_latest')).toBe(true);
  expect(() => assertAllowed('task.transcript_latest', { id: 1 }, { id: 1 })).toThrow('requires user approval');
});
