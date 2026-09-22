import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { readTranscript, readUsage, sessionFiles, transcriptReadStats } from '../src/core/transcript.js';
import { LushError } from '../src/core/types.js';

/** pi 的会话记录长这样：一行一条 JSON，消息正文按 part 排列。 */
function sessionFile(root, taskId, lines, name = `2026-01-01T00-00-00-000Z_lush-task-${taskId}.jsonl`) {
  const dir = path.join(root, '.lush', 'sessions');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, name), lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
  return path.join(dir, name);
}
const message = (role, content, timestamp = 1789749049638) => ({ type: 'message', timestamp, message: { role, content } });
/** assistant 消息带 pi 的用量：模型每次请求都给出 token 与按单价算好的花费。 */
const billing = (text, usage, timestamp) => ({ type: 'message', timestamp,
  message: { role: 'assistant', provider: 'deepseek', model: 'deepseek-flash', content: [{ type: 'text', text }], usage } });
/** assistant 消息拆成多个 part，用来断言同一条消息的多个 step 共享同一组精确用量。 */
const assistant = (parts, usage, timestamp) => ({ type: 'message', timestamp,
  message: { role: 'assistant', provider: 'deepseek', model: 'deepseek-flash', content: parts, usage } });
const result = (name, text, timestamp) => ({ type: 'message', timestamp,
  message: { role: 'toolResult', toolCallId: 'call_1', toolName: name, isError: false, content: [{ type: 'text', text }] } });

test('transcript projects pi session records into ordered steps', () => {
  const f = fixture();
  try {
    sessionFile(f.root, 1, [
      { type: 'session', id: 'lush-task-1', cwd: '/tmp/proj' },
      { type: 'model_change', provider: 'deepseek', modelId: 'deepseek-flash' },
      { type: 'thinking_level_change', thinkingLevel: 'high' },
      message('user', [{ type: 'text', text: 'Read the task input.' }], '2026-01-01T00:00:01.000Z'),
      message('assistant', [
        { type: 'thinking', thinking: 'Let me look around.' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
      ]),
      { type: 'message', timestamp: 1789749049638, message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'src\nREADME.md' }] } },
      message('assistant', [{ type: 'text', text: 'Done.' }]),
      { type: 'message', timestamp: 1789749049638, message: { role: 'toolResult', toolName: 'edit', isError: true, content: [{ type: 'text', text: 'oldText not found' }] } },
      '{"type":"message","message":{"role":"assist',     // 被杀掉的进程留下的半行
      { type: 'compaction', reason: 'budget' },           // 未知类型不丢，降级成 meta
    ]);
    const page = readTranscript(f.config, 1, 0, 100);
    expect(page.files).toEqual(['2026-01-01T00-00-00-000Z_lush-task-1.jsonl']);
    expect(page.has_more).toBe(false);
    expect(page.truncated).toBe(false);
    expect(page.steps.map(step => step.kind)).toEqual(['meta', 'meta', 'input', 'thinking', 'tool', 'result', 'text', 'result', 'meta']);
    expect(page.steps.map(step => step.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(page.steps[0].title).toBe('deepseek/deepseek-flash');
    expect(page.steps[1].title).toBe('思考等级 high');
    expect(page.steps[2].at).toBe('2026-01-01T00:00:01.000Z');
    expect(page.steps[4].title).toBe('bash');
    expect(JSON.parse(page.steps[4].body)).toEqual({ command: 'ls' });
    expect(page.steps[5].body).toBe('src\nREADME.md');
    expect(page.steps[5].title).toBe('bash');
    expect(page.steps[7].title).toBe('edit（失败）');
    expect(page.steps[6].body).toBe('Done.');
    expect(page.steps[8].title).toBe('compaction');
    expect(page.next).toBe(9);
  } finally { f.close(); }
});

test('transcript pages by cursor, keeps the window stable and stays read-only', () => {
  const f = fixture();
  try {
    const file = sessionFile(f.root, 2, Array.from({ length: 7 }, (_v, index) =>
      message('assistant', [{ type: 'text', text: `step ${index}` }], 1789749049000 + index * 1000)));
    const before = fs.readFileSync(file, 'utf8');
    const first = readTranscript(f.config, 2, 0, 3);
    expect(first.steps.map(step => step.body)).toEqual(['step 0', 'step 1', 'step 2']);
    expect(first.has_more).toBe(true);
    const second = readTranscript(f.config, 2, first.next, 3);
    expect(second.steps.map(step => step.body)).toEqual(['step 3', 'step 4', 'step 5']);
    expect(second.has_more).toBe(true);
    const third = readTranscript(f.config, 2, second.next, 3);
    expect(third.steps.map(step => step.body)).toEqual(['step 6']);
    expect(third.has_more).toBe(false);
    expect(readTranscript(f.config, 2, third.next, 3).steps).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.join(f.root, '.lush', 'sessions'))).toEqual([path.basename(file)]);
  } finally { f.close(); }
});

test('usage reports model, context and cost across session files without projecting steps', () => {
  const f = fixture();
  try {
    sessionFile(f.root, 4, [
      { type: 'session', id: 'lush-task-4', cwd: '/tmp/proj' },
      { type: 'model_change', provider: 'deepseek', modelId: 'deepseek-flash' },
      { type: 'thinking_level_change', thinkingLevel: 'high' },
      message('user', [{ type: 'text', text: 'go' }], 1000),
      billing('first', { input: 100, output: 20, cacheRead: 200, cacheWrite: 0, reasoning: 5, totalTokens: 320, cost: { total: 0.0004 } }, 2000),
      { type: 'compaction', summary: 'so far', tokensBefore: 120000 },
    ], '2026-01-01T00-00-00-000Z_lush-task-4.jsonl');
    sessionFile(f.root, 4, [
      billing('second', { input: 10, output: 2, cacheRead: 300, cacheWrite: 4, reasoning: 0, totalTokens: 316, cost: { total: 0.00006 } }, 3000),
    ], '2026-02-01T00-00-00-000Z_lush-task-4.jsonl');
    const usage = readUsage(f.config, 4);
    expect(usage.files).toEqual(['2026-01-01T00-00-00-000Z_lush-task-4.jsonl', '2026-02-01T00-00-00-000Z_lush-task-4.jsonl']);
    expect(usage.model).toEqual({ provider: 'deepseek', model_id: 'deepseek-flash' });
    expect(usage.thinking_level).toBe('high');
    expect(usage.requests).toBe(2);
    expect(usage.compacted).toBe(1);
    expect(usage.context_tokens).toBe(316);                     // 最近一次请求，不是累计
    expect(usage.totals.input).toBe(110);
    expect(usage.totals.output).toBe(22);
    expect(usage.totals.cache_read).toBe(500);
    expect(usage.totals.cache_write).toBe(4);
    expect(usage.totals.reasoning).toBe(5);
    expect(usage.totals.tokens).toBe(636);
    expect(usage.totals.cost).toBeCloseTo(0.00046, 9);
    expect(usage.last_at).toBe(new Date(3000).toISOString());
    expect(usage.steps).toBeUndefined();                         // 只有统计，不投影正文
    // 没有会话记录、没有用量的会话都只是空统计，不是错误
    expect(readUsage(f.config, 99)).toEqual({ task_id: 99, files: [], model: null, thinking_level: null, requests: 0, compacted: 0,
      context_tokens: 0, last_at: null, last: null, totals: { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, tokens: 0, cost: 0 }, truncated: false });
    sessionFile(f.root, 5, [message('assistant', [{ type: 'text', text: 'no usage here' }])]);
    expect(readUsage(f.config, 5)).toMatchObject({ requests: 1, context_tokens: 0, last_at: null });
    expect(readUsage(f.config, 5).model).toBeNull();
  } finally { f.close(); }
});

test('usage reports the last execution step with its time and a short preview', () => {
  const f = fixture();
  try {
    sessionFile(f.root, 6, [
      billing('first', { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } }, 1000),
      { type: 'message', message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'x'.repeat(500) }] } }, // 没有 timestamp
      { type: 'message', timestamp: 2000, message: { role: 'assistant', content: [{ type: 'text', text: '最后一步' }] } },
    ]);
    const usage = readUsage(f.config, 6);
    // kind/title 与步骤一致，body 是 ≤200 字符的预览
    expect(usage.last).toEqual({ at: new Date(2000).toISOString(), kind: 'text', title: '回答', body: '最后一步' });
    // 最后一步没有时间戳时，at 回退到最近一条有时间戳的步骤
    sessionFile(f.root, 7, [
      { type: 'message', timestamp: 3000, message: { role: 'assistant', content: [{ type: 'text', text: '有时间戳' }] } },
      { type: 'message', message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'y'.repeat(500) }] } },
    ]);
    const fallback = readUsage(f.config, 7);
    expect(fallback.last.at).toBe(new Date(3000).toISOString());
    expect(fallback.last.kind).toBe('result');
    expect(fallback.last.title).toBe('bash');
    expect(fallback.last.body.length).toBeLessThanOrEqual(200);
    expect(fallback.last.body).toContain('…');
    // 没有任何会话/步骤时为 null
    expect(readUsage(f.config, 98).last).toBeNull();
  } finally { f.close(); }
});

test('transcript attaches exact tokens to billed assistant steps and estimates the steps in between', () => {
  const f = fixture();
  try {
    sessionFile(f.root, 20, [
      { type: 'session', id: 'lush-task-20', cwd: '/tmp/proj' },
      message('user', [{ type: 'text', text: '任务上下文' }], 1000),
      assistant([
        { type: 'thinking', thinking: '先看看' },
        { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
        { type: 'text', text: '第一次回答' },
      ], { input: 100, output: 20, cacheRead: 200, cacheWrite: 5, reasoning: 7, totalTokens: 325, cost: { total: 0.001 } }, 2000),
      result('bash', 'out1', 2500),
      result('edit', 'out2', 2600),
      assistant([{ type: 'text', text: '第二次回答' }],
        { input: 1000, output: 30, cacheRead: 50, cacheWrite: 0, reasoning: 3, totalTokens: 1080, cost: { total: 0.002 } }, 3000),
      result('bash', 'out3', 3500),
      assistant([{ type: 'text', text: '第三次回答' }],
        { input: 1500, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 1510, cost: { total: 0.003 } }, 4000),
    ]);
    const page = readTranscript(f.config, 20, 0, 100);
    expect(page.steps.map(step => step.kind)).toEqual(['input', 'thinking', 'tool', 'text', 'result', 'result', 'text', 'result', 'text']);
    // 首个请求之前的 input 步没有可比对的上下文
    expect(page.steps[0].tokens).toBeUndefined();
    // 同一条 assistant 消息拆出的每一步共享同一组精确用量，只有第一个带 first
    const exactTurn = { input: 100, output: 20, cache_read: 200, cache_write: 5, reasoning: 7, total: 325, cost: 0.001, exact: true, turn: true };
    expect(page.steps[1].tokens).toEqual({ ...exactTurn, first: true });
    expect(page.steps[2].tokens).toEqual(exactTurn);
    expect(page.steps[3].tokens).toEqual(exactTurn);
    // 两次请求之间的两个 toolResult 属于同一批次：N = (1000+50) - 325 = 725，first 只在批首
    expect(page.steps[4].tokens).toEqual({ context_added: 725, estimated: true, batch: true, first: true });
    expect(page.steps[5].tokens).toEqual({ context_added: 725, estimated: true, batch: true });
    expect(page.steps[6].tokens).toEqual({
      input: 1000, output: 30, cache_read: 50, cache_write: 0, reasoning: 3, total: 1080, cost: 0.002, exact: true, turn: true, first: true,
    });
    // 批量=1 的批次同样得到估算，且 first 在自己这一批
    expect(page.steps[7].tokens).toEqual({ context_added: 420, estimated: true, batch: true, first: true });
    expect(page.steps[8].tokens).toEqual({
      input: 1500, output: 10, cache_read: 0, cache_write: 0, reasoning: 0, total: 1510, cost: 0.003, exact: true, turn: true, first: true,
    });
  } finally { f.close(); }
});

test('transcript leaves steps without a comparison point untokenised', () => {
  const f = fixture();
  try {
    const billed = { input: 600, output: 100, cacheRead: 300, cacheWrite: 0, reasoning: 4, totalTokens: 1000, cost: { total: 0.001 } };
    sessionFile(f.root, 21, [
      message('user', [{ type: 'text', text: '任务上下文' }], 1000),
      assistant([{ type: 'text', text: 'a' }], billed, 2000),
      result('bash', 'file A 末尾没有下一次请求', 2500),
    ], '2026-01-01T00-00-00-000Z_lush-task-21.jsonl');
    sessionFile(f.root, 21, [
      message('user', [{ type: 'text', text: '第二轮上下文' }], 3000),
      assistant([{ type: 'text', text: 'b' }], billed, 4000),
      { type: 'compaction', timestamp: 4100, summary: 'compacted' },
      result('bash', '压缩之后上下文反而更小', 4200),
      assistant([{ type: 'text', text: 'c' }],
        { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 110, cost: { total: 0 } }, 5000),
    ], '2026-02-01T00-00-00-000Z_lush-task-21.jsonl');
    const page = readTranscript(f.config, 21, 0, 100);
    expect(page.steps.map(step => step.kind)).toEqual(['input', 'text', 'result', 'input', 'text', 'meta', 'result', 'text']);
    expect(page.steps[0].tokens).toBeUndefined();   // 首个请求之前
    expect(page.steps[1].tokens).toMatchObject({ exact: true, turn: true, first: true });
    expect(page.steps[2].tokens).toBeUndefined();   // 文件 A 末尾，本文件没有下一次请求，也不跨文件推算
    expect(page.steps[3].tokens).toBeUndefined();   // 文件边界重置「上一次请求」
    expect(page.steps[4].tokens).toMatchObject({ exact: true, turn: true, first: true });
    expect(page.steps[5].tokens).toBeUndefined();   // compaction 让下一次上下文变小（100 - 1000 ≤ 0）
    expect(page.steps[6].tokens).toBeUndefined();
    expect(page.steps[7].tokens).toMatchObject({ exact: true, turn: true, first: true });
  } finally { f.close(); }
});

test('transcript resolves the window-end batch with the next request past the page', () => {
  const f = fixture();
  try {
    sessionFile(f.root, 22, [
      assistant([{ type: 'text', text: 'a' }],
        { input: 400, output: 50, cacheRead: 100, cacheWrite: 0, reasoning: 1, totalTokens: 550, cost: { total: 0.0001 } }, 1000),
      result('bash', 'r1', 2000),
      result('bash', 'r2', 2100),
      assistant([{ type: 'text', text: 'b' }],
        { input: 900, output: 40, cacheRead: 100, cacheWrite: 0, reasoning: 1, totalTokens: 1040, cost: { total: 0.0002 } }, 3000),
    ]);
    const first = readTranscript(f.config, 22, 0, 2);
    expect(first.steps.map(step => step.seq)).toEqual([1, 2]);
    expect(first.has_more).toBe(true);
    // 窗口末尾的批次用窗口之后读到的下一次请求补 N = (900+100) - 550 = 450
    expect(first.steps[1].tokens).toEqual({ context_added: 450, estimated: true, batch: true, first: true });
    // 续读时同一组不再重复 first（前端据此不重复印 chip）
    const second = readTranscript(f.config, 22, first.next, 100);
    expect(second.steps.map(step => step.seq)).toEqual([3, 4]);
    expect(second.steps[0].tokens).toEqual({ context_added: 450, estimated: true, batch: true });
    expect(second.steps[1].tokens).toMatchObject({ exact: true, turn: true, first: true, total: 1040 });
  } finally { f.close(); }
});

test('usage previews the last step with exact tokens when it is a billed assistant step', () => {
  const f = fixture();
  try {
    sessionFile(f.root, 23, [
      message('user', [{ type: 'text', text: 'go' }], 1000),
      assistant([{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'done' }],
        { input: 300, output: 40, cacheRead: 60, cacheWrite: 0, reasoning: 9, totalTokens: 400, cost: { total: 0.0005 } }, 2000),
    ]);
    expect(readUsage(f.config, 23).last).toEqual({
      at: new Date(2000).toISOString(), kind: 'text', title: '回答', body: 'done',
      tokens: { input: 300, output: 40, cache_read: 60, cache_write: 0, reasoning: 9, total: 400, cost: 0.0005, exact: true, turn: true },
    });
    // 最后一步正好是这条消息的第一个 step 时才带 first（与 transcript 同形）
    sessionFile(f.root, 24, [
      assistant([{ type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }],
        { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 12, cost: { total: 0 } }, 3000),
    ]);
    expect(readUsage(f.config, 24).last.tokens).toEqual({
      input: 10, output: 2, cache_read: 0, cache_write: 0, reasoning: 0, total: 12, cost: 0, exact: true, turn: true, first: true,
    });
  } finally { f.close(); }
});

test('chunked JSONL reads enforce the UTF-8 byte budget for one huge file', () => {
  const f = fixture();
  try {
    const file = sessionFile(f.root, 31, []);
    fs.writeFileSync(file, Buffer.alloc(9 * 1024 * 1024, 0x78));
    const page = readTranscript(f.config, 31, 0, 100);
    const stats = transcriptReadStats(f.config, 31);
    expect(page.steps).toEqual([]); expect(page.truncated).toBe(true);
    expect(stats.bytes).toBe(stats.max_bytes); expect(stats.bytes).toBeLessThan(fs.statSync(file).size);
  } finally { f.close(); }
});

test('incremental JSONL cache preserves half lines and UTF-8 across append and truncate', () => {
  const f = fixture();
  try {
    const file = sessionFile(f.root, 32, []);
    const encoded = Buffer.from(`${JSON.stringify(message('assistant', [{ type: 'text', text: '前🙂后' }]))}\n`);
    const emoji = encoded.indexOf(Buffer.from('🙂'));
    fs.writeFileSync(file, encoded.subarray(0, emoji + 2));
    expect(readTranscript(f.config, 32, 0, 100).steps).toEqual([]);
    fs.appendFileSync(file, encoded.subarray(emoji + 2));
    const appended = readTranscript(f.config, 32, 0, 100);
    expect(appended.steps.map(step => step.body)).toEqual(['前🙂后']);
    const appendedBytes = transcriptReadStats(f.config, 32).bytes;
    expect(appendedBytes).toBeGreaterThanOrEqual(encoded.length - (emoji + 2));
    expect(appendedBytes).toBeLessThanOrEqual(encoded.length - (emoji + 2) + 2 * 4096);

    const replacement = `${JSON.stringify(message('assistant', [{ type: 'text', text: '截断后' }]))}\n`;
    fs.writeFileSync(file, replacement);
    const truncated = readTranscript(f.config, 32, 0, 100);
    expect(truncated.steps.map(step => step.body)).toEqual(['截断后']);
    // A fresh task/file with identical bytes projects identically to the incrementally refreshed cache.
    sessionFile(f.root, 33, [message('assistant', [{ type: 'text', text: '截断后' }])]);
    expect(readTranscript(f.config, 33, 0, 100).steps.map(({ file: _file, ...step }) => step))
      .toEqual(truncated.steps.map(({ file: _file, ...step }) => step));
  } finally { f.close(); }
});

test('same-path truncate and fast regrow invalidates transcript and usage caches', () => {
  const f = fixture();
  try {
    const old = billing('旧记录🙂', { input: 5, output: 2, totalTokens: 7, cost: { total: 0 } }, 1000);
    const tail = Buffer.from(`${JSON.stringify(message('assistant', [{ type: 'text', text: '尾半行🙂' }], 1500))}\n`);
    const split = tail.indexOf(Buffer.from('🙂')) + 2;
    const file = sessionFile(f.root, 35, [old]);
    fs.appendFileSync(file, tail.subarray(0, split));
    expect(readTranscript(f.config, 35, 0, 100).steps.map(step => step.body)).toEqual(['旧记录🙂']);
    fs.appendFileSync(file, tail.subarray(split));
    expect(readTranscript(f.config, 35, 0, 100).steps.map(step => step.body)).toEqual(['旧记录🙂', '尾半行🙂']);
    expect(readUsage(f.config, 35).totals.tokens).toBe(7);
    expect(readUsage(f.config, 35).totals.tokens).toBe(7);
    expect(transcriptReadStats(f.config, 35).bytes).toBe(0);

    const replacement = [
      billing('新记录甲🙂', { input: 20, output: 3, totalTokens: 23, cost: { total: 0 } }, 2000),
      billing(`新记录乙${'长'.repeat(200)}`, { input: 30, output: 4, totalTokens: 34, cost: { total: 0 } }, 3000),
    ];
    const replacementBytes = Buffer.from(replacement.map(JSON.stringify).join('\n') + '\n');
    expect(replacementBytes.length).toBeGreaterThan(fs.statSync(file).size);
    fs.writeFileSync(file, replacementBytes); // truncate and regrow past the cached offset between polls
    const refreshed = readTranscript(f.config, 35, 0, 100);
    expect(refreshed.steps.map(step => step.body)).toEqual(['新记录甲🙂', `新记录乙${'长'.repeat(200)}`]);
    expect(refreshed.steps.some(step => step.body.includes('旧记录'))).toBe(false);
    expect(transcriptReadStats(f.config, 35).budget_bytes).toBe(replacementBytes.length);
    expect(readUsage(f.config, 35).totals.tokens).toBe(57);
    // Transcript already reparsed the replacement; usage aggregation consumes cached records without disk I/O.
    expect(transcriptReadStats(f.config, 35).bytes).toBe(0);
  } finally { f.close(); }
});

test('usage polling reuses the parsed aggregate when session files are unchanged', () => {
  const f = fixture();
  try {
    sessionFile(f.root, 34, [billing('cached', { input: 5, output: 2, totalTokens: 7, cost: { total: 0 } }, 1000)]);
    expect(readUsage(f.config, 34).totals.tokens).toBe(7);
    expect(transcriptReadStats(f.config, 34).bytes).toBeGreaterThan(0);
    expect(readUsage(f.config, 34).totals.tokens).toBe(7);
    expect(transcriptReadStats(f.config, 34).bytes).toBe(0);
  } finally { f.close(); }
});

test('transcript clips huge steps, merges every session file and validates input', () => {
  const f = fixture();
  try {
    sessionFile(f.root, 3, [message('assistant', [{ type: 'text', text: 'later' }])], '2026-02-01T00-00-00-000Z_lush-task-3.jsonl');
    sessionFile(f.root, 3, [message('toolResult', [{ type: 'text', text: 'x'.repeat(9000) }])], '2026-01-01T00-00-00-000Z_lush-task-3.jsonl');
    const page = readTranscript(f.config, 3, 0, 100);
    expect(page.files.map(name => name.slice(0, 10))).toEqual(['2026-01-01', '2026-02-01']); // 旧文件在前
    expect(page.steps[0].body).toContain('已截断');
    expect(page.steps[0].body.length).toBeLessThan(4200);
    expect(page.steps.at(-1).body).toBe('later');
    // task-3 的前缀不能匹配到 task-30 的会话
    sessionFile(f.root, 30, [message('assistant', [{ type: 'text', text: 'other' }])]);
    expect(sessionFiles(f.config, 3).length).toBe(2);
    expect(() => readTranscript(f.config, 3, -1, 10)).toThrow(LushError);
    expect(() => readTranscript(f.config, 3, 0, 0)).toThrow('limit');
    expect(() => readTranscript(f.config, 3, 0, 201)).toThrow('limit');
    // 没有 sessions 目录、没有会话文件都不算错误
    expect(readTranscript(f.config, 99, 0, 10)).toEqual({
      task_id: 99, files: [], steps: [], next: 0, has_more: false, truncated: false,
    });
  } finally { f.close(); }
});
