import { test, expect } from 'bun:test';
import { fixture, gate, until } from '../helpers.js';

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once: true });
    return done.promise;
  } };
}
const taskReference = task => ({ version: 1, kind: 'task', target: { task_id: task.id }, label: `任务 #${task.id}`,
  quote: task.goal, location: { view: 'task-tree', task_id: task.id }, captured_at: '2026-01-01T00:00:00.000Z' });
const textReference = quote => ({ version: 1, kind: 'text', target: {}, label: '所选文字', quote,
  location: { view: 'overview', section: 'result' }, captured_at: '2026-01-01T00:00:00.000Z' });

test('结构化引用随草稿持久化、按批量输入段落复制，并注入 planner 的快照与当前状态', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const target = f.store.create({ input_id: null, role: 'research', goal: '研究 Web UI' });
    f.store.update(target.id, { status: 'completed', result: '现有结论' });
    const first = f.project.draft('请解释这一项', [taskReference(target)]);
    const second = f.project.draft('再修改这段内容', [textReference('页面上的原始文字')]);
    expect(f.project.drafts().map(row => row.references.length)).toEqual([1, 1]);

    const committed = f.project.commitDrafts([first.id, second.id]);
    expect(committed.references.map(row => row.segment)).toEqual([1, 2]);
    expect(f.project.inputs()[0].references.map(row => row.segment)).toEqual([1, 2]);
    await until(() => provider.calls.some(call => call.task.id === committed.task.id));
    const call = provider.calls.find(entry => entry.task.id === committed.task.id);
    expect(call.context.referenced_context).toHaveLength(2);
    expect(call.context.referenced_context[0].reference.quote).toBe('研究 Web UI');
    expect(call.context.referenced_context[0].current.result).toBe('现有结论');
    expect(call.context.referenced_context[0].stale).toBe(false);
    expect(call.context.referenced_context[1].current).toBeNull();
    expect(call.context.referenced_context[1].stale).toBe(false);
  } finally { await f.close(); }
});

test('引用校验限制类型、目标、数量和快照大小；目标消失时保留快照并标记 stale', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    expect(() => f.project.draft('bad', [{ kind: 'task', target: {}, label: 'x', quote: 'x' }])).toThrow('requires task_id');
    expect(() => f.project.draft('bad', [{ kind: 'unknown', target: {}, label: 'x', quote: 'x' }])).toThrow('unsupported reference kind');
    expect(() => f.project.draft('bad', Array.from({ length: 13 }, () => textReference('x')))).toThrow('at most 12');
    expect(() => f.project.draft('bad', [textReference('x'.repeat(8193))])).toThrow('max 8192');

    const missing = { ...taskReference({ id: 999999, goal: '已经不存在的任务' }) };
    const result = f.project.submit('它现在怎么样？', [missing]);
    await until(() => provider.calls.some(call => call.task.id === result.task.id));
    const context = provider.calls.find(call => call.task.id === result.task.id).context.referenced_context[0];
    expect(context.reference.quote).toBe('已经不存在的任务');
    expect(context.current).toBeNull();
    expect(context.stale).toBe(true);

    const large = f.store.create({ input_id: null, role: 'research', goal: '很大的当前状态' });
    f.store.event(large.id, 'large.context', { body: 'x'.repeat(70000) });
    const eventId = f.store.get("SELECT max(id) AS id FROM events WHERE type='large.context'").id;
    const eventReference = { version: 1, kind: 'history_event', target: { event_id: eventId }, label: `事件 #${eventId}`,
      quote: '很大的事件', location: { view: 'task-detail', task_id: large.id }, captured_at: '2026-01-01T00:00:00.000Z' };
    const bounded = f.project.submit('概括它', [eventReference]);
    await until(() => provider.calls.some(call => call.task.id === bounded.task.id));
    const largeContext = provider.calls.find(call => call.task.id === bounded.task.id).context.referenced_context[0];
    expect(largeContext.truncated).toBe(true);
    expect(largeContext.current.truncated).toBe(true);
    expect(JSON.stringify(largeContext.current).length).toBeLessThan(66000);
  } finally { await f.close(); }
});
