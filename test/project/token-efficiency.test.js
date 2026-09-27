import { test, expect } from 'bun:test';
import { fixture, gate, repo, until } from '../helpers.js';
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

test('input.submit is retired and rejects the whole method as unknown', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const rpc = new Dispatcher(f.project, createSignal(), {});
    await expect(rpc.dispatch('input.submit', { content: 'change exactly one thing', direct: true })).rejects.toThrow('unknown method');
    expect(f.project.inputs()).toHaveLength(0);
  } finally { await f.close(); }
});

test('cancellation while resolving startup context cannot launch a provider with an aborted signal', async () => {
  const provider = controlled(), f = fixture(provider), ready = gate(); let entered = false;
  f.project.invocationContext = async () => { entered = true; await ready.promise; return {}; };
  try {
    await repo(f.root);
    const task = (await f.project.say('cancel during context')).task;
    await until(() => entered);
    f.project.cancel(task.id); ready.resolve();
    await until(() => !f.project.running.has(task.id));
    expect(provider.calls).toHaveLength(0); expect(f.store.task(task.id).status).toBe('cancelled');
  } finally { ready.resolve(); await f.close(); }
});

test('a route materialization failure rolls back input, specs and tasks', async () => {
  const f = fixture(); await repo(f.root); f.project.stopping = true;
  f.project.materializeSpec = () => { throw new Error('controlled compile failure'); };
  try {
    await expect(f.project.submit('开发 cannot materialize')).rejects.toThrow('controlled compile failure');
    expect(f.project.inputs()).toHaveLength(0); expect(f.store.tasks()).toHaveLength(0);
    expect(f.store.all('SELECT * FROM task_specs')).toHaveLength(0);
  } finally { await f.close(); }
});
