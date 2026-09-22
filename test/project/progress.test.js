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

test('agent progress is bound to its live task and preserves completed stable keys across replans', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  try {
    const task = f.store.create({ role: 'coordinator', goal: 'coordinate progress', input_id: null });
    f.project.kick();
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
    expect(f.project.decorate(f.store.summaries('work'))[0].progress.items[0].status).toBe('completed');
    await expect(rpc.dispatch('progress.complete', { _token: token, step: 'missing' })).rejects.toThrow('not in the current plan');
    expect(f.store.history(task.id, 0).map(event => event.type)).toContain('progress.completed');
  } finally { await f.close(); }
});

test('progress plans reject duplicate or unstable keys', async () => {
  const f = fixture({ async run() { return 'done'; } });
  try {
    const task = f.store.create({ role: 'research', goal: 'validate', input_id: null });
    expect(() => f.project.reportProgressPlan(task.id, [{ key: 'Bad Key', label: 'x' }])).toThrow('must match');
    expect(() => f.project.reportProgressPlan(task.id, [{ key: 'test', label: 'one' }, { key: 'test', label: 'two' }])).toThrow('duplicate');
  } finally { await f.close(); }
});
