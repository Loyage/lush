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
    const child = f.project.spawn(f.task.parent_id, 'continue upstream work', 'worker', [{ id: upstream.id, kind: 'code' }], 'stacked-follow-up');
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
    const child = f.project.spawn(f.task.parent_id, 'continue upstream work', 'worker', [{ id: upstream.id, kind: 'code' }], 'stacked-follow-up');
    await f.project.workspaces.ensure(f.store.task(child.id));
    const childBranch = f.store.task(child.id).branch;

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
