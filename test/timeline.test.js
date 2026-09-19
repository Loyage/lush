import { test, expect } from 'bun:test';
import { fixture, until, gate, repo, git } from './helpers.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { createSignal } from '../src/signal.js';

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once:true });
    return done.promise;
  } };
}

test('timeline turns invocations into runs and tells a dependency wait from a slot wait', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '1' });
  try {
    // 工作池只有一个槽：first 占住它，没有依赖的 queued 只能等槽，blocked 等的是 first 这条依赖。
    // planner 不能再直接派活，这里按任务树最底层直接建任务与依赖边（都是 research，不建 worktree）。
    const first = f.store.create({ input_id: null, role: 'research', goal: 'takes the only worker slot' });
    const queued = f.store.create({ input_id: null, role: 'research', goal: 'waits for the slot' });
    const blocked = f.store.create({ input_id: null, role: 'research', goal: 'waits for first' });
    f.store.addDep(blocked.id, first.id, 'order');
    f.project.kick();
    const call = taskId => provider.calls.find(entry => entry.task.id === taskId);
    await until(() => f.store.task(first.id).status === 'running');
    call(first.id).done.resolve('done');
    await until(() => f.store.task(queued.id).status === 'running');
    call(queued.id).done.resolve('done');
    await until(() => f.store.task(blocked.id).status === 'running');
    call(blocked.id).done.resolve('done');
    await until(() => f.store.task(blocked.id).status === 'completed');

    const timeline = f.project.timeline();
    const row = taskId => timeline.tasks.find(task => task.id === taskId);
    expect(timeline.concurrency).toBe(1);
    expect(timeline.clamped).toBe(false);
    expect(row(first.id).segments.at(-1)).toMatchObject({ kind: 'run' });
    expect(row(first.id).segments.some(segment => segment.reason === 'dep')).toBe(false);
    expect(row(queued.id).segments.some(segment => segment.kind === 'wait' && segment.reason === 'slot')).toBe(true);
    expect(row(blocked.id).segments.find(segment => segment.reason === 'dep').blocked_by).toEqual([first.id]);
    expect(row(blocked.id).deps).toEqual([{ id: first.id, kind: 'order', terminal_at: row(first.id).terminal_at }]);
    expect(row(first.id).terminal_at).toBeTruthy();
  } finally { await f.close(); }
});

test('timeline keeps an open segment for whatever a task is doing right now', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const parent = f.store.create({ input_id: null, role: 'coordinator', goal: 'parent' });
    f.project.kick();
    await until(() => provider.calls.length === 1);
    const child = f.project.spawn(parent.id, 'child', 'research');
    provider.calls[0].done.resolve('delegated');
    // 父任务派完工就停在 waiting，子任务还在跑：两边的开口段分别是「等子任务」和「运行中」。
    await until(() => f.store.task(parent.id).status === 'waiting' && f.store.task(child.id).status === 'running');

    const timeline = f.project.timeline({ limit: 2 });
    expect(timeline.tasks.map(task => task.id)).toEqual([parent.id, child.id]);
    expect(timeline.truncated).toBe(false);
    const row = taskId => timeline.tasks.find(task => task.id === taskId);
    expect(row(parent.id).segments.at(-1)).toMatchObject({ kind: 'wait', reason: 'children', open: true });
    expect(row(child.id).segments.at(-1)).toMatchObject({ kind: 'run', open: true });
    expect(f.project.timeline({ limit: 1 }).truncated).toBe(true);
    expect(() => f.project.timeline({ limit: 0 })).toThrow('timeline limit must be 1..200');
  } finally { await f.close(); }
});

test('timeline does not leave a task that died before it ever started blank', async () => {
  const f = fixture({ run: async () => 'never called' });
  try {
    const task = f.store.create({ role: 'worker', goal: 'no worktree at all', name: 'broken' });
    f.project.cancel(task.id, 'worktree creation failed', 'failed');
    const [row] = f.project.timeline().tasks;
    expect(row.segments).toEqual([{ kind: 'wait', start: row.created_at, end: row.terminal_at, reason: 'setup' }]);
  } finally { await f.close(); }
});

test('timeline and ladder are read-only read models, not user-only actions', async () => {
  const f = fixture();
  try {
    const dispatcher = new Dispatcher(f.project, createSignal(), {});
    expect((await dispatcher.dispatch('system.timeline', {})).tasks).toEqual([]);
    expect((await dispatcher.dispatch('task.ladder', {})).nodes).toEqual([]);
    await expect(dispatcher.dispatch('system.timeline', { limit: 0 })).rejects.toThrow('timeline limit must be 1..200');
    await expect(dispatcher.dispatch('task.ladder', { limit: 1 })).rejects.toThrow('unknown parameter');
    await expect(dispatcher.dispatch('task.timeline', {})).rejects.toThrow('unknown method');
  } finally { await f.close(); }
});

test('ladder separates code bases from order waits and notices a branch that already carries its upstream', async () => {
  const f = fixture();
  try {
    await repo(f.root);
    const main = await git(f.root, 'rev-parse', 'HEAD');
    const tree = await git(f.root, 'rev-parse', 'HEAD^{tree}');
    const commit = async (message, parents) => git(f.root, 'commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message);
    // #1 一条普通分支；#2 的 worktree 以 #1 为基线（code）；#3 只等 #1 结束（order，不带它的提交）；
    // #4 与 #3 同样是 order 依赖，但它把 #1 的提交合并进来了——runtime 看不出来，只有 git 知道。
    const one = await commit('one', [main]);
    const two = await commit('two', [one]);
    const three = await commit('three', [main]);
    const four = await commit('merge one', [main, one]);
    const merged = main;
    // 任务行必须先在库里，才能给它们挂分支信息与依赖边。
    expect([1, 2, 3, 4, 5]).toEqual(Array.from({ length: 5 }, (_, index) => f.store.create({ role: 'worker', goal: `task ${index + 1}`, name: `t${index + 1}` }).id));
    const rows = [['up', one, 1], ['stacked', two, 2], ['waits', three, 3], ['integrator', four, 4], ['landed', merged, 5]];
    for (const [, head, taskId] of rows) f.store.update(taskId, { branch: `lush/ns/${taskId}`, head_commit: head, target_branch: 'main', integration: 'pending', status: 'completed' });
    f.store.update(5, { integration: 'merged' });
    f.store.addDep(2, 1, 'code');
    f.store.addDep(2, 5, 'code');
    f.store.addDep(3, 1, 'order');
    f.store.addDep(4, 1, 'order');

    const ladder = await f.project.ladder();
    const node = taskId => ladder.nodes.find(entry => entry.id === taskId);
    expect(ladder.target_branch).toBe('main');
    expect(ladder.truncated).toBe(false);
    expect(ladder.nodes.map(entry => entry.id)).toEqual([1, 2, 3, 4]);
    expect(node(2).deps).toEqual([
      { id: 1, kind: 'code', branch: 'lush/ns/1', merged: false, pending: true, contains: true },
      { id: 5, kind: 'code', branch: 'lush/ns/5', merged: true, pending: false, contains: true },
    ]);
    expect(node(2).level).toBe(1);
    const delivery = taskId => ladder.groups.flatMap(group => group.items).find(item => item.id === taskId);
    expect(delivery(2)).toMatchObject({ ready: false, selectable: true });
    expect(delivery(2).blockers).toContainEqual(expect.objectContaining({ code: 'code_upstream', task_id: 1 }));
    expect(node(3).deps[0]).toMatchObject({ kind: 'order', contains: false });
    expect(node(4).deps[0]).toMatchObject({ kind: 'order', contains: true });
    // order 边不改变合并层级：集成分支可以先合，而 code 基线必须先合。
    expect([node(1).level, node(3).level, node(4).level]).toEqual([0, 0, 0]);
    expect(node(1).covered_by).toEqual([4]);
    expect(node(3).covered_by).toEqual([]);
    // code 上游本来就必须先合，把它标成「已被覆盖」会和 runtime 的守卫自相矛盾。
    expect(node(1).covered_by).not.toContain(2);
  } finally { await f.close(); }
});
