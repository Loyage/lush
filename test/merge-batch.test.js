import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from './helpers.js';
import { mergeOrder } from '../src/core/merge-batch.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { createSignal } from '../src/signal.js';

/**
 * 批量合并的顺序是纯逻辑（mergeOrder），其余是真实链路：
 * 每个 worker 在独立 worktree 里改一个只属于自己名字的文件并提交，测试只通过 Project.approveMergeMany 合并，
 * 不直接往 worktree 里跑 git（那会和 runtime 的 finish/clean 抢 index.lock）。
 */
function committer() {
  return { async run(ctx) {
    if (ctx.task.role !== 'worker') return 'noop';
    fs.writeFileSync(path.join(ctx.cwd, `${ctx.task.name}.txt`), `${ctx.task.name}\n`);
    await git(ctx.cwd, 'add', '-A');
    await git(ctx.cwd, 'commit', '-m', `${ctx.task.name} change`);
    return `已写 ${ctx.task.name}.txt`;
  } };
}

/** conflict worker 改 file.txt（和前进后的 main 冲突），other worker 改 other.txt（干净可合）。 */
function colliding() {
  return { async run(ctx) {
    if (ctx.task.role !== 'worker') return 'noop';
    const file = ctx.task.name === 'conflict' ? 'file.txt' : 'other.txt';
    fs.writeFileSync(path.join(ctx.cwd, file), `${ctx.task.name}\n`);
    await git(ctx.cwd, 'add', '-A');
    await git(ctx.cwd, 'commit', '-m', `${ctx.task.name} change`);
    return 'ok';
  } };
}

function host(f) { return f.store.create({ input_id: null, role: 'coordinator', goal: 'build' }); }

test('mergeOrder ranks selected upstreams before downstream and keeps ties stable', () => {
  // 3 的代码基线是 1；5 只在执行时等 3。交付只按 code 排序，其余按 id 稳定排列。
  const edges = [
    { task_id: 3, depends_on: 1, kind: 'code' },
    { task_id: 5, depends_on: 3, kind: 'order' },
  ];
  expect(mergeOrder([5, 3, 1, 2], edges)).toEqual([1, 2, 3, 5]);
  // 依赖优先级高于 id：即使下游 id 更小，只要有 code 边，上游也必须排在前面
  expect(mergeOrder([1, 3], [{ task_id: 1, depends_on: 3, kind: 'code' }])).toEqual([3, 1]);
  // 集合外的上游不参与排序（是否已合由 approveMerge 的门槛判断）
  expect(mergeOrder([3, 1], [{ task_id: 3, depends_on: 9, kind: 'code' }])).toEqual([1, 3]);
  // 同一输入永远同一输出
  expect(mergeOrder([4, 2, 6], [])).toEqual([2, 4, 6]);
  // order 不得偷偷变成合并依赖：即使 #1 执行时等 #9，交付仍按 id。
  expect(mergeOrder([9, 1], [{ task_id: 1, depends_on: 9, kind: 'order' }])).toEqual([1, 9]);
});

test('batch merge merges every selected task, dedupes ids and counts the successes', async () => {
  const f = fixture(committer());
  try {
    await repo(f.root);
    const parent = host(f);
    const alpha = f.project.spawn(parent.id, 'alpha', 'worker', [], 'alpha');
    const beta = f.project.spawn(parent.id, 'beta', 'worker', [], 'beta');
    const gamma = f.project.spawn(parent.id, 'gamma', 'worker', [], 'gamma');
    await until(() => [alpha, beta, gamma].every(task => f.store.task(task.id).status === 'completed'));
    // 传乱序且带重复：按 id 升序去重后逐个合并。
    const result = await f.project.approveMergeMany([gamma.id, alpha.id, beta.id, alpha.id]);
    expect(result.merged).toBe(3);
    expect(result.stopped).toBeNull();
    expect(result.merges.map(row => [row.id, row.status])).toEqual([
      [alpha.id, 'merged'], [beta.id, 'merged'], [gamma.id, 'merged']]);
    for (const row of result.merges) expect(row.integration).toBe('merged');
    for (const name of ['alpha', 'beta', 'gamma']) expect(fs.existsSync(path.join(f.root, `${name}.txt`))).toBe(true);
    expect(await git(f.root, 'status', '--porcelain')).toBe('');
  } finally { await f.close(); }
});

test('batch merge follows a code dependency: the upstream lands first even when listed later', async () => {
  const f = fixture(committer());
  try {
    await repo(f.root);
    const parent = host(f);
    const upstream = f.project.spawn(parent.id, 'upstream', 'worker', [], 'upstream');
    // 下游同步 spawn：它的 worktree 要等上游结束才会创建（code 基线）。
    const downstream = f.project.spawn(parent.id, 'downstream', 'worker', [{ id: upstream.id, kind: 'code' }], 'downstream');
    await until(() => f.store.task(upstream.id).status === 'completed' && f.store.task(downstream.id).status === 'completed');
    const result = await f.project.approveMergeMany([downstream.id, upstream.id]);
    expect(result.merges.map(row => [row.id, row.status])).toEqual([[upstream.id, 'merged'], [downstream.id, 'merged']]);
    expect(result.merged).toBe(2);
    expect(result.stopped).toBeNull();
  } finally { await f.close(); }
});

test('batch preflight finds a dirty later worktree before the first selected change lands', async () => {
  const f = fixture(committer());
  try {
    await repo(f.root);
    const parent = host(f);
    const first = f.project.spawn(parent.id, 'first', 'worker', [], 'first');
    const dirty = f.project.spawn(parent.id, 'dirty', 'worker', [], 'dirty');
    await until(() => [first, dirty].every(task => f.store.task(task.id).status === 'completed'));
    fs.writeFileSync(path.join(f.store.task(dirty.id).workspace, 'uncommitted.txt'), 'dirty\n');
    await expect(f.project.approveMergeMany([first.id, dirty.id])).rejects.toThrow('working tree is dirty');
    expect(fs.existsSync(path.join(f.root, 'first.txt'))).toBe(false);
    expect(f.store.task(first.id).integration).toBe('pending');
  } finally { await f.close(); }
});

test('batch preflight rejects tasks from different target branches before changing either branch', async () => {
  const f = fixture(committer());
  try {
    await repo(f.root);
    const parent = host(f);
    const mainTask = f.project.spawn(parent.id, 'main change', 'worker', [], 'main-change');
    const releaseTask = f.project.spawn(parent.id, 'release change', 'worker', [], 'release-change');
    await until(() => [mainTask, releaseTask].every(task => f.store.task(task.id).status === 'completed'));
    f.store.update(releaseTask.id, { target_branch: 'release' });
    await expect(f.project.approveMergeMany([mainTask.id, releaseTask.id])).rejects.toThrow('must target one branch');
    expect(f.store.task(mainTask.id).integration).toBe('pending');
    expect(f.store.task(releaseTask.id).integration).toBe('pending');
    expect(fs.existsSync(path.join(f.root, 'main-change.txt'))).toBe(false);
  } finally { await f.close(); }
});

test('a conflict stops the batch and the remaining tasks are skipped', async () => {
  const f = fixture(colliding());
  try {
    await repo(f.root);
    const parent = host(f);
    const conflict = f.project.spawn(parent.id, 'conflict', 'worker', [], 'conflict');
    const other = f.project.spawn(parent.id, 'other', 'worker', [], 'other');
    await until(() => [conflict, other].every(task => f.store.task(task.id).status === 'completed'));
    // 两个 worktree 都拉出来之后主树才前进：conflict 的改动必然内容冲突。
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'main\n');
    await git(f.root, 'add', '-A');
    await git(f.root, 'commit', '-m', 'main moves on');

    // conflict 的 id 更小，所以即使按 [other, conflict] 传进来，合并顺序也是 conflict 先。
    const result = await f.project.approveMergeMany([other.id, conflict.id]);
    expect(result.merged).toBe(0);
    expect(result.merges[0]).toMatchObject({ id: conflict.id, status: 'conflict' });
    expect(result.merges[0].resolution_task_id).toBeGreaterThan(0);
    expect(result.merges[0].error).toContain('file.txt');
    expect(result.merges[1]).toMatchObject({ id: other.id, status: 'skipped' });
    expect(result.merges[1].error).toContain(`#${conflict.id}`);
    expect(result.stopped).toMatchObject({ id: conflict.id });
    // 冲突让同一目标分支冻结，后面的任务没有被碰过。
    expect(f.store.task(other.id).integration).toBe('pending');
    expect(fs.existsSync(path.join(f.root, 'other.txt'))).toBe(false);
    expect(f.project.status().merge_freeze.map(row => row.task_id)).toEqual([conflict.id]);
  } finally { await f.close(); }
});

test('batch preflight rejects an ineligible entry before touching any selected branch', async () => {
  const f = fixture(committer());
  try {
    await repo(f.root);
    const parent = host(f);
    const good = f.project.spawn(parent.id, 'alpha', 'worker', [], 'alpha');
    await until(() => f.store.task(good.id).status === 'completed' && f.store.task(parent.id).status === 'completed');
    await expect(f.project.approveMergeMany([good.id, parent.id])).rejects.toThrow('not a completed merge candidate');
    expect(f.store.task(good.id).integration).toBe('pending');
    expect(fs.existsSync(path.join(f.root, 'alpha.txt'))).toBe(false);
  } finally { await f.close(); }
});

test('batch merge validates its ids and rejects agent tokens', async () => {
  const blocking = { run({ signal }) { return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } };
  const f = fixture(blocking); await repo(f.root);
  try {
    await expect(f.project.approveMergeMany([])).rejects.toThrow('at least one');
    await expect(f.project.approveMergeMany('7')).rejects.toThrow('array');
    await expect(f.project.approveMergeMany([0])).rejects.toThrow('positive');
    await expect(f.project.approveMergeMany([1.5])).rejects.toThrow('positive');
    await expect(f.project.approveMergeMany(Array.from({ length: 51 }, (_v, index) => index + 1))).rejects.toThrow('at most 50');
    // USER_ONLY：agent 不能替用户批准合并，批量的也不例外。
    const root = (await f.project.submit('root')).task;
    await until(() => f.project.running.has(root.id));
    const token = f.project.running.get(root.id).token;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    await expect(rpc.dispatch('task.merge_many', { ids: [root.id], _token: token })).rejects.toThrow('user approval');
  } finally { await f.close(); }
});
