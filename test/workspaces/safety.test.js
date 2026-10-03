import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../../src/config.js';
import { Store } from '../../src/persistence/store.js';
import { Workspaces } from '../../src/core/workspaces.js';
import { HANDLERS } from '../../src/rpc/dispatcher.js';
import { assertAllowed } from '../../src/rpc/registry.js';
import { env } from '../helpers.js';

// Exercise this boundary without constructing a Project fixture.
async function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-safety-')));
  const config = new Config({ project: root, env: env() }); config.prepare();
  const store = new Store(path.join(config.home, 'project.db'), root);
  const workspaces = new Workspaces(config, store);
  const git = (...args) => workspaces.git(root, ...args);
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Lush Test'); await git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, '.gitignore'), '.lush/\n');
  fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
  await git('add', '.'); await git('commit', '-m', 'initial');
  const commit = await git('rev-parse', 'HEAD');
  return { root, config, store, workspaces, git, commit,
    close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

async function legacyTask(f, branch = 'feature') {
  // Fixtures represent existing rows, not a retired creation API.
  const task = f.store.create({ role: 'worker', input_id: null, goal: 'historical' });
  const workspace = path.join(f.config.home, 'worktrees', `legacy-${task.id}`);
  const baseline = workspace + '-base';
  const snapshot = JSON.stringify({ branch, commit: f.commit, baseline_commit: f.commit });
  f.store.run("UPDATE tasks SET role='showcase',task_kind='showcase',status='completed',integration='none',showcase=?,workspace=?,baseline_workspace=? WHERE id=?",
    snapshot, workspace, baseline, task.id);
  await f.git('worktree', 'add', '--detach', workspace, f.commit);
  await f.git('worktree', 'add', '--detach', baseline, f.commit);
  return f.store.task(task.id);
}

test('commitTree compares fixed trees, validates hashes and keeps a bounded cache', async () => {
  const f = await setup();
  try {
    const tree = await f.git('rev-parse', 'HEAD^{tree}');
    await f.git('commit', '--allow-empty', '-m', 'same tree');
    const second = await f.git('rev-parse', 'HEAD');
    expect(await f.workspaces.commitTree(f.commit)).toBe(tree);
    expect(await f.workspaces.commitTree(second)).toBe(tree);
    await expect(f.workspaces.commitTree('main')).rejects.toThrow('invalid commit');
    const original = f.workspaces.git;
    let calls = 0;
    f.workspaces.git = async function(...args) { calls++; return original.apply(this, args); };
    await f.workspaces.commitTree(f.commit); expect(calls).toBe(0);
    f.workspaces.git = async () => { calls++; return tree; };
    for (let n = 1; n <= 401; n++) await f.workspaces.commitTree(n.toString(16).padStart(40, '0'));
    f.workspaces.git = async function(...args) { calls++; return original.apply(this, args); };
    const before = calls;
    await f.workspaces.commitTree(f.commit); expect(calls).toBe(before + 1);
  } finally { f.close(); }
});

test('assertCleanBranches preserves dirty, unrelated and Git intermediate-state gates', async () => {
  const f = await setup();
  try {
    await f.workspaces.assertCleanBranches(['main']);
    fs.writeFileSync(path.join(f.root, 'dirty.txt'), 'keep');
    await expect(f.workspaces.assertCleanBranches(['main'])).rejects.toThrow('未提交');
    await f.workspaces.assertCleanBranches(['other']);
    fs.unlinkSync(path.join(f.root, 'dirty.txt'));
    const gitDir = await f.git('rev-parse', '--absolute-git-dir');
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_START']) {
      fs.writeFileSync(path.join(gitDir, marker), f.commit + '\n');
      await expect(f.workspaces.assertCleanBranches(['main'])).rejects.toThrow('Git');
      fs.unlinkSync(path.join(gitDir, marker));
    }
    for (const marker of ['rebase-merge', 'rebase-apply', 'sequencer']) {
      fs.mkdirSync(path.join(gitDir, marker));
      await expect(f.workspaces.assertCleanBranches(['main'])).rejects.toThrow('Git');
      fs.rmdirSync(path.join(gitDir, marker));
    }
    await f.git('checkout', '--detach', f.commit);
    const rebase = path.join(gitDir, 'rebase-merge'); fs.mkdirSync(rebase);
    fs.writeFileSync(path.join(rebase, 'head-name'), 'refs/heads/main\n');
    await expect(f.workspaces.assertCleanBranches(['main'])).rejects.toThrow('Git');
    await f.workspaces.assertCleanBranches(['other']);
  } finally { f.close(); }
});

test('showcase APIs are absent, creation is rejected and historical columns survive reopening', async () => {
  const f = await setup();
  try {
    for (const method of ['showcaseTree', 'showcaseCleanBranches', 'showcaseSnapshot', 'showcaseRepin', 'assertShowcaseCheckout', 'ensureShowcase'])
      expect(f.workspaces[method]).toBeUndefined();
    for (const method of ['setShowcase', 'setBranchShowcaseReservation', 'branchShowcaseReservations']) expect(f.store[method]).toBeUndefined();
    expect(Object.keys(HANDLERS).some(name => name.startsWith('showcase.'))).toBe(false);
    for (const name of ['start', 'reserve', 'unreserve', 'list', 'preview', 'stop'])
      expect(() => assertAllowed(`showcase.${name}`, {}, null)).toThrow('unknown method');
    expect(() => f.store.create({ role: 'showcase', goal: 'removed' })).toThrow('no longer supported');
    expect(() => f.store.create({ role: 'agent', task_kind: 'showcase', goal: 'removed' })).toThrow('no longer supported');
    const task = await legacyTask(f);
    f.store.recordBranch({ branch: 'feature', parent: 'main', created_from_commit: f.commit });
    const reservation = '{"version":1,"status":"pending"}';
    f.store.run('UPDATE branches SET showcase_reservation=? WHERE branch=?', reservation, 'feature');
    f.store.markBranchDeleted('feature');
    expect(f.store.branch('feature').showcase_reservation).toBe(reservation);
    expect(f.store.all("SELECT * FROM events WHERE type LIKE 'showcase.%'")).toEqual([]);
    const reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    try {
      expect(reopened.task(task.id).showcase).toBe(task.showcase);
      expect(reopened.task(task.id).workspace).toBe(task.workspace);
      expect(reopened.branch('feature').showcase_reservation).toBe(reservation);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('legacy detached worktrees cannot be ensured, finished, cleaned or reclaimed as ordinary tasks', async () => {
  const f = await setup();
  try {
    const task = await legacyTask(f);
    fs.writeFileSync(path.join(task.workspace, 'keep.txt'), 'valuable evidence');
    for (const action of [() => f.workspaces.ensure(task), () => f.workspaces.finish(task), () => f.workspaces.release(task), () => f.workspaces.cleanup(task.id),
      () => f.workspaces.removeBaseline(task.id), () => f.workspaces.dropBranch(task), () => f.workspaces.forkTaskUnsafe(task, 'main', f.commit)])
      await expect(action()).rejects.toThrow('legacy showcase');
    expect((await f.workspaces.reclaim([task]))[0]).toMatchObject({ worktree: 'kept' });
    expect(f.store.task(task.id)).toEqual(task);
    expect(fs.readFileSync(path.join(task.workspace, 'keep.txt'), 'utf8')).toBe('valuable evidence');
    expect(fs.existsSync(task.baseline_workspace)).toBe(true);
  } finally { f.close(); }
});

test('archive refuses retained legacy directories before deleting any branch, even with discard', async () => {
  const f = await setup();
  try {
    await f.git('branch', 'first'); await f.git('branch', 'feature');
    for (const branch of ['first', 'feature']) f.store.recordBranch({ branch, parent: 'main', created_from_commit: f.commit });
    const task = await legacyTask(f);
    for (const discard_worktree of [false, true]) {
      await expect(f.workspaces.archiveBranches(['first', 'feature'], { discard_worktree })).rejects.toThrow('legacy showcase');
      expect(await f.git('rev-parse', 'refs/heads/first')).toBe(f.commit);
      expect(await f.git('rev-parse', 'refs/heads/feature')).toBe(f.commit);
      expect(f.store.branch('first').status).toBe('active');
      expect(fs.existsSync(task.workspace)).toBe(true);
      expect(fs.existsSync(task.baseline_workspace)).toBe(true);
    }
    // A historical detached checkout switched to another branch is still protected.
    await f.workspaces.git(task.workspace, 'checkout', 'first');
    await expect(f.workspaces.archiveBranch('first', { discard_worktree: true })).rejects.toThrow('legacy showcase');
    expect(await f.git('rev-parse', 'refs/heads/first')).toBe(f.commit);
    await f.workspaces.git(task.workspace, 'checkout', '--detach', f.commit);
    // Unrelated, known ownership is safe; malformed ownership is not.
    await f.workspaces.archiveBranch('first');
    f.store.run('UPDATE tasks SET showcase=? WHERE id=?', 'broken JSON', task.id);
    await expect(f.workspaces.archiveBranch('feature')).rejects.toThrow('legacy showcase');
    expect(f.store.task(task.id).workspace).toBe(task.workspace);
    await f.git('worktree', 'remove', task.workspace); await f.git('worktree', 'remove', task.baseline_workspace);
    expect((await f.workspaces.archiveBranch('feature')).ref).toBe('deleted');
    // Archive never rewrites legacy pointers or snapshots, even after manual removal.
    expect(f.store.task(task.id).showcase).toBe('broken JSON');
    expect(f.store.task(task.id).workspace).toBe(task.workspace);
  } finally { f.close(); }
});
