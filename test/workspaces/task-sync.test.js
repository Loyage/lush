import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import { methods } from '../../src/core/workspaces/task-sync.js';

async function setup() {
  const f = fixture(); f.project.stopping = true;
  Object.assign(f.project.workspaces, methods); await repo(f.root);
  const { task } = await f.project.say('sync');
  f.store.update(task.id, { status: 'waiting' });
  fs.writeFileSync(path.join(f.root, 'parent.txt'), 'parent\n');
  await git(f.root, 'add', 'parent.txt'); await git(f.root, 'commit', '-m', 'parent');
  return { ...f, task, source: task.base_commit, parent: await git(f.root, 'rev-parse', 'HEAD') };
}

test('Git intermediate state blocks even a clean Task worktree', async () => {
  const f = await setup();
  try {
    const dir = await git(f.task.workspace, 'rev-parse', '--absolute-git-dir');
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_START']) {
      fs.writeFileSync(path.join(dir, marker), f.parent + '\n');
      await expect(f.project.workspaces.syncTaskParentUnsafe(f.task, f.source, f.parent)).rejects.toThrow('Git');
      fs.unlinkSync(path.join(dir, marker));
    }
    fs.mkdirSync(path.join(dir, 'rebase-merge'));
    fs.writeFileSync(path.join(dir, 'rebase-merge', 'head-name'), `refs/heads/${f.task.branch}\n`);
    await expect(f.project.workspaces.syncTaskParentUnsafe(f.task, f.source, f.parent)).rejects.toThrow('Git');
  } finally { await f.close(); }
});

test('fixed refs are rechecked after object merge; parent movement leaves the source untouched', async () => {
  const f = await setup();
  try {
    const original = f.project.workspaces.taskSyncBase;
    f.project.workspaces.taskSyncBase = async function(...args) {
      const base = await original.apply(this, args);
      await git(f.root, 'commit', '--allow-empty', '-m', 'external parent movement');
      return base;
    };
    await expect(f.project.workspaces.syncTaskParentUnsafe(f.task, f.source, f.parent)).rejects.toThrow('parent ref moved');
    expect(await git(f.task.workspace, 'rev-parse', 'HEAD')).toBe(f.source);
    expect(await git(f.task.workspace, 'status', '--porcelain')).toBe('');
  } finally { await f.close(); }
});

test('source movement between validation and write cannot be overwritten by ff-only', async () => {
  const f = await setup();
  try {
    const original = f.project.workspaces.git;
    let external;
    f.project.workspaces.git = async function(cwd, ...args) {
      if (cwd === f.task.workspace && args.includes('--ff-only')) {
        await git(cwd, 'commit', '--allow-empty', '-m', 'external source advance');
        external = await git(cwd, 'rev-parse', 'HEAD');
      }
      return original.call(this, cwd, ...args);
    };
    await expect(f.project.workspaces.syncTaskParentUnsafe(f.task, f.source, f.parent)).rejects.toThrow();
    expect(await git(f.task.workspace, 'rev-parse', 'HEAD')).toBe(external);
    expect(await git(f.task.workspace, 'status', '--porcelain')).toBe('');
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.parent);
  } finally { await f.close(); }
});

test('parent is ref-locked during ff-only source write; failures release the lock', async () => {
  const f = await setup();
  try {
    const original = f.project.workspaces.git;
    let attempted = false;
    f.project.workspaces.git = async function(cwd, ...args) {
      if (cwd === f.task.workspace && args.includes('--ff-only')) {
        attempted = true;
        const other = await git(f.root, 'commit-tree', await git(f.root, 'rev-parse', 'HEAD^{tree}'), '-p', f.parent, '-m', 'outside');
        await expect(git(f.root, 'update-ref', 'refs/heads/main', other, f.parent)).rejects.toThrow('lock');
        throw new Error('simulated write failure');
      }
      return original.call(this, cwd, ...args);
    };
    await expect(f.project.workspaces.syncTaskParentUnsafe(f.task, f.source, f.parent)).rejects.toThrow('simulated write failure');
    expect(attempted).toBe(true);
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.parent);
    expect(await git(f.task.workspace, 'rev-parse', 'HEAD')).toBe(f.source);
    expect(await git(f.task.workspace, 'status', '--porcelain')).toBe('');
    await git(f.root, 'update-ref', 'refs/heads/main', f.parent, f.parent);
  } finally { await f.close(); }
});

test('delivered awaiting_acceptance owner is settled but pending work remains a branch blocker', async () => {
  const f = await setup();
  try {
    f.store.update(f.task.id, { status: 'awaiting_acceptance', integration: 'merged' });
    expect(f.project.workspaces.branchTaskBlockers(f.task.branch)).toEqual([]);
    f.store.update(f.task.id, { integration: 'pending' });
    expect(f.project.workspaces.branchTaskBlockers(f.task.branch)).toEqual([`task:#${f.task.id}`]);
  } finally { await f.close(); }
});

test('Squash landed projection reads historical receipt after its reservation was replaced', async () => {
  const f = await setup();
  try {
    fs.writeFileSync(path.join(f.task.workspace, 'source.txt'), 'source');
    await git(f.task.workspace, 'add', 'source.txt'); await git(f.task.workspace, 'commit', '-m', 'source');
    const source = await git(f.task.workspace, 'rev-parse', 'HEAD');
    const commit = await git(f.root, 'commit-tree', await git(f.task.workspace, 'rev-parse', 'HEAD^{tree}'), '-p', f.parent, '-m', 'squash');
    await git(f.root, 'merge', '--ff-only', commit);
    f.store.event(f.task.id, 'task.merge_integrated', { source_commit: source, commit, parent_id: f.task.parent_id, squash: true });
    f.store.update(f.task.id, { reservation: null });
    expect(await f.project.workspaces.squashedLanded(f.task.branch, commit)).toBe(true);
    await git(f.task.workspace, 'commit', '--allow-empty', '-m', 'next iteration');
    expect(await f.project.workspaces.squashedLanded(f.task.branch, commit)).toBe(false);
  } finally { await f.close(); }
});
