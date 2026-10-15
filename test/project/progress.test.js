import { test, expect } from 'bun:test';
import { fixture, gate, repo, until } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';
import { projectProgress } from '../../src/core/project/progress.js';

const at = ms => new Date(ms).toISOString();
const SEC = 1000;

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    // Under parallel load shutdown can win while the invocation is still preparing its workspace.
    if (ctx.signal.aborted) done.resolve('aborted');
    else ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once: true });
    return done.promise;
  } };
}

test('agent progress is bound to its live task and preserves completed stable keys across replans', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  try {
    const task = (await f.project.order('coordinate progress')).task;
    await until(() => provider.calls.length === 1);
    const token = f.project.running.get(task.id).token;
    const rpc = new Dispatcher(f.project, createSignal(), {});

    await expect(rpc.dispatch('progress.plan', { steps: [{ key: 'inspect', label: '确认现状' }] })).rejects.toThrow('agent only');
    const planned = await rpc.dispatch('progress.plan', { _token: token, steps: [
      { key: 'inspect', label: '确认现状' }, { key: 'delegate', label: '派发子任务' }, { key: 'wait_son', label: '等待子任务' },
    ] });
    expect(planned).toMatchObject({ task_id: task.id, progress: { version: 1 } });
    expect(f.project.inspect(task.id).progress.items.map(item => [item.key, item.status])).toEqual([
      ['inspect', 'pending'], ['delegate', 'pending'], ['wait_son', 'pending'],
    ]);
    const initialTiming = f.project.inspect(task.id).progress.items;
    expect(initialTiming[0].started_at).toBeTruthy();
    expect(initialTiming[1].started_at).toBeNull();
    expect(f.project.inspect(task.id).progress_plan).toBeUndefined();

    const completed = await rpc.dispatch('progress.complete', { _token: token, step: 'inspect' });
    expect(completed.progress.items[0]).toMatchObject({ key: 'inspect', status: 'completed' });
    expect(completed.progress.items[0].completed_at).toBeTruthy();
    expect(completed.progress.items[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(completed.progress.items[1].started_at).toBe(completed.progress.items[0].completed_at);
    expect((await rpc.dispatch('progress.complete', { _token: token, step: 'inspect' })).unchanged).toBe(true);

    await rpc.dispatch('progress.plan', { _token: token, steps: [
      { key: 'inspect', label: '复核现状' }, { key: 'implement', label: '实现' }, { key: 'test', label: '测试' },
    ] });
    const fresh = f.project.inspect(task.id);
    expect(fresh.progress.items).toMatchObject([
      { key: 'inspect', label: '复核现状', status: 'completed', started_at: initialTiming[0].started_at,
        completed_at: completed.progress.items[0].completed_at, duration_ms: completed.progress.items[0].duration_ms },
      { key: 'implement', status: 'pending' }, { key: 'test', status: 'pending', started_at: null },
    ]);
    expect(f.project.decorate(f.store.summaries('work')).find(item => item.id === task.id).progress.items[0].status).toBe('completed');
    await expect(rpc.dispatch('progress.complete', { _token: token, step: 'missing' })).rejects.toThrow('not in the current plan');
    expect(f.store.history(task.id, 0).map(event => event.type)).toContain('progress.completed');
  } finally { await f.close(); }
});

test('out-of-order completion advances without inventing timing or completing missed steps; late reports do not rewind', async () => {
  const f = fixture();
  try {
    const task = f.store.create({ role: 'agent', goal: 'miss a completion', task_kind: 'order' });
    const steps = ['inspect', 'implement', 'test', 'commit'].map(key => ({ key, label: key }));
    const initial = f.project.reportProgressPlan(task.id, steps).progress;
    initial.items[0].started_at = at(0);
    f.store.setProgressPlan(task.id, initial);
    const result = f.project.completeProgressStep(task.id, 'implement').progress;
    expect(result.items[0]).toMatchObject({ status: 'pending', unconfirmed: true, timing_unknown: true, duration_ms: null });
    expect(result.items[1]).toMatchObject({ status: 'completed', timing_unknown: true, started_at: null, duration_ms: null });
    expect(result.items[2].started_at).toBe(result.items[1].completed_at);
    expect(result.items[3].started_at).toBeNull();
    // Idempotent repeats and replans must not resurrect the missed step's clock.
    expect(f.project.completeProgressStep(task.id, 'implement').unchanged).toBe(true);
    const replan = f.project.reportProgressPlan(task.id, steps).progress;
    expect(replan.items[0].unconfirmed).toBe(true);
    expect(replan.items[2].started_at).toBe(result.items[2].started_at);
    expect(f.project.inspect(task.id).progress.items[1].duration_ms).toBeNull();
    expect(f.project.decorate(f.store.summaries('work')).find(row => row.id === task.id).progress.items[0].unconfirmed).toBe(true);
    const late = f.project.completeProgressStep(task.id, 'inspect').progress;
    expect(late.items[0]).toMatchObject({ status: 'completed', timing_unknown: true, duration_ms: null });
    expect(late.items[0].unconfirmed).toBeUndefined();
    expect(late.items[2].started_at).toBe(result.items[2].started_at);
    const tested = f.project.completeProgressStep(task.id, 'test').progress;
    expect(tested.items[2].duration_ms).toBeGreaterThanOrEqual(0);
    expect(tested.items[3].started_at).toBe(tested.items[2].completed_at);
    const event = f.store.history(task.id, 0).find(row => row.type === 'progress.completed');
    expect(event.data).toMatchObject({ duration_ms: null, timing_unknown: true, unconfirmed: ['inspect'] });
  } finally { await f.close(); }
});
