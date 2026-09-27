import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { readTranscript, readUsage } from '../src/core/transcript.js';
import { liveTarget, liveTick } from '../src/ui/web/assets/live.js';

const message = (role, text, timestamp) => ({ type: 'message', timestamp, message: { role, content: [{ type: 'text', text }] } });

function sessionPath(root, taskId) {
  const dir = path.join(root, '.lush', 'sessions');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `2026-01-01T00-00-00-000Z_lush-task-${taskId}.jsonl`);
}
function writeSession(root, taskId, lines) {
  fs.writeFileSync(sessionPath(root, taskId), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
}
function appendSession(root, taskId, lines) {
  fs.appendFileSync(sessionPath(root, taskId), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
}

test('只有展示中的热任务才会被实时刷新', () => {
  const tasks = [
    { id: 1, status: 'running' }, { id: 2, status: 'completed' },
    { id: 3, status: 'awaiting' }, { id: 4, status: 'queued' }, { id: 5, status: 'failed' },
  ];
  expect(liveTarget(tasks, 1).status).toBe('running');
  expect(liveTarget(tasks, 3).status).toBe('awaiting');
  expect(liveTarget(tasks, 4).status).toBe('queued');
  expect(liveTarget(tasks, 2)).toBeNull();     // 已终态：`updated_at` 变的时候主 refresh 会重画一次
  expect(liveTarget(tasks, 5)).toBeNull();
  expect(liveTarget(tasks, 99)).toBeNull();    // 不在列表里
  expect(liveTarget(tasks, null)).toBeNull();
});

test('一个 tick 刷 usage 且只对已加载的 transcript 增量续读', async () => {
  const calls = { usage: [], transcript: [] };
  const pages = [
    { steps: [{ seq: 3, kind: 'tool', title: 'bash' }], next: 3, has_more: false },
    { steps: [{ seq: 4, kind: 'text', title: '回答' }], next: 4, has_more: true },
  ];
  const publish = { usage: [], steps: [] };
  const transcript = { steps: [{ seq: 1 }], next: 1 };
  const options = {
    task: { id: 7, status: 'running' }, transcript,
    fetchUsage: async id => { calls.usage.push(id); return { last: { at: '2026-01-01T00:00:03.000Z', kind: 'tool', title: 'bash', body: 'ls' } }; },
    fetchTranscript: async (id, after) => { calls.transcript.push(after); return pages.shift(); },
    publish: { usage: (id, usage) => publish.usage.push([id, usage.last.kind]), steps: (id, steps) => publish.steps.push(steps.map(step => step.seq)) },
  };
  const first = await liveTick(options);
  expect(first.usage.last.kind).toBe('tool');
  expect(first.steps.map(step => step.seq)).toEqual([3]);
  // 游标推进到刚读到的那一步：下一个 tick 用 after=3 续读，而不是从头再读一遍
  expect(transcript).toMatchObject({ next: 3, has_more: false });
  const second = await liveTick(options);
  expect(second.steps.map(step => step.seq)).toEqual([4]);
  expect(calls.transcript).toEqual([1, 3]);
  expect(transcript.steps.map(step => step.seq)).toEqual([1, 3, 4]);
  expect(calls.usage).toEqual([7, 7]);
  expect(publish.steps).toEqual([[3], [4]]);
});

test('尚未加载执行过程时不读 transcript，只刷 usage', async () => {
  let transcriptCalls = 0;
  const updated = await liveTick({
    task: { id: 2, status: 'running' }, transcript: null,
    fetchUsage: async () => null, fetchTranscript: async () => { transcriptCalls += 1; return { steps: [] }; },
  });
  expect(transcriptCalls).toBe(0);
  expect(updated).toEqual({ usage: null, steps: [] });
});

test('manual pagination winning a race does not duplicate the live page', async () => {
  const transcript = { steps: [{ seq: 1 }], next: 1 };
  let finish, started;
  const requested = new Promise(resolve => { started = resolve; });
  const pending = liveTick({ task: { id: 2 }, transcript, fetchUsage: async () => null,
    fetchTranscript: () => { started(); return new Promise(resolve => { finish = resolve; }); } });
  await requested;
  transcript.steps.push({ seq: 2 }); transcript.next = 2;
  finish({ steps: [{ seq: 2 }], next: 2 });
  expect((await pending).steps).toEqual([]);
  expect(transcript.steps.map(step => step.seq)).toEqual([1, 2]);
});

/**
 * 这是「页面会自己变新」的数据路径实测：会话文件一边增长，轮询一边就能拿到新的步骤与新的
 * 「最近一次执行」时间，且走的是增量游标。等价于浏览器里 liveRefresh 每个 tick 干的两次请求
 * （usage 与 transcript?after=next），只是把 HTTP 换成直接调用同一套读取函数。
 */
test('会话文件增长时，连续 tick 能让步骤与最近一次执行一直变新', async () => {
  const f = fixture();
  try {
    writeSession(f.root, 8, [
      message('user', '任务上下文', '2026-01-01T00:00:01.000Z'),
      message('assistant', '先看看目录', '2026-01-01T00:00:02.000Z'),
    ]);
    const cache = { steps: [], next: 0 };
    const seen = { after: [], last: [] };
    const tick = () => liveTick({
      task: { id: 8, status: 'running' }, transcript: cache,
      fetchUsage: async () => readUsage(f.config, 8),
      fetchTranscript: async (_id, after) => { seen.after.push(after); return readTranscript(f.config, 8, after, 100); },
    });

    await tick();
    expect(cache.steps.map(step => step.kind)).toEqual(['input', 'text']);
    expect(cache.next).toBe(2);
    seen.last.push(readUsage(f.config, 8).last);

    // agent 继续干活：会话文件追加两步（工具调用 + 工具输出）。
    appendSession(f.root, 8, [
      message('assistant', '跑一下测试', '2026-01-01T00:00:05.000Z'),
      message('toolResult', '全部通过', '2026-01-01T00:00:06.000Z'),
    ]);
    const second = await tick();
    expect(second.steps.map(step => step.kind)).toEqual(['text', 'result']);
    expect(cache.steps.length).toBe(4);
    expect(cache.next).toBe(4);
    seen.last.push(readUsage(f.config, 8).last);

    // 第三个 tick 没有新记录：不重复追加，游标也不乱走。
    const third = await tick();
    expect(third.steps).toEqual([]);
    expect(cache.steps.length).toBe(4);
    expect(seen.after).toEqual([0, 2, 4]);
    expect(seen.last.map(last => last.body)).toEqual(['先看看目录', '全部通过']);
  } finally { f.close(); }
});
