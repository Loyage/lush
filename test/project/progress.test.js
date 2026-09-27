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

test('progress timing excludes waiting and surfaces it as a separate plan entry', () => {
  const progress = { version: 1, updated_at: at(0), items: [
    { key: 'inspect', label: '确认现状', status: 'completed', started_at: at(0), completed_at: at(10 * SEC), duration_ms: 10 * SEC },
    { key: 'implement', label: '实现', status: 'pending', started_at: at(10 * SEC), completed_at: null, duration_ms: null },
  ] };

  // 任务现在停在 waiting：最后一段 8s→15s 的调用空隙还开着，等待行就是要持续计时的当前步骤。
  const waiting = projectProgress(progress, [
    { started_at: at(0), ended_at: at(4 * SEC) },
    { started_at: at(6 * SEC), ended_at: at(8 * SEC) },
  ], 'waiting', 15 * SEC);
  const steps = waiting.items.filter(item => item.kind !== 'wait');
  expect(steps[0]).toMatchObject({ key: 'inspect', status: 'completed', duration_ms: 6 * SEC, work_ms: 6 * SEC });
  expect(steps[1]).toMatchObject({ key: 'implement', status: 'pending', work_ms: 0, active_since: null });
  const wait = waiting.items.find(item => item.kind === 'wait');
  expect(wait).toMatchObject({ key: '__wait__', status: 'pending', reason: 'waiting', waiting_since: at(8 * SEC), wait_ms: 2 * SEC });
  expect(wait.label).toContain('等待');
  // 等待行插在已完成的 inspect 与当前 implement 之间，且不占计划完成度。
  expect(waiting.items.map(item => item.key)).toEqual(['inspect', '__wait__', 'implement']);

  // 正在 running：未结束的 run 拆成 active_since，交给前端自己推进，不再生成开着的等待行。
  const running = projectProgress(progress, [
    { started_at: at(0), ended_at: at(4 * SEC) },
    { started_at: at(6 * SEC), ended_at: at(8 * SEC) },
    { started_at: at(10 * SEC), ended_at: null },
  ], 'running', 15 * SEC);
  expect(running.items.find(item => item.key === 'implement')).toMatchObject({ active_since: at(10 * SEC), work_ms: 0 });
  const closedWait = running.items.find(item => item.kind === 'wait');
  expect(closedWait).toMatchObject({ status: 'completed', reason: null, duration_ms: 4 * SEC, waiting_since: null });
});

test('a parked parent shows waiting as its own plan entry in inspect and tree summaries', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const parent = f.store.create({ role: 'coordinator', goal: 'parent waits for child', input_id: null });
    f.project.kick();
    await until(() => provider.calls.length === 1);
    const token = f.project.running.get(parent.id).token;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    await rpc.dispatch('progress.plan', { _token: token, steps: [
      { key: 'delegate', label: '派发' }, { key: 'collect', label: '收集结果' },
    ] });
    await rpc.dispatch('progress.complete', { _token: token, step: 'delegate' });
    const child = f.project.spawn(parent.id, 'child work', 'research');
    provider.calls[0].done.resolve('delegated');
    await until(() => f.store.task(parent.id).status === 'waiting' && f.store.task(child.id).status === 'running');
    // 等一小段真实时间，让「等子任务」的区间长得足够生成等待行。
    await new Promise(resolve => setTimeout(resolve, 30));

    const view = f.project.inspect(parent.id);
    const wait = view.progress.items.find(item => item.kind === 'wait');
    expect(wait).toMatchObject({ status: 'pending', reason: 'waiting' });
    expect(Date.parse(wait.waiting_since)).toBeGreaterThan(0);
    // 等待不是 Agent 的工作：收集步骤此刻没有 active_since，工作用时停在调用结束那一刻。
    const collect = view.progress.items.find(item => item.key === 'collect');
    expect(collect.active_since).toBeNull();
    expect(collect.work_ms).toBeGreaterThanOrEqual(0);
    // 任务树的紧凑进度带同一等待行，口径与详情一致。
    const summary = f.project.decorate(f.store.summaries('work')).find(task => task.id === parent.id);
    expect(summary.progress.items.some(item => item.kind === 'wait' && item.reason === 'waiting')).toBe(true);
  } finally { await f.close(); }
});

test('terminal progress freezes waiting at the last run instead of growing with view time', () => {
  const progress = { version: 1, updated_at: at(0), items: [
    { key: 'only', label: '只做一步', status: 'completed', started_at: at(0), completed_at: at(10 * SEC), duration_ms: 10 * SEC },
  ] };
  const runs = [{ started_at: at(0), ended_at: at(4 * SEC) }];
  const early = projectProgress(progress, runs, 'completed', 20 * SEC);
  const late = projectProgress(progress, runs, 'completed', 900 * SEC);
  const duration = view => view.items.find(item => item.kind === 'wait').duration_ms;
  expect(duration(early)).toBe(6 * SEC);
  expect(duration(late)).toBe(6 * SEC);
  expect(early.items.find(item => item.kind === 'wait').status).toBe('completed');
});

test('progress plans reject duplicate or unstable keys', async () => {
  const f = fixture({ async run() { return 'done'; } });
  try {
    const task = f.store.create({ role: 'research', goal: 'validate', input_id: null });
    expect(() => f.project.reportProgressPlan(task.id, [{ key: 'Bad Key', label: 'x' }])).toThrow('must match');
    expect(() => f.project.reportProgressPlan(task.id, [{ key: 'test', label: 'one' }, { key: 'test', label: 'two' }])).toThrow('duplicate');
  } finally { await f.close(); }
});
