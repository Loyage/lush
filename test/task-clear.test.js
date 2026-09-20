import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from './helpers.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { createSignal } from '../src/signal.js';

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once: true });
    return done.promise;
  } };
}

test('clear refuses while a task is active, and refuses agent credentials', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  try {
    const task = (await f.project.submit('work')).task;
    await until(() => provider.calls.length === 1);
    expect(() => f.project.clear()).toThrow('unwinding');
    const rpc = new Dispatcher(f.project, createSignal(), {});
    await expect(rpc.dispatch('task.clear', { _token: provider.calls[0].token })).rejects.toThrow('user approval');
    provider.calls[0].done.resolve('done');
    await until(() => f.project.running.size === 0 && f.store.task(task.id).status === 'completed');
    expect(f.store.task(task.id).status).toBe('completed');
    // queued-but-unscheduled tasks also block a clear
    f.project.stopping = true;
    const queued = (await f.project.submit('later')).task;
    expect(f.store.task(queued.id).status).toBe('queued');
    expect(() => f.project.clear()).toThrow(`#${queued.id} still active`);
    f.store.update(queued.id, { status: 'cancelled' });
    expect(await rpc.dispatch('task.clear')).toMatchObject({ cleared: { tasks: 2 } });
    expect(f.store.tasks()).toEqual([]);
  } finally { await f.close(); }
});

test('clear drops rows but keeps unmerged worktrees, branches and never recycles task ids', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = (await f.project.submit('build')).task;
    // planner 只写队列；用一个 coordinator 充当可派活的父任务。
    const host = f.store.create({ input_id: null, role: 'coordinator', goal: 'host' });
    const worker = f.project.spawn(host.id, 'implement', 'worker', [], 'implement-feature');
    const cwd = await f.project.workspaces.ensure(worker);
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'changed\n');
    await git(cwd, 'add', 'file.txt'); await git(cwd, 'commit', '-m', 'implementation');
    await f.project.workspaces.finish(f.store.task(worker.id));
    const branch = f.store.task(worker.id).branch;
    f.project.message(parent.id, 'note');
    f.project.notice(parent.id, 'question', 'body');
    f.project.draft('buffered');
    f.store.update(parent.id, { status: 'completed' });
    f.store.update(host.id, { status: 'completed' });
    f.store.update(worker.id, { status: 'completed' });

    const result = await f.project.clear();
    expect(result.cleared).toMatchObject({ tasks: 3, inputs: 1, drafts: 1, notices: 1, messages: 1, task_specs: 0 });
    expect(result.reclaimed).toEqual({ worktrees: 0, branches: 0, anchors: 1 });
    expect(result.next_task_id).toBe(worker.id + 1);
    expect(result.next_input_id).toBe(parent.input_id + 1);
    // 未合并的成果回收不掉，所以行虽删了，磁盘上的目录与分支都保留，并给出原因。
    expect(result.retained.tasks).toEqual([{ id: worker.id, branch, workspace: cwd, baseline_workspace: null, reason: 'unmerged work must be kept' }]);

    for (const table of ['tasks','inputs','drafts','notices','messages','events','task_deps','task_specs']) {
      expect(f.store.get(`SELECT count(*) AS n FROM ${table}`).n).toBe(0);
    }
    expect(f.project.status().tasks).toEqual([]);
    expect(f.project.tree()).toEqual([]);

    // 磁盘不动：worktree 目录、分支与提交都还在，只是 daemon 不再认识它们。
    expect(fs.existsSync(cwd)).toBe(true);
    expect(await git(f.root, 'branch', '--list', branch)).toContain(branch);
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBeTruthy();

    // id 不复用，所以下一个 worktree 不会撞上保留下来的旧目录名。
    const next = (await f.project.submit('after clear')).task;
    expect(next.id).toBe(worker.id + 1);
    expect((await f.project.submit('again')).task.id).toBe(worker.id + 2);
  } finally { await f.close(); }
});

test('clear reclaims merged worktrees and branches while keeping unmerged work', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = f.store.create({ input_id: null, role: 'coordinator', goal: 'build' });
    const merged = f.project.spawn(parent.id, 'merged work', 'worker', [], 'merged-work');
    const pending = f.project.spawn(parent.id, 'pending work', 'worker', [], 'pending-work');
    for (const task of [merged, pending]) {
      const cwd = await f.project.workspaces.ensure(task);
      fs.writeFileSync(path.join(cwd, 'file.txt'), `${task.name}\n`);
      await git(cwd, 'add', 'file.txt'); await git(cwd, 'commit', '-m', task.name);
      await f.project.workspaces.finish(f.store.task(task.id));
      f.store.update(task.id, { status: 'completed' });
    }
    await f.project.workspaces.merge(merged.id);
    f.store.update(parent.id, { status: 'completed' });
    const mergedCwd = f.store.task(merged.id).workspace, mergedBranch = f.store.task(merged.id).branch;
    const pendingCwd = f.store.task(pending.id).workspace, pendingBranch = f.store.task(pending.id).branch;

    const result = await f.project.clear();
    expect(result.reclaimed).toEqual({ worktrees: 1, branches: 1, anchors: 0 });
    expect(result.retained.tasks).toEqual([{ id: pending.id, branch: pendingBranch, workspace: pendingCwd, baseline_workspace: null, reason: 'unmerged work must be kept' }]);
    expect(fs.existsSync(mergedCwd)).toBe(false);
    expect(await git(f.root, 'branch', '--list', mergedBranch)).toBe('');
    expect(fs.existsSync(pendingCwd)).toBe(true);
    expect(await git(f.root, 'branch', '--list', pendingBranch)).toContain(pendingBranch);
    expect(f.store.tasks()).toEqual([]);
  } finally { await f.close(); }
});

test('clear reclaims the input anchor, but keeps one whose checkout was touched', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const clean = await f.project.submit('clean input');
    const touched = await f.project.submit('touched input');
    fs.writeFileSync(path.join(touched.anchor.workspace, 'file.txt'), 'edited by hand\n');
    for (const input of [clean, touched]) f.store.update(input.task.id, { status: 'completed' });

    const result = await f.project.clear();
    expect(result.reclaimed.anchors).toBe(1);
    expect(result.retained.anchors).toMatchObject([{ id: touched.id, branch: touched.anchor.branch, status: 'kept' }]);
    expect(result.retained.anchors[0].reason).toContain('anchor checkout');
    // 干净的锚点目录与分支都没了，动手改过的整份留着
    expect(fs.existsSync(clean.anchor.workspace)).toBe(false);
    expect(await git(f.root, 'branch', '--list', clean.anchor.branch)).toBe('');
    expect(fs.existsSync(touched.anchor.workspace)).toBe(true);
    expect(await git(f.root, 'branch', '--list', touched.anchor.branch)).toContain(touched.anchor.branch);
    // 输入行清掉了，锚点 id 也不再复用：下一次提交拿到更大的 input id
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
    expect(result.next_input_id).toBe(touched.id + 1);
  } finally { await f.close(); }
});

test('clear refuses while a cleanup is walking a worktree', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    f.project.workspaces.busy.add(1);
    expect(() => f.project.clear()).toThrow('cleanup is in progress');
  } finally { await f.close(); }
});
