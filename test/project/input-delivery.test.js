import { test, expect } from 'bun:test';
import { fixture, repo, until, gate } from '../helpers.js';

function controlled() {
  const calls = [];
  return { reportsInputDelivery: true, calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once: true });
    return done.promise;
  } };
}
const followups = (f, taskId, before = null) => f.store.historyPage(taskId, before).events.filter(e => e.type === 'message');

test('goal and follow-ups become delivered at backend handoff, not submission, start, consumption or completion', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  try {
    const task = (await f.project.order('original')).task;
    await until(() => provider.calls.length === 1);
    expect(f.project.inspect(task.id).goal_input_delivery).toEqual({ status: 'pending', at: null });
    provider.calls[0].onInputDelivered();
    const original = f.project.inspect(task.id).goal_input_delivery;
    expect(original).toEqual({ status: 'delivered', at: expect.any(String) });
    f.project.message(task.id, 'duplicate'); f.project.message(task.id, 'duplicate');
    const submitted = followups(f, task.id);
    expect(submitted.map(e => e.input_delivery)).toEqual([{ status: 'pending', at: null }, { status: 'pending', at: null }]);
    provider.calls[0].done.resolve('first');
    await until(() => provider.calls.length === 2);
    expect(f.store.unread(task.id)).toHaveLength(2);
    expect(followups(f, task.id).every(e => e.input_delivery.status === 'pending')).toBe(true);
    // Fix submission time far from delivery so an accidental created_at fallback cannot pass.
    for (const e of submitted) f.store.run('UPDATE events SET created_at=? WHERE id=?', '2000-01-01T00:00:00Z', e.id);
    provider.calls[1].onInputDelivered(); provider.calls[1].onInputDelivered();
    const receipt = f.store.get("SELECT * FROM events WHERE task_id=? AND type='invocation.inputs_delivered' ORDER BY id DESC LIMIT 1", task.id);
    expect(followups(f, task.id).map(e => e.input_delivery)).toEqual([
      { status: 'delivered', at: receipt.created_at }, { status: 'delivered', at: receipt.created_at }]);
    expect(f.store.historyPage(task.id).events.find(e => e.id === receipt.id).input_deliveries)
      .toEqual(submitted.map(e => ({ message_id: e.data.message_id, status: 'delivered', at: receipt.created_at })));
    expect(f.store.unread(task.id)).toHaveLength(2); // delivered is not consumed
    // The receipt can be outside a page containing the original event.
    for (let i = 0; i < 120; i++) f.store.event(task.id, 'test.noise', {});
    expect(followups(f, task.id, submitted.at(-1).id + 1).map(e => e.input_delivery.status)).toEqual(['delivered', 'delivered']);
    provider.calls[1].done.resolve('second');
    await until(() => f.store.task(task.id).status === 'waiting');
    expect(f.project.inspect(task.id).goal_input_delivery).toEqual(original);
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='invocation.inputs_delivered'", task.id)).toHaveLength(2);
  } finally { await f.close(); }
});
