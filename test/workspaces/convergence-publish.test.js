import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup, git } from './convergence-harness.js';

async function ready(options) {
  const f = await setup(options);
  try {
    await f.member('a', { 'a.txt': 'a\n' }); await f.member('b', { 'b.txt': 'b\n' });
    const root = await f.combine(), receipt = await f.prepare(root.tree);
    return { ...f, receipt };
  } catch (error) { f.close(); throw error; }
}

test('exact batch publish changes only target, one single-parent commit, and survives DB-not-settled recovery', async () => {
  const f = await ready();
  try {
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseline);
    for (const member of f.members) expect(await git(member.workspace, 'rev-parse', 'HEAD^{tree}')).not.toBe(f.receipt.tree);
    const hook = path.join(f.root, '.git', 'hooks', 'reference-transaction');
    fs.writeFileSync(hook, '#!/bin/sh\ntouch hook-ran\n', { mode: 0o755 });
    const watch = await f.workspaces.watchBranch('main');
    await f.apply(f.receipt);
    expect((await f.workspaces.checkWatchedBranch(watch)).explained).toBe(true); f.workspaces.unwatchBranch(watch);
    expect(await git(f.root, 'show', '-s', '--format=%P', 'HEAD')).toBe(f.baseline);
    expect(await git(f.root, 'rev-list', '--count', `${f.baseline}..HEAD`)).toBe('1');
    expect(await git(f.root, 'rev-parse', 'HEAD^{tree}')).toBe(f.receipt.tree);
    expect(await git(f.root, 'status', '--porcelain')).toBe(''); expect(fs.existsSync(path.join(f.root, 'hook-ran'))).toBe(false);
    expect(await f.workspaces.verifyConvergencePublishUnsafe(JSON.parse(JSON.stringify(f.receipt)))).toBe(true);
    for (const member of f.members) expect(await git(member.workspace, 'rev-parse', 'HEAD')).toBe(member.source_commit);
    await expect(f.apply(f.receipt)).rejects.toThrow('moved'); // Never blindly replay.
  } finally { f.close(); }
});

test('unchecked-out target and target in separate worktree preserve unrelated canonical state', async () => {
  for (const ownCheckout of [false, true]) {
    const f = await setup({ checkedOut: false });
    try {
      await f.member('a', { 'a.txt': 'a\n' });
      let target = null;
      if (ownCheckout) { target = path.join(f.config.home, 'worktrees', 'main'); await git(f.root, 'worktree', 'add', target, 'main'); }
      fs.writeFileSync(path.join(f.root, 'precious.txt'), 'user data');
      const root = await f.combine(), receipt = await f.prepare(root.tree); expect(receipt.workspace).toBe(target);
      await f.apply(receipt);
      expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseline);
      expect(fs.readFileSync(path.join(f.root, 'precious.txt'), 'utf8')).toBe('user data');
      expect(await f.workspaces.verifyConvergencePublishUnsafe(receipt)).toBe(true);
      if (target) expect(await git(target, 'rev-parse', 'HEAD')).toBe(receipt.commit);
    } finally { f.close(); }
  }
});

test('member and parent drift, wrong direct parent, duplicate member and forged commit are rejected', async () => {
  for (const kind of ['source', 'parent', 'owner', 'duplicate', 'commit']) {
    const f = await ready();
    try {
      let receipt = f.receipt;
      if (kind === 'source' || kind === 'parent') await git(kind === 'source' ? f.members[1].workspace : f.root,
        'commit', '--allow-empty', '-m', 'outside');
      if (kind === 'owner') f.store.run('UPDATE tasks SET parent_id=NULL WHERE id=?', f.members[0].task_id);
      if (kind === 'duplicate') receipt = { ...receipt, members: [...receipt.members, receipt.members[0]] };
      if (kind === 'commit') receipt = { ...receipt, commit: await git(f.root, 'commit-tree', receipt.tree, '-p', receipt.baseline,
        '-p', f.members[0].source_commit, '-m', 'forged') };
      await expect(f.apply(receipt)).rejects.toThrow();
      expect(fs.existsSync(path.join(f.root, 'a.txt'))).toBe(false); expect(await git(f.root, 'status', '--porcelain')).toBe('');
    } finally { f.close(); }
  }
});

for (const location of ['source', 'parent']) for (const type of ['unstaged', 'staged', 'untracked', 'merge']) {
  test(`dirty/intermediate ${location} ${type} is never discarded`, async () => {
    const f = await ready();
    try {
      const cwd = location === 'source' ? f.members[0].workspace : f.root;
      let filename = path.join(cwd, type === 'untracked' ? 'precious.txt' : 'file.txt');
      if (type === 'merge') filename = path.join(await git(cwd, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD');
      fs.writeFileSync(filename, type === 'merge' ? f.baseline + '\n' : 'precious user data\n');
      if (type === 'staged') await git(cwd, 'add', 'file.txt');
      const status = await git(cwd, 'status', '--porcelain'), contents = fs.readFileSync(filename, 'utf8');
      await expect(f.apply(f.receipt)).rejects.toThrow();
      expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseline);
      expect(await git(cwd, 'status', '--porcelain')).toBe(status); expect(fs.readFileSync(filename, 'utf8')).toBe(contents);
    } finally { f.close(); }
  });
}

test('all source refs and target are locked before synchronization; cancellation before/after preserves evidence', async () => {
  for (const cancelAt of ['before', 'after', null]) {
    const f = await ready();
    try {
      let cancelled = cancelAt === 'before', attempted = false;
      const original = f.workspaces.git;
      f.workspaces.git = async function(cwd, ...args) {
        if (args[0] === 'read-tree') {
          attempted = true;
          const other = await git(f.root, 'commit-tree', f.receipt.tree, '-p', f.baseline, '-m', 'outside');
          for (const member of f.receipt.members) await expect(git(f.root, 'update-ref', `refs/heads/${member.branch}`, other, member.source)).rejects.toThrow('lock');
          await expect(git(f.root, 'update-ref', 'refs/heads/main', other, f.baseline)).rejects.toThrow('lock');
        }
        const result = await original.call(this, cwd, ...args);
        if (args[0] === 'read-tree' && cancelAt === 'after') cancelled = true;
        return result;
      };
      if (cancelAt) await expect(f.apply(f.receipt, () => !cancelled)).rejects.toThrow('cancelled');
      else await f.apply(f.receipt);
      expect(attempted).toBe(cancelAt !== 'before');
      if (cancelAt === 'after') {
        expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseline);
        expect(await git(f.root, 'write-tree')).toBe(f.receipt.tree);
        expect(await git(f.root, 'status', '--porcelain')).not.toBe('');
        expect(await f.workspaces.verifyConvergencePublishUnsafe(f.receipt)).toBe(false);
        await expect(f.apply(f.receipt)).rejects.toThrow();
      }
      for (const member of f.receipt.members) await git(f.root, 'update-ref', `refs/heads/${member.branch}`, member.source, member.source);
      const head = await git(f.root, 'rev-parse', 'HEAD'); await git(f.root, 'update-ref', 'refs/heads/main', head, head);
    } finally { f.close(); }
  }
});

test('late source movement during async checks is caught by transaction CAS, and async guard cannot write', async () => {
  const f = await ready();
  try {
    await expect(f.apply(f.receipt, async () => true)).rejects.toThrow('synchronous');
    expect(await git(f.root, 'status', '--porcelain')).toBe('');
    const original = f.workspaces.assertCleanBranches; let moved = false;
    f.workspaces.assertCleanBranches = async function(...args) {
      await original.apply(this, args);
      if (!moved) { moved = true; await git(f.members[1].workspace, 'commit', '--allow-empty', '-m', 'late movement'); }
    };
    await expect(f.apply(f.receipt)).rejects.toThrow('moved or locked');
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseline); expect(await git(f.root, 'status', '--porcelain')).toBe('');
  } finally { f.close(); }
});

test('object-equivalent but different commit, target rewrite, or wrong worktree is not recovery proof', async () => {
  const f = await ready();
  try {
    await f.apply(f.receipt);
    const other = await git(f.root, 'commit-tree', f.receipt.tree, '-p', f.baseline, '-m', 'equivalent not exact');
    expect(await f.workspaces.verifyConvergencePublishUnsafe({ ...f.receipt, commit: other })).toBe(false);
    expect(await f.workspaces.verifyConvergencePublishUnsafe({ ...f.receipt, workspace: null })).toBe(false);
    await git(f.root, 'checkout', '-b', 'external', other);
    await git(f.root, 'update-ref', 'refs/heads/main', other, f.receipt.commit);
    expect(await f.workspaces.verifyConvergencePublishUnsafe(f.receipt)).toBe(false);
  } finally { f.close(); }
});

test('batch Squash second iteration replays only member delta and preserves its peer; sync and archive use exact mappings', async () => {
  const f = await ready();
  try {
    await f.apply(f.receipt); f.settle(f.receipt);
    const [a, b] = f.members;
    expect(await f.workspaces.squashedLanded(a.source_branch, f.receipt.commit)).toBe(true);
    await f.workspaces.exclusive(() => f.workspaces.archiveSquashedTaskUnsafe(f.store.task(b.task_id), b.source_commit, f.receipt.commit));
    expect(f.store.branch(b.source_branch).status).toBe('archived');
    await f.change(a, { 'a.txt': 'second iteration\n' });
    expect(await f.workspaces.squashedLanded(a.source_branch, f.receipt.commit)).toBe(false);
    const task = f.store.task(a.task_id);
    const base = await f.workspaces.taskSyncBase(task, a.source_commit, f.receipt.commit);
    expect(base).toBe(f.receipt.members[0].source);
    const normalized = await f.workspaces.mergeConvergenceObjects({ base, left: f.receipt.commit,
      right: a.source_commit, parents: [f.receipt.commit], message: 'second delta' });
    expect(normalized.conflict).toBe(false); expect(await git(f.root, 'show', `${normalized.commit}:b.txt`)).toBe('b');
    const synced = await f.workspaces.exclusive(() => f.workspaces.syncTaskParentUnsafe(task, a.source_commit, f.receipt.commit));
    expect(synced.conflict).toBe(false); expect(synced.integration).toBe('pending');
    expect(await git(a.workspace, 'show', 'HEAD:b.txt')).toBe('b');
    a.source_commit = synced.head_commit;
    const second = await f.prepare(normalized.tree, { members: [a], base: f.receipt.commit, run_id: 2 });
    await f.apply(second); f.settle(second);
    expect(await git(f.root, 'show', 'HEAD:a.txt')).toBe('second iteration'); expect(await git(f.root, 'show', 'HEAD:b.txt')).toBe('b');
    await f.workspaces.exclusive(() => f.workspaces.archiveSquashedTaskUnsafe(f.store.task(a.task_id), a.source_commit, second.commit));
    expect(f.store.branch(a.source_branch).status).toBe('archived');
  } finally { f.close(); }
});

test('a forged or missing multi-source mapping cannot authorize sync, landed projection, or archive', async () => {
  const f = await ready();
  try {
    await f.apply(f.receipt); f.settle(f.receipt);
    const a = f.members[0], task = f.store.task(a.task_id);
    f.store.run('UPDATE delivery_runs SET landing_receipt=? WHERE id=1', JSON.stringify({ ...f.receipt, members: [f.receipt.members[1]] }));
    expect(await f.workspaces.squashedLanded(a.source_branch, f.receipt.commit)).toBe(false);
    await expect(f.workspaces.taskSyncBase(task, a.source_commit, f.receipt.commit)).rejects.toThrow('mapping');
    await expect(f.workspaces.archiveSquashedTaskUnsafe(task, a.source_commit, f.receipt.commit)).rejects.toThrow('mapping');
    expect(await git(a.workspace, 'rev-parse', 'HEAD')).toBe(a.source_commit);
  } finally { f.close(); }
});
