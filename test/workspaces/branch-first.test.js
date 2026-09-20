import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';

function host(f, inputId) {
  const task = f.store.create({ input_id: inputId, role: 'coordinator', goal: 'host' });
  f.store.update(task.id, { status: 'waiting' });
  return task;
}

async function complete(f, task, file) {
  const cwd = await f.project.workspaces.ensure(task);
  fs.writeFileSync(path.join(cwd, file), `${file}\n`);
  await git(cwd, 'add', file); await git(cwd, 'commit', '-m', file);
  await f.project.workspaces.finish(f.store.task(task.id));
  f.store.update(task.id, { status: 'completed' });
  return f.store.task(task.id);
}

test('sibling branches aggregate through ff-only and divergence creates a child-side sync task', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const input = await f.project.submit('parallel work');
    const parent = host(f, input.id);
    expect((await f.project.workspaces.branchState(input.anchor.branch)).blockers)
      .toEqual(expect.arrayContaining([`task:#${input.task.id}`, `task:#${parent.id}`]));
    const first = await complete(f, f.project.spawn(parent.id, 'first', 'worker', [], 'first'), 'first.txt');
    const second = await complete(f, f.project.spawn(parent.id, 'second', 'worker', [], 'second'), 'second.txt');

    expect((await f.project.approveBranchMerge(first.branch)).merged).toBe(true);
    expect(fs.existsSync(path.join(input.anchor.workspace, 'first.txt'))).toBe(true);
    const state = await f.project.workspaces.branchState(second.branch);
    expect(state).toMatchObject({ parent: input.anchor.branch, status: 'diverged', ahead: 1, behind: 1 });
    expect((await f.project.approveBranchMerge(second.branch)).needs_sync).toBe(true);

    const sync = await f.project.syncBranch(second.branch);
    expect(sync).toMatchObject({ status: 'queued', branch: second.branch, parent: input.anchor.branch });
    expect(sync.task).toMatchObject({ role: 'merger', base_commit: state.child_head, target_branch: second.branch });
    const event = f.store.history(sync.task.id).find(row => row.type === 'branch.sync.requested');
    expect(event.data).toMatchObject({ child: second.branch, parent: input.anchor.branch,
      child_commit: state.child_head, parent_commit: state.parent_head });
    const again = await f.project.syncBranch(second.branch);
    expect(again).toMatchObject({ status: 'existing', task: { id: sync.task.id } });
  } finally { await f.close(); }
});

test('落后的子分支可以 fast-forward 跟上父分支；领先与分歧时拒绝', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    // 没干活的输入锚点：创建后父分支前进了，它自己没有独有提交 —— 这就是「落后」。
    const behind = await f.project.submit('behind input');
    f.store.update(behind.task.id, { status: 'completed' });
    fs.writeFileSync(path.join(f.root, 'outside.txt'), 'outside\n');
    await git(f.root, 'add', 'outside.txt'); await git(f.root, 'commit', '-m', 'outside work');

    const state = await f.project.workspaces.branchState(behind.anchor.branch);
    expect(state).toMatchObject({ parent: 'main', status: 'integrated', ahead: 0, behind: 1, blockers: [] });
    expect(await f.project.catchupBranch(behind.anchor.branch))
      .toMatchObject({ caught_up: true, parent: 'main', to: state.parent_head, merged: false });
    // 快进只推进子分支：两边顶端一致，父分支不动，再来一次是幂等的。
    expect(await git(f.root, 'rev-parse', `refs/heads/${behind.anchor.branch}`)).toBe(state.parent_head);
    expect(await git(f.root, 'rev-parse', 'refs/heads/main')).toBe(state.parent_head);
    expect(await f.project.catchupBranch(behind.anchor.branch)).toMatchObject({ caught_up: false, already_integrated: true });
    expect(f.store.history(behind.task.id).some(row => row.type === 'branch.caught_up')).toBe(true);

    // 领先（自己的提交还没上去）不是 catch up 的活 —— 那是 branch.merge。
    const input = await f.project.submit('ahead input');
    f.store.update(input.task.id, { status: 'completed' });
    const parent = host(f, input.id);
    const pending = await complete(f, f.project.spawn(parent.id, 'pending', 'worker', [], 'pending'), 'pending.txt');
    expect((await f.project.workspaces.branchState(pending.branch)).status).toBe('fast_forward');
    await expect(f.project.catchupBranch(pending.branch)).rejects.toThrow('it is fast_forward');

    // 同一个锚点下的兄弟分支：合掉一条，另一条就与父分支分歧 —— 那该走 branch.sync。
    const first = await complete(f, f.project.spawn(parent.id, 'first', 'worker', [], 'first'), 'first.txt');
    const second = await complete(f, f.project.spawn(parent.id, 'second', 'worker', [], 'second'), 'second.txt');
    await f.project.approveBranchMerge(first.branch);
    expect((await f.project.workspaces.branchState(second.branch)).status).toBe('diverged');
    await expect(f.project.catchupBranch(second.branch)).rejects.toThrow('it is diverged');
  } finally { await f.close(); }
});

test('a branch cannot move upward while a direct child is still unintegrated', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const input = await f.project.submit('stacked work');
    const parent = host(f, input.id);
    const upstream = await complete(f, f.project.spawn(parent.id, 'upstream', 'worker', [], 'upstream'), 'upstream.txt');
    const downstream = await complete(f, f.project.spawn(parent.id, 'downstream', 'worker', [{ id: upstream.id, kind: 'code' }], 'downstream'), 'downstream.txt');

    const blocked = await f.project.workspaces.branchState(upstream.branch);
    expect(blocked.blockers).toEqual([downstream.branch]);
    // 有未收拢的直接子分支时，快进同样拒绝（拒绝理由与 branch.merge 一致）。
    await expect(f.project.catchupBranch(upstream.branch)).rejects.toThrow('blocked by unintegrated child branches');
    const ladder = await f.project.ladder();
    const upstreamItem = ladder.groups.flatMap(group => group.items).find(item => item.id === upstream.id);
    const downstreamItem = ladder.groups.flatMap(group => group.items).find(item => item.id === downstream.id);
    expect(upstreamItem.blockers).toContainEqual(expect.objectContaining({ code: 'branch_children' }));
    expect(upstreamItem.ready).toBe(false);
    expect(downstreamItem.ready).toBe(true);
    await expect(f.project.approveBranchMerge(upstream.branch)).rejects.toThrow('unintegrated child branches');
    await f.project.approveBranchMerge(downstream.branch);
    expect((await f.project.approveBranchMerge(upstream.branch)).merged).toBe(true);
  } finally { await f.close(); }
});
