import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { readTranscript, readUsage, sessionFiles } from '../src/core/transcript.js';
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
