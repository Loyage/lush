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

test('a branch cannot move upward while a direct child is still unintegrated', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const input = await f.project.submit('stacked work');
    const parent = host(f, input.id);
    const upstream = await complete(f, f.project.spawn(parent.id, 'upstream', 'worker', [], 'upstream'), 'upstream.txt');
    const downstream = await complete(f, f.project.spawn(parent.id, 'downstream', 'worker', [{ id: upstream.id, kind: 'code' }], 'downstream'), 'downstream.txt');

    const blocked = await f.project.workspaces.branchState(upstream.branch);
    expect(blocked.blockers).toEqual([downstream.branch]);
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
