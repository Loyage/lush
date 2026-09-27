import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { git } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';
import { setup, change } from './harness.js';

test('cleanup refuses unmerged work, including commits on failed aps', async () => {
  const f = await setup();
  try {
    const cwd = await change(f,f.ap);
    await expect(f.project.workspaces.cleanup(f.ap.id)).rejects.toThrow('unmerged');
    f.store.update(f.ap.id,{status:'failed',integration:'none'});
    await expect(f.project.workspaces.cleanup(f.ap.id)).rejects.toThrow();
    expect(fs.existsSync(cwd)).toBe(true);
  } finally { await f.close(); }
});

test('ap.cleanup over RPC honors keep_branch and reports what it reclaimed', async () => {
  const f = await setup();
  try {
    await change(f, f.ap);
    await f.project.workspaces.merge(f.ap.id);
    const branch = f.store.ap(f.ap.id).branch;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    const kept = await rpc.dispatch('ap.cleanup', { id: f.ap.id, keep_branch: true });
    expect(kept.cleanup).toEqual({ id: f.ap.id, worktree: 'removed', branch: 'kept', reason: 'kept by --keep-branch' });
    expect(await git(f.root,'branch','--list',branch)).toContain(branch);
    const removed = await rpc.dispatch('ap.cleanup', { id: f.ap.id });
    expect(removed.cleanup).toEqual({ id: f.ap.id, worktree: 'absent', branch: 'removed', reason: null });
    expect(await git(f.root,'branch','--list',branch)).toBe('');
    await expect(rpc.dispatch('ap.cleanup', { id: f.ap.id, nope: true })).rejects.toThrow('unknown parameter');
  } finally { await f.close(); }
});

test('cleanup reclaims a merged branch, and --keep-branch keeps it as a recovery point', async () => {
  const f = await setup();
  try {
    const cwd = await change(f, f.ap);
    await f.project.workspaces.merge(f.ap.id);
    const branch = f.store.ap(f.ap.id).branch;
    const kept = await f.project.workspaces.cleanup(f.ap.id, { keepBranch: true });
    expect(kept.cleanup).toEqual({ id: f.ap.id, worktree: 'removed', branch: 'kept', reason: 'kept by --keep-branch' });
    expect(await git(f.root,'branch','--list',branch)).toContain(branch);
    expect(f.store.ap(f.ap.id).branch).toBe(branch);
    // 第二次回收：worktree 已经不在，现在要收的就是这条分支。
    const again = await f.project.workspaces.cleanup(f.ap.id);
    expect(again.cleanup).toEqual({ id: f.ap.id, worktree: 'absent', branch: 'removed', reason: null });
    expect(f.store.ap(f.ap.id).branch).toBeNull();
    expect(await git(f.root,'branch','--list',branch)).toBe('');
    expect(fs.existsSync(cwd)).toBe(false);
  } finally { await f.close(); }
});

test('a branch with post-review commits is kept until its whole tip reaches the parent', async () => {
  const f = await setup();
  try {
    await change(f, f.ap);
    await f.project.workspaces.merge(f.ap.id);
    const branch = f.store.ap(f.ap.id).branch;
    await f.project.workspaces.cleanup(f.ap.id, { keepBranch: true });
    // 用户在保留的恢复点上继续提交：分支不再等于审阅过的那次提交，就不删。
    // （快进合并后 main 顶端就是审阅过的提交，所以必须真的多一个提交，而不是把分支指回 HEAD。）
    const moved = await git(f.root, 'commit-tree', `${branch}^{tree}`, '-p', await git(f.root, 'rev-parse', branch), '-m', 'user keeps working');
    await git(f.root,'update-ref',`refs/heads/${branch}`, moved);
    const result = await f.project.workspaces.cleanup(f.ap.id);
    expect(result.cleanup.worktree).toBe('absent');
    expect(result.cleanup.branch).toBe('kept');
    expect(result.cleanup.reason).toContain('is not in main yet');
    expect(await git(f.root,'branch','--list',branch)).toContain(branch);
    expect(f.store.ap(f.ap.id).branch).toBe(branch);
  } finally { await f.close(); }
});

test('cleaned failed worktree can be recreated by rebuilding its branch from base', async () => {
  const f = await setup();
  try {
    const cwd = await f.project.workspaces.ensure(f.ap);
    const branch = f.store.ap(f.ap.id).branch;
    f.store.update(f.ap.id,{status:'failed'});
    await f.project.workspaces.cleanup(f.ap.id);
    expect(fs.existsSync(cwd)).toBe(false);
    // 没产出过提交：分支就是 base，回收掉不丢任何历史。
    expect(await git(f.root,'branch','--list',branch)).toBe('');
    f.project.retry(f.ap.id);
    expect(await f.project.workspaces.ensure(f.store.ap(f.ap.id))).toBe(cwd);
    expect(await git(cwd,'symbolic-ref','--short','HEAD')).toBe(branch);
  } finally { await f.close(); }
});

test('pre-existing branch collisions do not become ap-owned on retry', async () => {
  const f = await setup();
  try {
    const branch = `lush/${f.project.workspaces.namespace}/${f.ap.id}-implement-feature`;
    await git(f.root,'branch',branch);
    await expect(f.project.workspaces.ensure(f.ap)).rejects.toThrow('already exists');
    expect(f.store.ap(f.ap.id).branch).toBeNull();
    await expect(f.project.workspaces.ensure(f.ap)).rejects.toThrow('already exists');
  } finally { await f.close(); }
});
