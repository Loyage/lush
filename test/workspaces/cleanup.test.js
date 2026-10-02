import { test, expect } from 'bun:test';
import iteration from '../../src/core/project/iteration.js';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, git, repo } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';
import { setup, change } from './harness.js';

test('cleanup refuses unmerged work, including commits on failed tasks', async () => {
  const f = await setup();
  try {
    const cwd = await change(f,f.task);
    await expect(f.project.workspaces.cleanup(f.task.id)).rejects.toThrow('unmerged');
    f.store.update(f.task.id,{status:'failed',integration:'none'});
    await expect(f.project.workspaces.cleanup(f.task.id)).rejects.toThrow();
    expect(fs.existsSync(cwd)).toBe(true);
  } finally { await f.close(); }
});

test('worker.cleanup over RPC honors keep_branch and reports what it reclaimed', async () => {
  const f = await setup();
  try {
    await change(f, f.task);
    await f.project.workspaces.merge(f.task.id);
    const branch = f.store.task(f.task.id).branch;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    const kept = await rpc.dispatch('worker.cleanup', { id: f.task.id, keep_branch: true });
    expect(kept.cleanup).toEqual({ id: f.task.id, worktree: 'removed', branch: 'kept', reason: 'kept by --keep-branch' });
    expect(await git(f.root,'branch','--list',branch)).toContain(branch);
    const removed = await rpc.dispatch('worker.cleanup', { id: f.task.id });
    expect(removed.cleanup).toEqual({ id: f.task.id, worktree: 'absent', branch: 'removed', reason: null });
    expect(await git(f.root,'branch','--list',branch)).toBe('');
    await expect(rpc.dispatch('worker.cleanup', { id: f.task.id, nope: true })).rejects.toThrow('unknown parameter');
  } finally { await f.close(); }
});

test('cleanup reclaims a merged branch, and --keep-branch keeps it as a recovery point', async () => {
  const f = await setup();
  try {
    const cwd = await change(f, f.task);
    await f.project.workspaces.merge(f.task.id);
    const branch = f.store.task(f.task.id).branch;
    const kept = await f.project.workspaces.cleanup(f.task.id, { keepBranch: true });
    expect(kept.cleanup).toEqual({ id: f.task.id, worktree: 'removed', branch: 'kept', reason: 'kept by --keep-branch' });
    expect(await git(f.root,'branch','--list',branch)).toContain(branch);
    expect(f.store.task(f.task.id).branch).toBe(branch);
    // 第二次回收：worktree 已经不在，现在要收的就是这条分支。
    const again = await f.project.workspaces.cleanup(f.task.id);
    expect(again.cleanup).toEqual({ id: f.task.id, worktree: 'absent', branch: 'removed', reason: null });
    expect(f.store.task(f.task.id).branch).toBeNull();
    expect(await git(f.root,'branch','--list',branch)).toBe('');
    expect(fs.existsSync(cwd)).toBe(false);
  } finally { await f.close(); }
});

test('a branch with post-review commits is kept until its whole tip reaches the parent', async () => {
  const f = await setup();
  try {
    await change(f, f.task);
    await f.project.workspaces.merge(f.task.id);
    const branch = f.store.task(f.task.id).branch;
    await f.project.workspaces.cleanup(f.task.id, { keepBranch: true });
    // 用户在保留的恢复点上继续提交：分支不再等于审阅过的那次提交，就不删。
    // （快进合并后 main 顶端就是审阅过的提交，所以必须真的多一个提交，而不是把分支指回 HEAD。）
    const moved = await git(f.root, 'commit-tree', `${branch}^{tree}`, '-p', await git(f.root, 'rev-parse', branch), '-m', 'user keeps working');
    await git(f.root,'update-ref',`refs/heads/${branch}`, moved);
    const result = await f.project.workspaces.cleanup(f.task.id);
    expect(result.cleanup.worktree).toBe('absent');
    expect(result.cleanup.branch).toBe('kept');
    expect(result.cleanup.reason).toContain('is not in main yet');
    expect(await git(f.root,'branch','--list',branch)).toContain(branch);
    expect(f.store.task(f.task.id).branch).toBe(branch);
  } finally { await f.close(); }
});

test('cleaned failed child worktree can be recreated by rebuilding its branch from base', async () => {
  const f = await setup();
  try {
    // say 的 worktree 是输入锚点，回收后只能检查、不会重建；可以重建的是它下面的 child。
    const child = await f.project.spawn(f.task.id, 'cleaned work');
    const cwd = child.workspace;
    const branch = f.store.task(child.id).branch;
    f.store.update(child.id,{status:'failed'});
    await f.project.workspaces.cleanup(child.id);
    expect(fs.existsSync(cwd)).toBe(false);
    // 没产出过提交：分支就是 base，回收掉不丢任何历史。
    expect(await git(f.root,'branch','--list',branch)).toBe('');
    f.project.retry(child.id);
    expect(await f.project.workspaces.ensure(f.store.task(child.id))).toBe(cwd);
    expect(await git(cwd,'symbolic-ref','--short','HEAD')).toBe(branch);
  } finally { await f.close(); }
});

/** v2 合并落地的 say：分支、worktree 与预约都还在，等用户决定何时归档。 */
async function squashedSay(f, name) {
  const say = await f.project.say(name);
  fs.writeFileSync(path.join(say.task.workspace, `${name}.txt`), `${name}\n`);
  await git(say.task.workspace, 'add', `${name}.txt`);
  await git(say.task.workspace, 'commit', '-m', `${name} one`);
  f.store.update(say.task.id, { status: 'waiting', result: 'done' });
  await f.project.reserveTask(say.task.id, 'merge');
  f.project.stopping = false;
  await f.project.driveTaskMerge(say.task.parent_id);
  const merged = f.store.task(say.task.id);
  expect(merged).toMatchObject({ status: 'awaiting_acceptance', integration: 'merged' });
  await iteration.acceptTask.call(f.project, merged.id);
  expect(JSON.parse(merged.reservation)).toMatchObject({ version: 2, status: 'integrated' });
  return merged;
}

test('cleanup and delete survive a v2 say whose branch was archived before reclamation', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const merged = await squashedSay(f, 'archived-first');
    const branch = merged.branch;
    // 用户先显式归档分支：ref / worktree 都没了，tasks.branch 作为历史指针留下。
    await f.project.archiveBranch(branch);
    expect(f.store.branch(branch).status).toBe('archived');
    expect(f.store.task(merged.id)).toMatchObject({ branch, workspace: null });
    // 再回收：以前会去 rev-parse 一个不存在的 ref 而拒绝，现在只把悬空指针同步干净。
    const out = await f.project.workspaces.cleanup(merged.id);
    expect(out.cleanup).toEqual({ id: merged.id, worktree: 'absent', branch: 'removed', reason: null });
    expect(f.store.task(merged.id).branch).toBe(null);
    expect(f.store.get('SELECT count(*) AS n FROM events WHERE task_id=? AND type=? AND data LIKE ?',
      merged.id, 'branch.removed', '%"already_archived":true%').n).toBe(1);
    // 删除任务走同一套 reclaim，必须也能过。
    await f.project.deleteTask(merged.id);
    expect(f.store.get('SELECT id FROM tasks WHERE id=?', merged.id)).toBeFalsy();
  } finally { await f.close(); }
});


