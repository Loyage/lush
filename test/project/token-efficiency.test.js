import { test, expect } from 'bun:test';
import { fixture, gate, repo, until, git } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once: true });
    return done.promise;
  } };
}

test('context contains only causal neighbours and bounded summaries, not project history', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const parent = f.store.create({ role: 'coordinator', goal: 'parent', input_id: null });
    const task = f.store.create({ role: 'worker', goal: 'work', parent_id: parent.id, input_id: null });
    const upstream = f.store.create({ role: 'worker', goal: 'upstream', input_id: null });
    const foreign = f.store.create({ role: 'worker', goal: 'unrelated-secret', input_id: null });
    f.store.addDep(task.id, upstream.id, 'code');
    f.store.update(upstream.id, { result: 'x'.repeat(5000) });
    for (let i = 0; i < 52; i++) f.store.create({ role: 'research', goal: 'child', parent_id: task.id, input_id: null });
    const context = await f.project.invocationContext(task, { recordId: 7 });
    expect(context.parent.id).toBe(parent.id);
    expect(context.dependencies[0]).toMatchObject({ id: upstream.id, kind: 'code', truncated: true });
    expect(context.dependencies[0].result).toHaveLength(1500);
    expect(context.children).toHaveLength(50); expect(context.children_truncated).toBe(true);
    expect(context.recent_tasks).toBeUndefined(); expect(JSON.stringify(context)).not.toContain(foreign.goal);
    expect(context.invocation).toEqual({ task_id: task.id, run_id: 7, role: 'worker' });
  } finally { await f.close(); }
});

test('direct submit preserves input lineage and references but never invokes a planner; RPC remains user-only', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  try {
    const rpc = new Dispatcher(f.project, createSignal(), {});
    const before = await git(f.root, 'rev-parse', 'main');
    f.project.draft('leave this for later planning');
    const references = [{ version: 1, kind: 'text', target: {}, label: 'evidence', quote: 'user-selected evidence',
      location: { view: 'overview' }, captured_at: '2026-01-01T00:00:00.000Z' }];
    const result = await rpc.dispatch('input.submit', { content: 'change exactly one thing', direct: true, references });
    expect(result.task).toMatchObject({ role: 'planner', status: 'completed', calls: 0, agent_wakes: 0 });
    expect(result.worker).toMatchObject({ role: 'worker', input_id: result.id, parent_id: null });
    expect(f.project.inputs()[0]).toMatchObject({ flow: 'develop', direct: 1, specs_planned: 1 });
    expect(f.project.drafts()).toHaveLength(1);
    await until(() => provider.calls.length === 1);
    expect(provider.calls[0].task.role).toBe('worker');
    expect(f.store.task(result.worker.id).target_branch).toBe(result.anchor.branch);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(before);
    const token = f.project.running.get(result.worker.id).token;
    await expect(rpc.dispatch('input.submit', { _token: token, content: 'cannot bypass', direct: true })).rejects.toThrow('requires user approval');
    await expect(rpc.dispatch('input.submit', { content: 'invalid', direct: 'yes' })).rejects.toThrow('boolean');
    expect(provider.calls[0].context.referenced_context[0].reference.quote).toBe('user-selected evidence');
    expect(provider.calls[0].context.invocation.task_id).toBe(result.worker.id);
  } finally { await f.close(); }
});

test('ordinary successful children wake a coordinator once, after the whole wave', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const parent = f.store.create({ role: 'coordinator', goal: 'wave', input_id: null }); f.project.kick();
    await until(() => provider.calls.length === 1);
    const a = f.project.spawn(parent.id, 'a', 'research'), b = f.project.spawn(parent.id, 'b', 'research');
    provider.calls[0].done.resolve('delegated');
    await until(() => provider.calls.length === 3 && f.store.task(parent.id).status === 'waiting');
    provider.calls.find(call => call.task.id === a.id).done.resolve('x'.repeat(5000));
    await until(() => f.store.task(a.id).status === 'completed' && !f.project.running.has(a.id));
    expect(f.project.hasActionableMessages(parent.id)).toBe(false);
    f.project.wake(parent.id);
    await Bun.sleep(20);
    expect(provider.calls.filter(call => call.task.id === parent.id)).toHaveLength(1);
    expect(f.store.task(parent.id).status).toBe('waiting');
    expect(f.store.unread(parent.id)).toHaveLength(1);
    expect(JSON.parse(f.store.unread(parent.id)[0].body).result_truncated).toBe(true);
    provider.calls.find(call => call.task.id === b.id).done.resolve('b done');
    await until(() => provider.calls.filter(call => call.task.id === parent.id).length === 2);
    const final = provider.calls.filter(call => call.task.id === parent.id)[1];
    expect(final.messages).toHaveLength(2); final.done.resolve('wave summary');
    await until(() => f.store.task(parent.id).status === 'completed');
    expect(f.store.unread(parent.id)).toHaveLength(0);
  } finally { await f.close(); }
});

test('coalescing survives parent cleanup races and explicit messages interrupt the wait', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const parent = f.store.create({ role: 'coordinator', goal: 'wave', input_id: null }); f.project.kick();
    await until(() => provider.calls.length === 1);
    const a = f.project.spawn(parent.id, 'a', 'research'), b = f.project.spawn(parent.id, 'b', 'research');
    await until(() => provider.calls.length === 3);
    provider.calls.find(call => call.task.id === a.id).done.resolve('a done');
    await until(() => f.store.task(a.id).status === 'completed');
    provider.calls[0].done.resolve('parent parks after first receipt');
    await until(() => !f.project.running.has(parent.id));
    expect(provider.calls.filter(call => call.task.id === parent.id)).toHaveLength(1);
    expect(f.store.task(parent.id).status).toBe('waiting');
    f.project.message(parent.id, 'explicit update');
    await until(() => provider.calls.filter(call => call.task.id === parent.id).length === 2);
    const second = provider.calls.filter(call => call.task.id === parent.id)[1];
    expect(second.messages.map(m => m.body)).toContain('explicit update');
    second.done.resolve('handled update');
    await until(() => f.store.task(parent.id).status === 'waiting' && !f.project.running.has(parent.id));
    provider.calls.find(call => call.task.id === b.id).done.resolve('b done');
    await until(() => provider.calls.filter(call => call.task.id === parent.id).length === 3);
    const last = provider.calls.filter(call => call.task.id === parent.id)[2];
    expect(last.messages).toHaveLength(1);
    last.done.resolve('summary');
    await until(() => f.store.task(parent.id).status === 'completed');
    expect(f.store.unread(parent.id)).toHaveLength(0);
  } finally { await f.close(); }
});

test('failure receipts and explicit child messages are actionable while peers remain active', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const parent = f.store.create({ role: 'coordinator', goal: 'wave', input_id: null });
    const a = f.project.spawn(parent.id, 'a', 'research'); f.project.spawn(parent.id, 'b', 'research');
    f.project.finish(a.id, 'failed', null, 'failed');
    expect(f.project.hasActionableMessages(parent.id)).toBe(true);
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', parent.id);
    f.project.message(parent.id, '{"child":1,"status":"completed"}', a.id);
    expect(f.project.hasActionableMessages(parent.id)).toBe(true);
  } finally { await f.close(); }
});

test('recovery keeps deferred success unread but wakes when no active child remains', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const parent = f.store.create({ role: 'coordinator', goal: 'recover wave', input_id: null });
    const a = f.project.spawn(parent.id, 'a', 'research'), b = f.project.spawn(parent.id, 'b', 'research');
    f.store.update(parent.id, { status: 'waiting' });
    f.project.finish(a.id, 'completed', 'done');
    f.project.recover();
    expect(f.store.task(parent.id).status).toBe('waiting'); expect(f.store.unread(parent.id)).toHaveLength(1);
    // Emulate a crash after terminal state / receipt persisted but before parent wake.
    f.project.finish(b.id, 'completed', 'done'); f.store.update(parent.id, { status: 'waiting' });
    f.project.recover();
    expect(f.store.task(parent.id).status).toBe('queued'); expect(f.store.unread(parent.id)).toHaveLength(2);
  } finally { await f.close(); }
});

test('cancellation while resolving startup context cannot launch a provider with an aborted signal', async () => {
  const provider = controlled(), f = fixture(provider), ready = gate(); let entered = false;
  f.project.invocationContext = async () => { entered = true; await ready.promise; return {}; };
  try {
    const task = f.store.create({ role: 'research', goal: 'cancel during context', input_id: null }); f.project.kick();
    await until(() => entered);
    f.project.cancel(task.id); ready.resolve();
    await until(() => !f.project.running.has(task.id));
    expect(provider.calls).toHaveLength(0); expect(f.store.task(task.id).status).toBe('cancelled');
  } finally { ready.resolve(); await f.close(); }
});

test('direct materialization failure rolls back input, specs and tasks', async () => {
  const f = fixture(); await repo(f.root); f.project.stopping = true;
  f.project.materializeSpec = () => { throw new Error('controlled compile failure'); };
  try {
    await expect(f.project.submit('cannot materialize', undefined, [], true)).rejects.toThrow('controlled compile failure');
    expect(f.project.inputs()).toHaveLength(0); expect(f.store.tasks()).toHaveLength(0);
    expect(f.store.all('SELECT * FROM task_specs')).toHaveLength(0);
  } finally { await f.close(); }
});
