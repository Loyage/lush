import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';

// 输入锚点：submit 那一刻就把代码冻成一条分支加一个检出，worker 的基线不再取决于它何时开工。
// 这里只碰 Git 边界与输入落库的接缝；CLI / Web 的上层行为在 test/input-flow.test.js。

/** planner 只写 spec 队列，所以用 coordinator 充当能派活的父任务。 */
function host(f, input_id) {
  const task = f.store.create({ input_id, role: 'coordinator', goal: 'host' });
  f.store.update(task.id, { status: 'waiting' });
  return task;
}

test('an input anchors the code it was submitted against, and the anchor is a real checkout', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const head = await git(f.root, 'rev-parse', 'HEAD');
    const input = await f.project.submit('work');
    expect(input.anchor).toMatchObject({ branch: `lush/${f.project.workspaces.namespace}/input-${input.id}-anchor`, commit: head, target: 'main' });
    expect(fs.existsSync(input.anchor.workspace)).toBe(true);
    // 检出真的停在锚点分支上，不是 --detach 的临时树
    expect(await git(input.anchor.workspace, 'symbolic-ref', '--short', 'HEAD')).toBe(input.anchor.branch);
    // 谱系在分支创建那一刻写下：parent = 提交输入时的检出分支，created_from_commit = 当时的 HEAD
    expect(f.store.branch(input.anchor.branch)).toMatchObject({ parent: 'main', parent_relation: 'recorded',
      created_from_commit: head, task_id: null, worktree: input.anchor.workspace, status: 'active' });
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
    const input = await f.project.submit('work');
    const event = f.store.history(input.task.id).find(row => row.type === 'input.anchor');
    expect(event.data.dirty_source).toMatchObject({ files: 1, sample: [' M file.txt'] });
    // 锚点是已提交的 HEAD：那一刻的未提交改动不传递，也不改变基线
    expect(input.anchor.commit).toBe(await git(f.root, 'rev-parse', 'HEAD'));
    expect(fs.readFileSync(path.join(input.anchor.workspace, 'file.txt'), 'utf8')).toBe('base\n');
  } finally { await f.close(); }
});

test('a worker bases, parents and targets on its input anchor, not on the branch tip at spawn', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const input = await f.project.submit('implement the thing');
    const anchorCommit = input.anchor.commit;
    // 规划期间用户继续在主树上提交：锚点已经在 submit 那一刻定住，worker 不该看见后来的提交。
    fs.writeFileSync(path.join(f.root, 'later.txt'), 'later\n');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'later on main');
    const worker = f.project.spawn(host(f, input.id).id, 'implement', 'worker', [], 'implement-thing');
    const cwd = await f.project.workspaces.ensure(worker);
    const task = f.store.task(worker.id);
    expect(task.base_commit).toBe(anchorCommit);
    expect(task.target_branch).toBe('main');
    expect(fs.existsSync(path.join(cwd, 'later.txt'))).toBe(false);
    // 谱系写锚点分支，而不是「当时检出的分支」——那条分支早就在锚点之后往前走了
    expect(f.store.branch(task.branch)).toMatchObject({ parent: input.anchor.branch, created_from_commit: anchorCommit });
    expect(f.store.history(worker.id).find(row => row.type === 'workspace.created').data.anchored_on)
      .toMatchObject({ input_id: input.id, branch: input.anchor.branch, commit: anchorCommit });
  } finally { await f.close(); }
});

test('a code dependency still stacks on the upstream branch and beats the anchor', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const input = await f.project.submit('stack two things');
    const parent = host(f, input.id);
    const upstream = f.project.spawn(parent.id, 'upstream', 'worker', [], 'upstream-change');
    const cwd = await f.project.workspaces.ensure(upstream);
    fs.writeFileSync(path.join(cwd, 'upstream.txt'), 'upstream\n');
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'upstream change');
    await f.project.workspaces.finish(f.store.task(upstream.id));
    f.store.update(upstream.id, { status: 'completed' });

    const downstream = f.project.spawn(parent.id, 'downstream', 'worker', [{ id: upstream.id, kind: 'code' }], 'downstream-change');
    await f.project.workspaces.ensure(downstream);
    const task = f.store.task(downstream.id);
    expect(task.base_commit).toBe(f.store.task(upstream.id).head_commit);
    expect(task.base_commit).not.toBe(input.anchor.commit);
    expect(f.store.branch(task.branch)).toMatchObject({ parent: f.store.task(upstream.id).branch });
    expect(f.store.history(downstream.id).find(row => row.type === 'workspace.created').data.stacked_on).toBe(upstream.id);
  } finally { await f.close(); }
});

test('anchoring refuses a detached HEAD, a project that is not a git root, and a taken branch name', async () => {
  const plain = fixture(); plain.project.stopping = true;
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    await expect(plain.project.workspaces.anchor(1)).rejects.toThrow('git worktree root');
    await git(f.root, 'checkout', '--detach');
    await expect(f.project.workspaces.anchor(1)).rejects.toThrow('detached HEAD');
    await git(f.root, 'checkout', 'main');
    await git(f.root, 'branch', `lush/${f.project.workspaces.namespace}/input-1-anchor`);
    await expect(f.project.workspaces.anchor(1)).rejects.toThrow('already exists');
    // 三次失败一条都不落库：没有分支记录被写成事实
    expect(f.store.branches()).toEqual([]);
  } finally { await f.close(); await plain.close(); }
});

test('a failed submit writes no input row and keeps buffered drafts', async () => {
  const f = fixture(); f.project.stopping = true;   // 故意不是 git 仓库
  try {
    f.project.draft('想法');
    await expect(f.project.submit('raw')).rejects.toThrow('git worktree root');
    await expect(f.project.commitDrafts()).rejects.toThrow('git worktree root');
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
    expect(f.store.get('SELECT count(*) AS n FROM tasks').n).toBe(0);
    expect(f.store.get('SELECT count(*) AS n FROM branches').n).toBe(0);
    expect(f.store.draftCount()).toBe(1);
    // input id 只往大走：两次尝试已经用掉 1 与 2，下一次提交仍然是干净的目录名
    expect(f.store.inputIdHigh()).toBe(2);
  } finally { await f.close(); }
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
    expect(outcomes[3].reason).toContain('is not the anchored commit');
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
