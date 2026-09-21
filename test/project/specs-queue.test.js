import { test, expect } from 'bun:test';
import { fixture, repo, until, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once:true });
    return done.promise;
  } };
}

test('planner writes a structured Plan and users can only inspect it', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  try {
    const planner = (await f.project.submit('plan')).task;
    await until(() => f.project.running.has(planner.id));
    const token = f.project.running.get(planner.id).token;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    expect(await rpc.dispatch('spec.list')).toEqual([]);
    await expect(rpc.dispatch('spec.add', { goal: 'nope', role: 'worker' })).rejects.toThrow('planner/agent only');
    const first = await rpc.dispatch('spec.add', { goal: '调研 A', role: 'research', name: 'research-a', _token: token });
    const second = await rpc.dispatch('spec.add', { goal: '实现 B', role: 'worker', name: 'implement-b', deps: [{ spec: first.id, kind: 'order' }], _token: token });
    expect(first).toMatchObject({ planner_task_id: planner.id, seq: 1, status: 'pending' });
    expect(second.deps).toEqual([{ spec: first.id, kind: 'order' }]);
    expect(f.project.status().specs).toMatchObject({ pending: 2, compiler: 'deterministic', batches: [] });
    provider.calls[0].done.resolve('done');
  } finally { await f.close(); }
});

test('runtime compiles one complete planner round directly into a Work DAG', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '4' }); await repo(f.root);
  try {
    const planner = (await f.project.submit('plan')).task;
    const upstream = f.project.addSpec(planner.id, { goal: '上游', role: 'research', name: 'upstream-research' });
    await until(() => !f.project.scheduled);
    const downstream = f.project.addSpec(planner.id, { goal: '下游', role: 'research', name: 'downstream-research', deps: [{ spec: upstream.id, kind: 'order' }] });
    expect(f.store.spec(upstream.id).status).toBe('pending');
    provider.calls.find(call => call.task.id === planner.id).done.resolve('planned');
    await until(() => f.store.spec(downstream.id).status === 'planned');
    const first = f.store.task(f.store.spec(upstream.id).task_id);
    const second = f.store.task(f.store.spec(downstream.id).task_id);
    expect(first.parent_id).toBeNull();
    expect(second.parent_id).toBeNull();
    expect(f.project.inspect(second.id).deps).toEqual([
      { id: first.id, kind: 'order', role: 'research', status: first.status, integration: 'none', goal: '上游' },
    ]);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n).toBe(0);
    expect(f.store.history(planner.id).some(event => event.type === 'plan.compiled')).toBe(true);
  } finally { await f.close(); }
});

test('finished plans from different intents compile independently while earlier work is still running', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '4', LUSH_CONTROL_CONCURRENCY: '2' }); await repo(f.root);
  try {
    const first = (await f.project.submit('first')).task;
    const second = (await f.project.submit('second')).task;
    const a = f.project.addSpec(first.id, { goal: 'a', role: 'research' });
    const b = f.project.addSpec(second.id, { goal: 'b', role: 'research' });
    await until(() => provider.calls.some(call => call.task.id === first.id) && provider.calls.some(call => call.task.id === second.id));
    provider.calls.find(call => call.task.id === first.id).done.resolve('a plan');
    await until(() => f.store.spec(a.id).status === 'planned');
    // Work A is deliberately still running; Plan B must not wait for it.
    await until(() => provider.calls.some(call => call.task.id === f.store.spec(a.id).task_id));
    provider.calls.find(call => call.task.id === second.id).done.resolve('b plan');
    await until(() => f.store.spec(b.id).status === 'planned');
    expect(f.store.task(f.store.spec(b.id).task_id).role).toBe('research');
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n).toBe(0);
  } finally { await f.close(); }
});

test('a planner awaiting a user answer still compiles the complete work already written', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  try {
    const planner = (await f.project.submit('plan')).task;
    const spec = f.project.addSpec(planner.id, { goal: '清楚的部分', role: 'research' });
    f.project.notice(planner.id, '另一个点不清楚', '请决定');
    await until(() => provider.calls.some(call => call.task.id === planner.id));
    provider.calls.find(call => call.task.id === planner.id).done.resolve('partial plan');
    await until(() => f.store.task(planner.id).status === 'awaiting');
    await until(() => f.store.spec(spec.id).status === 'planned');
    expect(f.store.spec(spec.id).task_id).toBeGreaterThan(0);
  } finally { await f.close(); }
});

test('invalid or dropped Plan dependencies never produce runnable work', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const planner = (await f.project.submit('plan')).task;
    const dep = f.project.addSpec(planner.id, { goal: '依赖', role: 'research' });
    const consumer = f.project.addSpec(planner.id, { goal: '消费者', role: 'research', deps: [{ spec: dep.id, kind: 'order' }] });
    f.project.dropSpec(dep.id, '不需要了', planner.id);
    f.store.update(planner.id, { status: 'completed' });
    f.project.stopping = false;
    f.project.compilePlans();
    expect(f.store.spec(consumer.id)).toMatchObject({ status: 'dropped' });
    expect(f.store.spec(consumer.id).task_id).toBeNull();
  } finally { await f.close(); }
});
