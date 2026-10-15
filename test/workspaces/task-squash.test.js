import { test, expect, setDefaultTimeout } from 'bun:test';
// Each safety case performs several real Git transactions and retains/cleans its own fixture.
setDefaultTimeout(15000);
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../../src/config.js';
import { Store } from '../../src/persistence/store.js';
import { Workspaces } from '../../src/core/workspaces.js';
import { temp, env, repo, git } from '../helpers.js';

// Real Git objects/worktrees; no daemon or scheduling side effects at this boundary.
async function setup({ checkedOut = true } = {}) {
  const root = temp();
  const config = new Config({ project: root, env: env() }); config.prepare();
  const store = new Store(path.join(config.home, 'project.db'), root);
  const workspaces = new Workspaces(config, store);
  try {
    await repo(root);
    const baseline = await git(root, 'rev-parse', 'HEAD');
    const child = 'feature';
    const workspace = path.join(config.home, 'worktrees', child);
    await git(root, 'worktree', 'add', '-b', child, workspace, baseline);
    store.recordBranch({ branch: child, parent: 'main', created_from_commit: baseline });
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'source first\n');
    await git(workspace, 'add', '.'); await git(workspace, 'commit', '-m', 'first source');
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'source second\n');
    await git(workspace, 'add', '.'); await git(workspace, 'commit', '-m', 'second source');
    const source = await git(workspace, 'rev-parse', 'HEAD');
    if (!checkedOut) await git(root, 'checkout', '-b', 'unrelated', baseline);
    return { root, config, store, workspaces, baseline, child, workspace, source,
      prepare: () => workspaces.exclusive(() => workspaces.prepareTaskSquashUnsafe(child, source, baseline, 'Task delivery\n\nfull title')),
      apply: (receipt, guard = () => {}) => workspaces.exclusive(() => workspaces.applyTaskSquashUnsafe(receipt, guard)),
      close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { store.close(); fs.rmSync(root, { recursive: true, force: true }); throw error; }
}

async function assertUnwritten(f) {
  expect(await git(f.root, 'rev-parse', 'refs/heads/main')).toBe(f.baseline);
  expect(await git(f.root, 'status', '--porcelain')).toBe('');
  expect(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8')).toBe('base\n');
  expect(await git(f.workspace, 'rev-parse', 'HEAD')).toBe(f.source);
}

test('prepare is object-only; persisted receipt applies exactly one known commit without hooks', async () => {
  const f = await setup();
  try {
    const receipt = await f.prepare();
    expect(receipt).toEqual({ child: f.child, source: f.source, baseline: f.baseline, commit: receipt.commit,
      tree: await git(f.workspace, 'rev-parse', 'HEAD^{tree}'), parent: 'main', workspace: f.root });
    await assertUnwritten(f);
    expect(await f.workspaces.verifyTaskSquashUnsafe(receipt)).toBe(false);
    // Simulate runtime's Git/DB boundary: persist exact SHA before any checkout/ref change.
    f.store.event(null, 'test.prepared', receipt);
    const saved = JSON.parse(f.store.get("SELECT data FROM events WHERE type='test.prepared'").data);
    const hooks = path.join(f.root, '.git', 'hooks');
    for (const name of ['post-merge', 'pre-commit', 'post-commit', 'reference-transaction']) {
      fs.writeFileSync(path.join(hooks, name), '#!/bin/sh\nprintf hook > hook-ran.txt\n', { mode: 0o755 });
    }
    const watch = await f.workspaces.watchBranch('main');
    expect(await f.apply(saved)).toEqual(saved);
    expect(await f.workspaces.checkWatchedBranch(watch)).toMatchObject({ before: f.baseline, after: saved.commit, explained: true });
    expect(watch.transitions).toEqual([{ before: f.baseline, after: saved.commit, source: { kind: 'daemon' } }]);
    f.workspaces.unwatchBranch(watch);
    expect(f.workspaces.refWrites.size).toBe(0);
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(saved.commit);
    expect(await git(f.root, 'show', '-s', '--format=%P', 'HEAD')).toBe(f.baseline);
    expect(await git(f.root, 'rev-list', '--count', `${f.baseline}..HEAD`)).toBe('1');
    expect(await git(f.root, 'rev-parse', 'HEAD^{tree}')).toBe(saved.tree);
    expect(await git(f.workspace, 'rev-parse', 'HEAD')).toBe(f.source);
    expect(await git(f.root, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(f.root, 'hook-ran.txt'))).toBe(false);
    // A new Workspaces instance can recover the DB-not-finalized window by proof only.
    const recovering = new Workspaces(f.config, f.store);
    expect(await recovering.verifyTaskSquashUnsafe(saved)).toBe(true);
    await expect(f.apply(saved)).rejects.toThrow('moved'); // apply is NOT an unknown-side-effect replay API
  } finally { f.close(); }
});

test('unchecked-out target uses the same exact CAS receipt without changing unrelated checkout', async () => {
  const f = await setup({ checkedOut: false });
  try {
    const receipt = await f.prepare(); expect(receipt.workspace).toBeNull();
    const index = await git(f.root, 'write-tree');
    const watch = await f.workspaces.watchBranch('main');
    await f.apply(receipt);
    expect((await f.workspaces.checkWatchedBranch(watch)).explained).toBe(true);
    f.workspaces.unwatchBranch(watch);
    expect(await git(f.root, 'rev-parse', 'refs/heads/main')).toBe(receipt.commit);
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseline);
    expect(await git(f.root, 'write-tree')).toBe(index);
    expect(await f.workspaces.verifyTaskSquashUnsafe(receipt)).toBe(true);
  } finally { f.close(); }
});

test('fixed source and parent drift invalidate prepared receipt, including drift after async ref checks', async () => {
  for (const branch of ['source', 'parent']) {
    const f = await setup();
    try {
      const receipt = await f.prepare();
      const cwd = branch === 'source' ? f.workspace : f.root;
      await git(cwd, 'commit', '--allow-empty', '-m', 'external drift');
      const external = await git(cwd, 'rev-parse', 'HEAD');
      await expect(f.apply(receipt)).rejects.toThrow('moved');
      expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(external);
      expect(await git(f.root, 'status', '--porcelain')).toBe('');
    } finally { f.close(); }
  }
  const f = await setup();
  try {
    const receipt = await f.prepare();
    const original = f.workspaces.assertCleanBranches;
    let external = null;
    f.workspaces.assertCleanBranches = async function(...args) {
      await original.apply(this, args);
      if (!external) {
        await git(f.workspace, 'commit', '--allow-empty', '-m', 'late source advance');
        external = await git(f.workspace, 'rev-parse', 'HEAD');
      }
    };
    await expect(f.apply(receipt)).rejects.toThrow('moved or locked');
    expect(await git(f.workspace, 'rev-parse', 'HEAD')).toBe(external);
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseline);
    expect(await git(f.root, 'status', '--porcelain')).toBe('');
  } finally { f.close(); }
});
