import { test, expect } from 'bun:test';
import { git } from '../helpers.js';
import { setup, change } from './harness.js';

test('creating a worktree records the branch genealogy at the moment of creation', async () => {
  const f = await setup();
  try {
    await change(f, f.task);
    const task = f.store.task(f.task.id);
    const row = f.store.branch(task.branch);
    expect(row).toMatchObject({ parent: 'main', parent_relation: 'recorded', task_id: task.id, worktree: task.workspace, status: 'active' });
    expect(row.created_from_commit).toBe(task.base_commit);
    // 记录是幂等的：再次 ensure 不会改写 parent（merge / 重建都不能重写创建时的血缘）。
    f.store.recordBranch({ branch: task.branch, parent: 'somewhere-else' });
    expect(f.store.branch(task.branch).parent).toBe('main');

    const tree = await f.project.branchTree();
    expect(tree.current_branch).toBe('main');
    const main = tree.roots.find(node => node.branch === 'main');
    expect(main.children.map(node => node.branch)).toEqual([task.branch]);
    expect(main.children[0]).toMatchObject({ tracked: true, present: true, deleted: false, task_id: task.id });

    const shown = await f.project.branchShow(String(task.id));   // 数字：按 task id 查
    expect(shown.branch).toBe(task.branch);
    expect(shown.chain).toEqual(['main', task.branch]);
    expect(shown.ancestors).toEqual(['main']);
    expect(shown.root).toBe('main');
  } finally { await f.close(); }
});

test('a stacked task is recorded as a child of the upstream task branch', async () => {
  const f = await setup();
  try {
    await change(f, f.task);
    const upstream = f.store.task(f.task.id);
    // 新模型没有 code 依赖边：child 直接 fork 自父分支当时的 tip，血缘记录的是那个提交。
    // 派活只发生在还没结算的父 Task 上，所以这里先把父 Task 留在活动态。
    f.store.update(upstream.id, { status: 'waiting' });
    const child = await f.project.spawn(f.task.id, 'continue upstream work', undefined, [], 'stacked-follow-up');
    await f.project.workspaces.ensure(f.store.task(child.id));
    const row = f.store.branch(f.store.task(child.id).branch);
    expect(row.parent).toBe(upstream.branch);
    expect(row.created_from_commit).toBe(upstream.head_commit);
    expect(row.parent_relation).toBe('recorded');
  } finally { await f.close(); }
});

test('deleting a branch keeps its row and every child pointer', async () => {
  const f = await setup();
  try {
    await change(f, f.task);
    const upstream = f.store.task(f.task.id);
    // 新模型没有 code 依赖边：child 直接 fork 自父分支当时的 tip，血缘记录的是那个提交。
    // 派活只发生在还没结算的父 Task 上，所以这里先把父 Task 留在活动态。
    f.store.update(upstream.id, { status: 'waiting' });
    const child = await f.project.spawn(f.task.id, 'continue upstream work', undefined, [], 'stacked-follow-up');
    const childBranch = f.store.task(child.id).branch;
    f.store.update(child.id, { status: 'completed' });
    f.store.update(upstream.id, { status: 'completed' });

    await f.project.workspaces.merge(upstream.id);
    await f.project.workspaces.cleanup(upstream.id);
    expect(f.store.branch(upstream.branch)).toMatchObject({ status: 'deleted' });
    expect(f.store.branch(childBranch).parent).toBe(upstream.branch);

    const tree = await f.project.branchTree();
    const collect = nodes => nodes.flatMap(node => [node, ...collect(node.children)]);
    const gone = collect(tree.roots).find(node => node.branch === upstream.branch);
    expect(gone).toMatchObject({ tracked: true, present: false, deleted: true });
    expect(gone.children.map(node => node.branch)).toEqual([childBranch]);
  } finally { await f.close(); }
});

test('branch import registers existing branches without inventing a parent', async () => {
  const f = await setup();
  try {
    await git(f.root, 'branch', 'legacy/one');
    await git(f.root, 'branch', 'legacy/two');
    const first = await f.project.branchImport();
    // main 也不是 Lush 创建的：import 同样只登记它存在与它的 parent unknown。
    expect(first.branches).toEqual(['legacy/one', 'legacy/two', 'main']);
    expect(f.store.branch('legacy/one')).toMatchObject({ parent: null, parent_relation: 'unknown', created_from_commit: null, task_id: null });
    expect(f.store.branch('main')).toMatchObject({ parent: null, parent_relation: 'unknown' });
    expect((await f.project.branchImport()).imported).toBe(0);

    const tree = await f.project.branchTree();
    const legacy = tree.roots.find(node => node.branch === 'legacy/one');
    expect(legacy).toMatchObject({ tracked: true, present: true, current: false });
    expect(legacy.parent).toBeNull();
    // 未记录的本地分支也画出来，但明确标成 untracked。
    await git(f.root, 'branch', 'never-seen');
    const again = await f.project.branchTree();
    expect(again.roots.find(node => node.branch === 'never-seen')).toMatchObject({ tracked: false, present: true });
  } finally { await f.close(); }
});

test('merging a branch never rewrites who created it', async () => {
  const f = await setup();
  try {
    await change(f, f.task);
    const task = f.store.task(f.task.id);
    await f.project.workspaces.merge(task.id);
    const row = f.store.branch(task.branch);
    expect(row.parent).toBe('main');
    expect(row.parent_relation).toBe('recorded');
    expect(row.status).toBe('active');   // merge 只让 main 前进，不删分支、不改谱系
  } finally { await f.close(); }
});

test('branch tree 不再画归档的分支，它的子分支接到最近的可见祖先上', async () => {
  const f = await setup();
  try {
    await change(f, f.task);
    const upstream = f.store.task(f.task.id);
    // 新模型没有 code 依赖边：child 直接 fork 自父分支当时的 tip，血缘记录的是那个提交。
    // 派活只发生在还没结算的父 Task 上，所以这里先把父 Task 留在活动态。
    f.store.update(upstream.id, { status: 'waiting' });
    const child = await f.project.spawn(f.task.id, 'continue upstream work', undefined, [], 'stacked-follow-up');
    const childBranch = f.store.task(child.id).branch;
    f.store.update(child.id, { status: 'completed' });
    // 老库形态（旧版归档只删自己一条）：父分支已归档、ref 已经不在，子分支还活着。
    await f.project.workspaces.archiveBranch(upstream.branch);
    expect(f.store.branch(childBranch).parent).toBe(upstream.branch);

    const tree = await f.project.branchTree();
    const collect = nodes => nodes.flatMap(node => [node, ...collect(node.children)]);
    // 归档的分支不占分支树；它的子分支没有被连带藏掉，而是升到可见的父层（这里是 main）。
    expect(collect(tree.roots).some(node => node.branch === upstream.branch)).toBe(false);
    const main = tree.roots.find(node => node.branch === 'main');
    expect(main.children.map(node => node.branch)).toContain(childBranch);
    // 记录还在：branch show 照旧报出 parent 与归档状态。
    const shown = await f.project.branchShow(childBranch);
    expect(shown.parent).toBe(upstream.branch);
    expect((await f.project.branchShow(upstream.branch)).status).toBe('archived');
  } finally { await f.close(); }
});
