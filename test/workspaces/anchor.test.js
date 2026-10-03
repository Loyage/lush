import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';

// 输入锚点：order 从指定父分支创建聚合分支与检出，Task 的基线不随开工时间漂移。
// 这里只碰 Git 边界与输入落库的接缝；CLI / Web 的上层行为在 test/route-shortcut.test.js。

test('new order creates a real aggregate branch checkout and runs there', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const head = await git(f.root, 'rev-parse', 'HEAD');
    const input = await f.project.order('work');
    expect(input.anchor).toMatchObject({ branch: `lush/${f.project.workspaces.namespace}/input-${input.id}`, commit: head, target: 'main' });
    expect(fs.existsSync(input.anchor.workspace)).toBe(true);
    // 检出真的停在输入分支上；根 planner 的 cwd 也固定到这里。
    expect(await git(input.anchor.workspace, 'symbolic-ref', '--short', 'HEAD')).toBe(input.anchor.branch);
    expect(await f.project.workspaces.ensure(input.task)).toBe(input.anchor.workspace);
    // 谱系在分支创建那一刻写下：parent = 提交输入时的检出分支，created_from_commit = 当时的 HEAD
    expect(f.store.branch(input.anchor.branch)).toMatchObject({ parent: 'main', parent_relation: 'recorded',
      created_from_commit: head, task_id: input.task.id, worktree: input.anchor.workspace, status: 'active' });
    // 意图视图与事件都带上锚点，review 时看得到「这份代码是什么时候冻的」
    expect(f.project.inputs()[0]).toMatchObject({ anchor_branch: input.anchor.branch, anchor_commit: head,
      anchor_workspace: input.anchor.workspace, anchor_target_branch: 'main' });
    expect(f.store.history(input.task.id).find(row => row.type === 'input.anchor').data)
      .toMatchObject({ input_id: input.id, branch: input.anchor.branch, commit: head, target_branch: 'main' });
  } finally { await f.close(); }
});

test('uncommitted changes are recorded on the anchor instead of silently entering the baseline', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'uncommitted\n');
    const input = await f.project.order('work');
    const event = f.store.history(input.task.id).find(row => row.type === 'input.anchor');
    expect(event.data.dirty_source).toMatchObject({ files: 1, sample: [' M file.txt'] });
    // 锚点是已提交的 HEAD：那一刻的未提交改动不传递，也不改变基线
    expect(input.anchor.commit).toBe(await git(f.root, 'rev-parse', 'HEAD'));
    expect(fs.readFileSync(path.join(input.anchor.workspace, 'file.txt'), 'utf8')).toBe('base\n');
  } finally { await f.close(); }
});

test('a child bases, parents and targets on its parent branch, not on the branch tip at anchor time', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const order = await f.project.order('implement the thing');
    const anchorCommit = order.anchor.commit;
    // 建好锚点后用户继续在主树上提交：锚点已经在 order 那一刻定住，父分支不动，child 也不该看见后来的提交。
    fs.writeFileSync(path.join(f.root, 'later.txt'), 'later\n');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'later on main');
    const child = await f.project.spawn(order.task.id, 'implement');
    const cwd = await f.project.workspaces.ensure(child);
    const task = f.store.task(child.id);
    expect(task.base_commit).toBe(anchorCommit);
    expect(task.target_branch).toBe(order.task.branch);
    expect(fs.existsSync(path.join(cwd, 'later.txt'))).toBe(false);
    // 谱系写父分支，而不是「当时检出的分支」——那条 main 早就在锚点之后往前走了。
    expect(f.store.branch(task.branch)).toMatchObject({ parent: order.task.branch, created_from_commit: anchorCommit });
    // child 的 worktree 在 spawn 时就建好了（forkTaskUnsafe），事件记的是 fork 本身。
    expect(f.store.history(child.id).find(row => row.type === 'task.forked').data)
      .toMatchObject({ parent_id: order.task.id, branch: task.branch, workspace: task.workspace });
  } finally { await f.close(); }
});

test('父分支自己前进之后，child 从父分支当时的 tip 长出来，基线不再是锚点', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const order = await f.project.order('stack two things');
    const orderBranch = order.task.branch;
    fs.writeFileSync(path.join(order.task.workspace, 'upstream.txt'), 'upstream\n');
    await git(order.task.workspace, 'add', '.'); await git(order.task.workspace, 'commit', '-m', 'upstream change');
    await f.project.workspaces.finish(f.store.task(order.task.id));
    f.store.update(order.task.id, { status: 'waiting' });

    const child = await f.project.spawn(order.task.id, 'downstream');
    const task = f.store.task(child.id);
    expect(task.base_commit).toBe(f.store.task(order.task.id).head_commit);
    expect(task.base_commit).not.toBe(order.anchor.commit);
    expect(task.target_branch).toBe(orderBranch);
    expect(f.store.branch(task.branch)).toMatchObject({ parent: orderBranch, created_from_commit: task.base_commit });
  } finally { await f.close(); }
});

test('input submission can choose a local parent branch without checking it out', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    await git(f.root, 'branch', 'release-next');
    // 新模型里非 main 的父分支先要有 Task 所有者（branch.bind），order 才能挂上去。
    await f.project.bindBranch('release-next', await git(f.root, 'rev-parse', 'release-next'));
    const input = await f.project.order('release work', 'release-next');
    expect(input.anchor.target).toBe('release-next');
    expect(f.store.branch(input.anchor.branch).parent).toBe('release-next');
    expect(await git(f.root, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    await expect(f.project.order('bad', 'missing-branch'))
      .rejects.toThrow('needs exactly one explicitly bound Worker before order');
  } finally { await f.close(); }
});

test('anchoring refuses a detached HEAD without an explicit parent, a project that is not a git root, and a taken branch name', async () => {
  const plain = fixture(); plain.project.stopping = true;
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    await expect(plain.project.workspaces.anchor(1)).rejects.toThrow('git worktree root');
    await git(f.root, 'checkout', '--detach');
    await expect(f.project.workspaces.anchor(1)).rejects.toThrow('detached HEAD');
    await git(f.root, 'checkout', 'main');
    await git(f.root, 'branch', `lush/${f.project.workspaces.namespace}/input-1`);
    await expect(f.project.workspaces.anchor(1)).rejects.toThrow('already exists');
    // 三次失败一条都不落库：没有分支记录被写成事实
    expect(f.store.branches()).toEqual([]);
  } finally { await f.close(); await plain.close(); }
});



test('releaseAnchor only drops an untouched checkout, and reclaimAnchors keeps going', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const first = await f.project.workspaces.anchor(1);
    const second = await f.project.workspaces.anchor(2);
    const dirty = await f.project.workspaces.anchor(3);
    fs.writeFileSync(path.join(dirty.workspace, 'file.txt'), 'dirty\n');
    const moved = await f.project.workspaces.anchor(4);
    await git(moved.workspace, 'commit', '--allow-empty', '-m', 'someone committed on the anchor');

    const outcomes = await f.project.workspaces.reclaimAnchors([1, 2, 3, 4].map(id => ({ id,
      branch: [first, second, dirty, moved][id - 1].branch, commit: [first, second, dirty, moved][id - 1].commit,
      workspace: [first, second, dirty, moved][id - 1].workspace })));
    expect(outcomes.map(row => [row.id, row.status])).toEqual([[1, 'removed'], [2, 'removed'], [3, 'kept'], [4, 'kept']]);
    expect(outcomes[2].reason).toContain('dirty');
    expect(outcomes[3].reason).toContain('has not been merged into main');
    // 干净的回收掉：目录没了、分支没了、谱系行只标 deleted（子分支的 parent 指针要继续有效）
    expect(fs.existsSync(first.workspace)).toBe(false);
    expect(await git(f.root, 'branch', '--list', first.branch)).toBe('');
    expect(f.store.branch(first.branch).status).toBe('deleted');
    // 被安全门挡住的连目录带分支一起保留（锚点被谁动过就留成活证据）
    expect(fs.existsSync(dirty.workspace)).toBe(true);
    expect(fs.existsSync(moved.workspace)).toBe(true);
    expect(await git(f.root, 'branch', '--list', moved.branch)).toContain(moved.branch);
  } finally { await f.close(); }
});
