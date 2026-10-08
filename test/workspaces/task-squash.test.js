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

test('parent checkout in another worktree is synchronized while unrelated canonical dirt is preserved', async () => {
  const f = await setup({ checkedOut: false });
  try {
    const parentWorkspace = path.join(f.config.home, 'worktrees', 'parent');
    await git(f.root, 'worktree', 'add', parentWorkspace, 'main');
    fs.writeFileSync(path.join(f.root, 'keep.txt'), 'unrelated user data\n');
    const receipt = await f.prepare();
    expect(receipt.workspace).toBe(parentWorkspace);
    await f.apply(receipt);
    expect(await git(parentWorkspace, 'rev-parse', 'HEAD')).toBe(receipt.commit);
    expect(await git(parentWorkspace, 'status', '--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(parentWorkspace, 'file.txt'), 'utf8')).toBe('source second\n');
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseline);
    expect(fs.readFileSync(path.join(f.root, 'keep.txt'), 'utf8')).toBe('unrelated user data\n');
    expect(await f.workspaces.verifyTaskSquashUnsafe(receipt)).toBe(true);
  } finally { f.close(); }
});

test('cancellation/new input after asynchronous checks prevents the first write and releases both refs', async () => {
  for (const checkedOut of [true, false]) {
    const f = await setup({ checkedOut });
    try {
      const receipt = await f.prepare();
      const original = f.workspaces.assertCleanBranches;
      let cancel = false;
      f.workspaces.assertCleanBranches = async function(...args) {
        await original.apply(this, args);
        cancel = true;
      };
      let guarded = false;
      await expect(f.apply(receipt, () => { guarded = true; return !cancel; })).rejects.toThrow('cancelled');
      expect(guarded).toBe(true);
      await assertUnwritten(f);
      await git(f.root, 'update-ref', 'refs/heads/main', f.baseline, f.baseline);
      await git(f.root, 'update-ref', `refs/heads/${f.child}`, f.source, f.source);
    } finally { f.close(); }
  }
});

test('guard throw and asynchronous guard are rejected without touching checkout/ref', async () => {
  const f = await setup();
  try {
    const receipt = await f.prepare();
    await expect(f.apply(receipt, () => { throw new Error('stale attempt'); })).rejects.toThrow('stale attempt');
    await assertUnwritten(f);
    await expect(f.apply(receipt, async () => true)).rejects.toThrow('synchronous');
    await assertUnwritten(f);
  } finally { f.close(); }
});

test('cancellation after checkout synchronization preserves staged evidence and never advances parent', async () => {
  const f = await setup();
  try {
    const receipt = await f.prepare();
    const original = f.workspaces.git;
    let cancel = false;
    f.workspaces.git = async function(cwd, ...args) {
      const result = await original.call(this, cwd, ...args);
      if (cwd === f.root && args[0] === 'read-tree') cancel = true;
      return result;
    };
    await expect(f.apply(receipt, () => !cancel)).rejects.toThrow('cancelled');
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseline);
    expect(await git(f.root, 'write-tree')).toBe(receipt.tree);
    expect(await git(f.root, 'status', '--porcelain')).toBe('M  file.txt');
    expect(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8')).toBe('source second\n');
    expect(await f.workspaces.verifyTaskSquashUnsafe(receipt)).toBe(false);
    await expect(f.apply(receipt)).rejects.toThrow('未提交');
    expect(await git(f.root, 'status', '--porcelain')).toBe('M  file.txt');
    // Both ref locks are released, but runtime must not release its blocked-parent execution slot.
    await git(f.root, 'update-ref', 'refs/heads/main', f.baseline, f.baseline);
    await git(f.root, 'update-ref', `refs/heads/${f.child}`, f.source, f.source);
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

test('prepared ref transaction excludes external source and target writes during checkout sync', async () => {
  const f = await setup();
  try {
    const receipt = await f.prepare();
    const original = f.workspaces.git;
    let checked = false;
    f.workspaces.git = async function(cwd, ...args) {
      if (cwd === f.root && args[0] === 'read-tree') {
        const external = await git(f.root, 'commit-tree', receipt.tree, '-p', f.baseline, '-m', 'outside');
        await expect(git(f.root, 'update-ref', 'refs/heads/main', external, f.baseline)).rejects.toThrow('lock');
        await expect(git(f.root, 'update-ref', `refs/heads/${f.child}`, external, f.source)).rejects.toThrow('lock');
        checked = true;
      }
      return original.call(this, cwd, ...args);
    };
    await f.apply(receipt);
    expect(checked).toBe(true);
    expect(await f.workspaces.verifyTaskSquashUnsafe(receipt)).toBe(true);
  } finally { f.close(); }
});

test('dirty source/target and clean Git intermediate states block apply without discarding user data', async () => {
  for (const target of ['source', 'parent']) {
    for (const dirt of ['unstaged', 'staged', 'untracked', 'merge']) {
      const f = await setup();
      try {
        const receipt = await f.prepare();
        const cwd = target === 'source' ? f.workspace : f.root;
        let file;
        if (dirt === 'merge') {
          file = path.join(await git(cwd, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD');
          fs.writeFileSync(file, f.source + '\n');
        } else {
          file = path.join(cwd, dirt === 'untracked' ? 'valuable.txt' : 'file.txt');
          fs.writeFileSync(file, 'valuable user data\n');
          if (dirt === 'staged') await git(cwd, 'add', 'file.txt');
        }
        const status = await git(cwd, 'status', '--porcelain');
        const contents = fs.readFileSync(file, 'utf8');
        await expect(f.apply(receipt)).rejects.toThrow(dirt === 'merge' ? 'Git' : '未提交');
        expect(await git(f.root, 'rev-parse', 'refs/heads/main')).toBe(f.baseline);
        expect(await git(cwd, 'status', '--porcelain')).toBe(status);
        expect(fs.readFileSync(file, 'utf8')).toBe(contents);
      } finally { f.close(); }
    }
  }
});

test('late external worktree dirt is rejected by read-tree, not overwritten by a reset', async () => {
  const f = await setup();
  try {
    const receipt = await f.prepare();
    const original = f.workspaces.git;
    f.workspaces.git = async function(cwd, ...args) {
      if (cwd === f.root && args[0] === 'read-tree') fs.writeFileSync(path.join(cwd, 'file.txt'), 'late user data\n');
      return original.call(this, cwd, ...args);
    };
    await expect(f.apply(receipt)).rejects.toThrow();
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseline);
    expect(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8')).toBe('late user data\n');
    expect(await git(f.root, 'status', '--porcelain')).toBe('M file.txt');
  } finally { f.close(); }
});

test('unintegrated descendants and unrepaired divergence block preparation, repaired source lands one parent', async () => {
  const f = await setup();
  try {
    await git(f.workspace, 'branch', 'nested', f.source);
    f.store.recordBranch({ branch: 'nested', parent: f.child, created_from_commit: f.source });
    const nestedTree = await git(f.root, 'rev-parse', `${f.baseline}^{tree}`);
    const nested = await git(f.root, 'commit-tree', nestedTree, '-p', f.source, '-m', 'unintegrated nested work');
    await git(f.root, 'update-ref', 'refs/heads/nested', nested, f.source);
    await expect(f.prepare()).rejects.toThrow('descendant');
    // Explicit fixture cleanup, not runtime discard: mark this known synthetic ref as archived.
    f.store.markBranchArchived('nested');
    fs.writeFileSync(path.join(f.root, 'parent.txt'), 'parent changes\n');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'parent advances');
    const parent = await git(f.root, 'rev-parse', 'HEAD');
    await expect(f.workspaces.prepareTaskSquashUnsafe(f.child, f.source, parent, 'delivery')).rejects.toThrow('diverged');
    expect(await git(f.workspace, 'rev-parse', 'HEAD')).toBe(f.source);
    await git(f.workspace, 'merge', '--no-ff', '--no-edit', parent);
    const repaired = await git(f.workspace, 'rev-parse', 'HEAD');
    const receipt = await f.workspaces.exclusive(() => f.workspaces.prepareTaskSquashUnsafe(f.child, repaired, parent, 'repaired delivery'));
    await f.apply(receipt);
    expect(await git(f.root, 'show', '-s', '--format=%P', 'HEAD')).toBe(parent);
    expect(await git(f.root, 'rev-parse', 'HEAD^{tree}')).toBe(await git(f.workspace, 'rev-parse', 'HEAD^{tree}'));
    expect(await f.workspaces.verifyTaskSquashUnsafe(receipt)).toBe(true);
  } finally { f.close(); }
});

test('descendant appearing after preparation blocks apply, with no checkout/ref side effects', async () => {
  const f = await setup();
  try {
    const receipt = await f.prepare();
    const nested = await git(f.root, 'commit-tree', receipt.tree, '-p', f.source, '-m', 'new child work');
    await git(f.root, 'branch', 'nested', nested);
    f.store.recordBranch({ branch: 'nested', parent: f.child, created_from_commit: f.source });
    await expect(f.apply(receipt)).rejects.toThrow('descendant');
    await assertUnwritten(f);
  } finally { f.close(); }
});

test('apply rejects changed checkout location and precise tree/parent credentials', async () => {
  const f = await setup();
  try {
    const receipt = await f.prepare();
    await expect(f.apply({ ...receipt, tree: await git(f.root, 'rev-parse', 'HEAD^{tree}') })).rejects.toThrow('exact single-parent');
    await expect(f.apply({ ...receipt, baseline: f.source })).rejects.toThrow('exact single-parent');
    await expect(f.apply({ ...receipt, workspace: null })).rejects.toThrow('worktree changed');
    await git(f.root, 'checkout', '-b', 'elsewhere', f.baseline);
    await expect(f.apply(receipt)).rejects.toThrow('worktree changed');
    expect(await git(f.root, 'rev-parse', 'refs/heads/main')).toBe(f.baseline);
  } finally { f.close(); }
});

test('verify proves exact SHA, single parent and source tree; equivalent commit/title is not recovery', async () => {
  const f = await setup();
  try {
    const receipt = await f.prepare();
    const equivalent = await git(f.root, '-c', 'user.name=Someone Else', 'commit-tree', receipt.tree, '-p', f.baseline, '-m', 'Task delivery\n\nfull title');
    expect(equivalent).not.toBe(receipt.commit);
    await git(f.root, 'merge', '--ff-only', equivalent);
    expect(await f.workspaces.verifyTaskSquashUnsafe(receipt)).toBe(false);
    const multiple = await git(f.root, 'commit-tree', receipt.tree, '-p', f.baseline, '-p', f.source, '-m', 'Task delivery');
    // Simulate an external ref rewrite; both commits have the same tree, so the checkout stays clean.
    await git(f.root, 'update-ref', 'refs/heads/main', multiple, equivalent);
    expect(await f.workspaces.verifyTaskSquashUnsafe({ ...receipt, commit: multiple })).toBe(false);
    expect(await f.workspaces.verifyTaskSquashUnsafe({ ...receipt, commit: equivalent, tree: f.source })).toBe(false);
    expect(await f.workspaces.verifyTaskSquashUnsafe(null)).toBe(false);
    // No recovery check ever changes ref/index/worktree.
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(multiple);
    expect(await git(f.root, 'status', '--porcelain')).toBe('');
  } finally { f.close(); }
});

test('exact recovery accepts later target commits but not a dirty or intermediate-state target', async () => {
  const f = await setup();
  try {
    const receipt = await f.prepare(); await f.apply(receipt);
    fs.writeFileSync(path.join(f.root, 'later.txt'), 'later parent development\n');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'later parent');
    await git(f.workspace, 'commit', '--allow-empty', '-m', 'later source iteration');
    expect(await f.workspaces.verifyTaskSquashUnsafe(receipt)).toBe(true);
    fs.writeFileSync(path.join(f.root, 'keep.txt'), 'uncommitted\n');
    expect(await f.workspaces.verifyTaskSquashUnsafe(receipt)).toBe(false);
    expect(fs.readFileSync(path.join(f.root, 'keep.txt'), 'utf8')).toBe('uncommitted\n');
    fs.unlinkSync(path.join(f.root, 'keep.txt'));
    const marker = path.join(await git(f.root, 'rev-parse', '--absolute-git-dir'), 'CHERRY_PICK_HEAD');
    fs.writeFileSync(marker, receipt.commit + '\n');
    expect(await f.workspaces.verifyTaskSquashUnsafe(receipt)).toBe(false);
    fs.unlinkSync(marker);
    expect(await f.workspaces.verifyTaskSquashUnsafe(receipt)).toBe(true);
  } finally { f.close(); }
});
