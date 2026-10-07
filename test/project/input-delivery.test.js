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

test('failure after delivery preserves first delivery time on retry; failure before acknowledgement stays pending', async () => {
  let failBefore = true;
  const f = fixture({ reportsInputDelivery: true, async run(ctx) {
    if (failBefore) throw new Error('preparation failed');
    ctx.onInputDelivered(); throw new Error('backend failed after receiving input');
  } }); await repo(f.root);
  try {
    const task = (await f.project.order('retry')).task; f.project.message(task.id, 'keep');
    await until(() => f.store.task(task.id).status === 'failed');
    expect(f.project.inspect(task.id).goal_input_delivery.status).toBe('pending');
    expect(followups(f, task.id)[0].input_delivery.status).toBe('pending');
    failBefore = false; f.project.retry(task.id);
    await until(() => f.store.task(task.id).status === 'failed');
    const delivered = followups(f, task.id)[0].input_delivery;
    expect(delivered.status).toBe('delivered'); expect(f.store.unread(task.id)).toHaveLength(1);
    f.project.retry(task.id); await until(() => f.store.task(task.id).status === 'failed');
    // Clock rollback on retry must not replace the first receipt with a lower wall-clock value.
    const latestReceipt = f.store.get("SELECT id FROM events WHERE task_id=? AND type='invocation.inputs_delivered' ORDER BY id DESC LIMIT 1", task.id);
    f.store.run('UPDATE events SET created_at=? WHERE id=?', '2000-01-01T00:00:00Z', latestReceipt.id);
    expect(followups(f, task.id)[0].input_delivery).toEqual(delivered);
  } finally { await f.close(); }
});

test('legacy input without delivery evidence is unknown rather than a fabricated timestamp or pending', async () => {
  const f = fixture({ async run() { return 'unused'; } });
  try {
    const task = f.store.create({ role: 'agent', goal: 'legacy' });
    const messageId = f.store.message(task.id, 'old');
    f.store.event(task.id, 'message', { message_id: messageId, sender: null, body: 'old' });
    f.store.event(task.id, 'invocation.started', { message_ids: [messageId] });
    expect(f.project.inspect(task.id).goal_input_delivery).toEqual({ status: 'unknown', at: null });
    expect(followups(f, task.id)[0].input_delivery).toEqual({ status: 'unknown', at: null });
    expect(f.store.history(task.id).find(e => e.type === 'message').input_delivery.status).toBe('unknown');
    f.store.event(task.id, 'message', { sender: null, body: 'legacy without identity' });
    expect(followups(f, task.id).at(-1).input_delivery.status).toBe('unknown');
    f.store.event(task.id, 'invocation.inputs_delivered', { message_ids: [messageId] });
    expect(f.project.inspect(task.id).goal_input_delivery.status).toBe('unknown');
    expect(followups(f, task.id)[0].input_delivery.status).toBe('unknown');
  } finally { await f.close(); }
});
