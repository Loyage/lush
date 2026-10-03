import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, gate } from '../helpers.js';
import projectSync from '../../src/core/project/task-sync.js';
import { methods as gitSync } from '../../src/core/workspaces/task-sync.js';

async function setup() {
  const f = fixture(); f.project.stopping = true;
  Object.assign(f.project, projectSync); Object.assign(f.project.workspaces, gitSync);
  await repo(f.root);
  const { task } = await f.project.order('sync');
  f.store.update(task.id, { status: 'awaiting_acceptance' });
  return { ...f, task: f.store.task(task.id) };
}
async function commit(cwd, file, text) {
  fs.writeFileSync(path.join(cwd, file), text);
  await git(cwd, 'add', file); await git(cwd, 'commit', '-m', file);
  return git(cwd, 'rev-parse', 'HEAD');
}

test('conflict-free synchronization preserves source history and never changes the parent', async () => {
  const f = await setup();
  try {
    const source = await commit(f.task.workspace, 'child.txt', 'child\n');
    const parent = await commit(f.root, 'parent.txt', 'parent\n');
    const out = await f.project.syncTaskParent(f.task.id);
    expect(out).toMatchObject({ synced: true, conflict: false, source_commit: source, parent_commit: parent });
    expect(out.task).toMatchObject({ status: 'waiting', integration: 'pending', base_commit: f.task.base_commit });
    const head = await git(f.task.workspace, 'rev-parse', 'HEAD');
    expect(out.task.head_commit).toBe(head);
    if ('iteration_base_commit' in out.task) expect(out.task.iteration_base_commit).toBe(parent);
    expect(await git(f.task.workspace, 'rev-list', '--parents', '-1', head)).toBe(`${head} ${source} ${parent}`);
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(parent);
    expect(await git(f.task.workspace, 'status', '--porcelain')).toBe('');
    expect((await f.project.syncTaskParent(f.task.id)).synced).toBe(false);
    expect(await git(f.task.workspace, 'rev-parse', 'HEAD')).toBe(head);
  } finally { await f.close(); }
});

test('catch-up with no task delta records equal trees as merged, keeping original fork point', async () => {
  const f = await setup();
  try {
    const parent = await commit(f.root, 'parent.txt', 'parent\n');
    const out = await f.project.syncTaskParent(f.task.id);
    expect(out.task).toMatchObject({ integration: 'merged', status: 'awaiting_acceptance' });
    expect(out.task.base_commit).toBe(f.task.base_commit);
    expect(await git(f.task.workspace, 'rev-parse', 'HEAD^{tree}')).toBe(await git(f.root, 'rev-parse', 'HEAD^{tree}'));
    expect(f.store.history(f.task.id).find(event => event.type === 'task.parent_synced').data.parent_commit).toBe(parent);
  } finally { await f.close(); }
});

test('successful synchronization preserves explicit pause regardless of whether new work remains', async () => {
  const f = await setup();
  try {
    f.store.update(f.task.id, { status: 'paused' });
    await commit(f.root, 'parent.txt', 'parent\n');
    const equal = await f.project.syncTaskParent(f.task.id);
    expect(equal.task).toMatchObject({ status: 'paused', integration: 'merged' });
    await commit(f.task.workspace, 'child.txt', 'child\n');
    await commit(f.root, 'other.txt', 'other\n');
    const pending = await f.project.syncTaskParent(f.task.id);
    expect(pending.task).toMatchObject({ status: 'paused', integration: 'pending' });
  } finally { await f.close(); }
});

test('conflicts are fixed diagnostics without dirty files or merge state; explicit resolve wakes only this Task', async () => {
  const f = await setup();
  try {
    const source = await commit(f.task.workspace, 'file.txt', 'source\n');
    const parent = await commit(f.root, 'file.txt', 'parent\n');
    const out = await f.project.syncTaskParent(f.task.id);
    expect(out).toMatchObject({ synced: false, conflict: true, source_commit: source, parent_commit: parent });
    expect(out.reason).toContain('file.txt');
    expect(await git(f.task.workspace, 'status', '--porcelain')).toBe('');
    expect(await git(f.task.workspace, 'rev-parse', 'HEAD')).toBe(source);
    expect(await f.project.workspaces.merging(f.task.workspace)).toBe(false);
    expect(f.store.unread(f.task.id)).toHaveLength(0);
    // A moved parent invalidates the diagnostic; user must explicitly synchronize again.
    const latest = await commit(f.root, 'later.txt', 'later\n');
    await expect(f.project.resolveTaskSync(f.task.id)).rejects.toThrow('parent moved');
    expect(f.store.unread(f.task.id)).toHaveLength(0);
    const refreshed = await f.project.syncTaskParent(f.task.id);
    expect(refreshed).toMatchObject({ conflict: true, parent_commit: latest });
    const before = f.store.all('SELECT id FROM tasks').length;
    const task = await f.project.resolveTaskSync(f.task.id);
    expect(task.status).toBe('queued');
    expect(f.store.all('SELECT id FROM tasks')).toHaveLength(before);
    expect(f.store.unread(task.id)[0].body).toContain(latest);
    expect(f.store.history(task.id).some(event => event.type === 'task.input_routed')).toBe(false);
    // A bad repair cannot be claimed as absorbed.
    await expect(f.project.settleTaskSyncResolution(task.id)).rejects.toThrow('both fixed');
    await git(task.workspace, 'merge', '--no-commit', latest).catch(() => {});
    await commit(task.workspace, 'file.txt', 'resolved\n');
    const head = await git(task.workspace, 'rev-parse', 'HEAD');
    expect(await f.project.settleTaskSyncResolution(task.id)).toBe(true);
    expect(await f.project.settleTaskSyncResolution(task.id)).toBe(false);
    expect(f.store.task(task.id).head_commit).toBe(head);
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(latest);
  } finally { await f.close(); }
});

test('Squash receipt avoids replaying already delivered changes and establishes real parent ancestry', async () => {
  const f = await setup();
  try {
    const delivered = await commit(f.task.workspace, 'file.txt', 'delivered\n');
    const tree = await git(f.task.workspace, 'rev-parse', 'HEAD^{tree}');
    const landed = await git(f.root, 'commit-tree', tree, '-p', f.task.base_commit, '-m', 'squash');
    await git(f.root, 'merge', '--ff-only', landed);
    f.store.event(f.task.id, 'task.merge_integrated', { source_commit: delivered, commit: landed, parent_id: f.task.parent_id, squash: true });
    const booking = JSON.stringify({ version: 2, kind: 'merge', status: 'integrated', commit: delivered,
      landed_commit: landed, parent_id: f.task.parent_id });
    f.store.update(f.task.id, { reservation: booking, integration: 'merged' });
    const parent = await commit(f.root, 'file.txt', 'parent subsequently changed delivery\n');
    const source = await commit(f.task.workspace, 'next.txt', 'next iteration\n');
    const out = await f.project.syncTaskParent(f.task.id);
    expect(out.conflict).toBe(false);
    expect(await git(f.task.workspace, 'show', 'HEAD:file.txt')).toBe('parent subsequently changed delivery');
    expect(await git(f.task.workspace, 'show', 'HEAD:next.txt')).toBe('next iteration');
    expect(await git(f.task.workspace, 'merge-base', '--is-ancestor', source, 'HEAD')).toBe('');
    expect(await git(f.task.workspace, 'merge-base', '--is-ancestor', parent, 'HEAD')).toBe('');
    expect(f.store.task(f.task.id).reservation).toBe(booking);
    // Sync once more: receipt must not replay changes absorbed in the last iteration.
    const parent2 = await commit(f.root, 'file.txt', 'parent third version\n');
    const out2 = await f.project.syncTaskParent(f.task.id);
    expect(out2.conflict).toBe(false);
    expect(await git(f.task.workspace, 'show', 'HEAD:file.txt')).toBe('parent third version');
    expect(out2.parent_commit).toBe(parent2);
  } finally { await f.close(); }
});

test('legacy integrated reservation is a safe fallback, but invalidated receipt never falls back to an old merge base', async () => {
  const f = await setup();
  try {
    const source = await commit(f.task.workspace, 'file.txt', 'delivered\n');
    const tree = await git(f.task.workspace, 'rev-parse', 'HEAD^{tree}');
    const landed = await git(f.root, 'commit-tree', tree, '-p', f.task.base_commit, '-m', 'squash');
    await git(f.root, 'merge', '--ff-only', landed);
    f.store.update(f.task.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'integrated',
      commit: source, landed_commit: landed, parent_id: f.task.parent_id }) });
    await commit(f.root, 'file.txt', 'changed\n');
    expect((await f.project.syncTaskParent(f.task.id)).conflict).toBe(false);
    f.store.event(f.task.id, 'task.merge_integrated', { source_commit: source, commit: landed, parent_id: 9999 });
    await expect(f.project.syncTaskParent(f.task.id)).rejects.toThrow('direct parent');
  } finally { await f.close(); }
});

test('running, queued, historical terminal, dirty, user decision, delivery and parent identity guards', async () => {
  const f = await setup();
  try {
    for (const status of ['running', 'queued', 'completed', 'cancelled', 'failed', 'awaiting']) {
      f.store.update(f.task.id, { status });
      await expect(f.project.syncTaskParent(f.task.id)).rejects.toThrow();
    }
    f.store.update(f.task.id, { status: 'awaiting_acceptance' });
    f.project.running.set(f.task.id, {});
    await expect(f.project.syncTaskParent(f.task.id)).rejects.toThrow('still running');
    f.project.running.delete(f.task.id);
    const parentDirt = path.join(f.root, 'dirty-parent.txt'); fs.writeFileSync(parentDirt, 'dirty');
    await expect(f.project.syncTaskParent(f.task.id)).rejects.toThrow('未提交'); fs.unlinkSync(parentDirt);
    const dirt = path.join(f.task.workspace, 'untracked.txt'); fs.writeFileSync(dirt, 'untracked');
    await expect(f.project.syncTaskParent(f.task.id)).rejects.toThrow('未提交'); fs.unlinkSync(dirt);
    f.store.update(f.task.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'requested' }) });
    await expect(f.project.syncTaskParent(f.task.id)).rejects.toThrow('frozen');
    f.store.update(f.task.id, { reservation: null });
    f.store.run("INSERT INTO notices(task_id,title,body,kind) VALUES (?, 'decision', '', 'question')", f.task.id);
    await expect(f.project.syncTaskParent(f.task.id)).rejects.toThrow('unanswered');
    f.store.run("UPDATE notices SET status='dismissed' WHERE task_id=?", f.task.id);
    f.store.update(f.task.id, { target_branch: 'somewhere' });
    await expect(f.project.syncTaskParent(f.task.id)).rejects.toThrow('identity');
  } finally { await f.close(); }
});

test('active descendants, idle-parent and parent delivery freeze prevent synchronization', async () => {
  const f = await setup();
  try {
    const child = f.store.create({ parent_id: f.task.id, role: 'agent', task_kind: 'child', goal: 'child' });
    await expect(f.project.syncTaskParent(f.task.id)).rejects.toThrow('active descendants');
    f.store.update(child.id, { status: 'cancelled' });
    f.store.update(f.task.parent_id, { status: 'running' });
    await expect(f.project.syncTaskParent(f.task.id)).rejects.toThrow('parent Worker');
    f.store.update(f.task.parent_id, { status: 'waiting' });
    const sibling = await f.project.order('sibling');
    f.store.update(sibling.task.id, { status: 'waiting', reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'requested',
      parent_id: f.task.parent_id, commit: f.task.base_commit, baseline: f.task.base_commit }) });
    await expect(f.project.syncTaskParent(f.task.id)).rejects.toThrow('frozen');
  } finally { await f.close(); }
});

test('failed actual Git write cannot update the database or manufacture a successful sync event', async () => {
  const f = await setup();
  try {
    await commit(f.root, 'parent.txt', 'parent\n');
    const original = f.project.workspaces.git;
    f.project.workspaces.git = async function(cwd, ...args) {
      if (cwd === f.task.workspace && args.includes('--ff-only')) throw new Error('actual write failed');
      return original.call(this, cwd, ...args);
    };
    await expect(f.project.syncTaskParent(f.task.id)).rejects.toThrow('actual write failed');
    expect(f.store.task(f.task.id).head_commit).toBe(f.task.head_commit);
    expect(f.store.history(f.task.id).some(event => event.type === 'task.parent_synced')).toBe(false);
    expect(f.project.taskSyncBusy.size).toBe(0);
  } finally { await f.close(); }
});

test('parallel requests are rejected while fixed Git work is underway, then retries are idempotent', async () => {
  const f = await setup(); const hold = gate(); const entered = gate();
  try {
    await commit(f.root, 'parent.txt', 'parent\n');
    const original = f.project.workspaces.syncTaskParentUnsafe;
    f.project.workspaces.syncTaskParentUnsafe = async function(...args) { entered.resolve(); await hold.promise; return original.apply(this, args); };
    const first = f.project.syncTaskParent(f.task.id);
    await entered.promise;
    expect(f.project.taskSyncBusy.has(f.task.id)).toBe(true);
    expect(f.project.taskSyncBusy.has(f.task.parent_id)).toBe(true);
    await expect(f.project.syncTaskParent(f.task.id)).rejects.toThrow('already in progress');
    hold.resolve(); expect((await first).synced).toBe(true);
    expect(f.project.taskSyncBusy.size).toBe(0);
    expect((await f.project.syncTaskParent(f.task.id)).synced).toBe(false);
  } finally { hold.resolve(); await f.close(); }
});
