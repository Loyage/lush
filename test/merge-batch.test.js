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
  // 3 依赖 1，5 依赖 3；2 无依赖：1 → 2 → 3 → 5（并列按 id 升序）
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

test('a failing entry stops the batch instead of being swallowed', async () => {
  const f = fixture(committer());
  try {
    await repo(f.root);
    // coordinator 没有可合并的分支，approveMerge 会直接报错；它的 id 比 worker 小，所以排在最前。
    const parent = host(f);
    const good = f.project.spawn(parent.id, 'alpha', 'worker', [], 'alpha');
    await until(() => f.store.task(good.id).status === 'completed' && f.store.task(parent.id).status === 'completed');
    const result = await f.project.approveMergeMany([good.id, parent.id]);
    expect(result.merged).toBe(0);
    expect(result.merges[0]).toMatchObject({ id: parent.id, status: 'failed' });
    expect(result.merges[0].error).toContain('pending/review/conflict');
    expect(result.merges[1]).toMatchObject({ id: good.id, status: 'skipped' });
    expect(result.stopped).toMatchObject({ id: parent.id });
    expect(f.store.task(good.id).integration).toBe('pending');
  } finally { await f.close(); }
});

test('batch merge validates its ids and rejects agent tokens', async () => {
  const blocking = { run({ signal }) { return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } };
  const f = fixture(blocking);
  try {
    await expect(f.project.approveMergeMany([])).rejects.toThrow('at least one');
    await expect(f.project.approveMergeMany('7')).rejects.toThrow('array');
    await expect(f.project.approveMergeMany([0])).rejects.toThrow('positive');
    await expect(f.project.approveMergeMany([1.5])).rejects.toThrow('positive');
    await expect(f.project.approveMergeMany(Array.from({ length: 51 }, (_v, index) => index + 1))).rejects.toThrow('at most 50');
    // USER_ONLY：agent 不能替用户批准合并，批量的也不例外。
    const root = f.project.submit('root').task;
    await until(() => f.project.running.has(root.id));
    const token = f.project.running.get(root.id).token;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    await expect(rpc.dispatch('task.merge_many', { ids: [root.id], _token: token })).rejects.toThrow('user approval');
  } finally { await f.close(); }
});
