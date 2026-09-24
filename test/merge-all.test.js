import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture, repo, git } from './helpers.js';

/** 在一条新分支上提交一次改动，然后把这个临时 worktree 收掉；返回新 commit。 */
async function commitOn(f, branchName, from, filename, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-wt-'));
  try {
    await git(f.root, 'worktree', 'add', '-b', branchName, dir, from);
    fs.writeFileSync(path.join(dir, filename), content);
    await git(dir, 'add', filename);
    await git(dir, 'commit', '-m', branchName);
    return await git(dir, 'rev-parse', 'HEAD');
  } finally {
    await git(f.root, 'worktree', 'remove', '--force', dir).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function setup() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  return f;
}

test('plan orders descendants leaf-first and marks ready fast-forward branches', async () => {
  const f = await setup();
  try {
    const main = await git(f.root, 'rev-parse', 'HEAD');
    const a = await commitOn(f, 'input-A', main, 'a.txt', 'A\n');
    f.store.recordBranch({ branch: 'input-A', parent: 'main', created_from_commit: main });
    const b = await commitOn(f, 'input-B', a, 'b.txt', 'B\n');
    f.store.recordBranch({ branch: 'input-B', parent: 'input-A', created_from_commit: a });

    const plan = await f.project.mergeAllPlan('main');
    expect(plan.target_branch).toBe('main');
    // 叶子 input-B 在它的父 input-A 之前，两者都可快进。
    expect(plan.order).toEqual(['input-B', 'input-A']);
    expect(plan.items.find(item => item.branch === 'input-B')).toMatchObject({ depth: 2, action: 'merge', ready: true });
    expect(plan.items.find(item => item.branch === 'input-A').blockers).toContain('input-B');
    expect(plan.frozen).toBe(false);
  } finally { await f.close(); }
});

test('merge all lands every descendant fast-forward and releases the freeze on completion', async () => {
  const f = await setup();
  try {
    const main = await git(f.root, 'rev-parse', 'HEAD');
    const a = await commitOn(f, 'input-A', main, 'a.txt', 'A\n');
    f.store.recordBranch({ branch: 'input-A', parent: 'main', created_from_commit: main });
    const b = await commitOn(f, 'input-B', a, 'b.txt', 'B\n');
    f.store.recordBranch({ branch: 'input-B', parent: 'input-A', created_from_commit: a });

    const started = await f.project.mergeAll('main');
    expect(started.status).toBe('running');
    // 运行中：目标与整棵后代子树都被冻结（叶子与父分支都在冻结区里）。
    const frozen = f.project.branchFreeze().map(row => row.branch);
    expect(frozen).toEqual(expect.arrayContaining(['main', 'input-A', 'input-B']));
    await f.project.driveMergeRun('main');

    expect(f.store.branchMergeRun('main')).toBeNull();
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(b);
    expect(await git(f.root, 'merge-base', '--is-ancestor', a, 'HEAD')).toBe('');
    expect(f.project.branchFreeze()).toEqual([]);
    const events = f.store.all("SELECT type FROM events WHERE type LIKE 'merge.run.%' ORDER BY id").map(row => row.type);
    expect(events).toContain('merge.run.started');
    expect(events).toContain('merge.run.completed');
    // 没有产生任何 merge commit：最终 tip 就是 input-B 的提交。
    expect(await git(f.root, 'rev-list', '--merges', '--count', 'HEAD')).toBe('0');
  } finally { await f.close(); }
});

test('freeze blocks new intents and branch writes on the target and its descendants', async () => {
  const f = await setup();
  try {
    const main = await git(f.root, 'rev-parse', 'HEAD');
    await commitOn(f, 'input-A', main, 'a.txt', 'A\n');
    f.store.recordBranch({ branch: 'main' });
    f.store.recordBranch({ branch: 'input-A', parent: 'main', created_from_commit: main });
    const run = { version: 1, status: 'running', order: [], index: 0, done: [], skipped: [], waiting_task_id: null };
    f.store.setBranchMergeRun('main', run);

    expect(() => f.project.assertBranchWritable('main', 'merge')).toThrow(/frozen/);
    expect(() => f.project.assertBranchWritable('input-A', 'merge')).toThrow(/frozen/);
    await expect(f.project.createInput('新需求', null, 'main')).rejects.toThrow(/frozen/);
    await expect(f.project.approveBranchMerge('input-A')).rejects.toThrow(/frozen/);
    // 冻结只作用于目标区间：区间外的分支照常可写。
    f.store.recordBranch({ branch: 'other' });
    expect(f.project.assertBranchWritable('other', 'merge')).toBe(true);
    f.store.setBranchMergeRun('main', null);
    expect(f.project.branchFreeze()).toEqual([]);
  } finally { await f.close(); }
});

test('an unfinished merger freezes its branch, all descendants and its parent', async () => {
  const f = await setup();
  try {
    const main = await git(f.root, 'rev-parse', 'HEAD');
    await commitOn(f, 'input-A', main, 'a.txt', 'A\n');
    f.store.recordBranch({ branch: 'input-A', parent: 'main', created_from_commit: main });
    await commitOn(f, 'input-A2', main, 'a2.txt', 'A2\n');
    f.store.recordBranch({ branch: 'input-A2', parent: 'input-A', created_from_commit: main });
    const merger = f.store.create({ input_id: null, role: 'merger', goal: 'sync', name: 'sync-main' });
    f.store.update(merger.id, { target_branch: 'input-A' });

    const frozen = f.project.branchFreeze().map(row => row.branch);
    expect(frozen).toEqual(expect.arrayContaining(['input-A', 'input-A2', 'main']));
  } finally { await f.close(); }
});

test('a diverged child pauses the run, creates a merger child task, and resumes after it completes', async () => {
  const f = await setup();
  try {
    const main = await git(f.root, 'rev-parse', 'HEAD');
    const a = await commitOn(f, 'input-A', main, 'a.txt', 'A\n');
    f.store.recordBranch({ branch: 'input-A', parent: 'main', created_from_commit: main });
    // main 前进：input-A 与 main 分歧。
    fs.writeFileSync(path.join(f.root, 'main.txt'), 'M\n');
    await git(f.root, 'add', 'main.txt'); await git(f.root, 'commit', '-m', 'main moves');
    const moved = await git(f.root, 'rev-parse', 'HEAD');

    await f.project.mergeAll('main');
    await f.project.driveMergeRun('main');
    const paused = f.store.branchMergeRun('main');
    expect(paused.status).toBe('paused');
    expect(paused.waiting_task_id).not.toBeNull();
    const merger = f.store.task(paused.waiting_task_id);
    expect(merger.role).toBe('merger');
    expect(merger.target_branch).toBe('input-A');

    // 手动扮演那个 merger：在它的 worktree 里把 main 的提交合进来（不同文件，干净合并）。
    const cwd = await f.project.workspaces.ensure(merger);
    await git(cwd, 'merge', moved);
    await f.project.workspaces.finish(f.store.task(merger.id));
    f.project.finish(merger.id, 'completed');
    await f.project.driveMergeRun('main');

    expect(f.store.branchMergeRun('main')).toBeNull();
    const head = await git(f.root, 'rev-parse', 'HEAD');
    // 落地树同时包含 main 的移动与 input-A 的改动；input-A 的提交已在历史里。
    expect(await git(f.root, 'merge-base', '--is-ancestor', a, 'HEAD')).toBe('');
    expect(fs.readFileSync(path.join(f.root, 'main.txt'), 'utf8')).toBe('M\n');
    expect(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8')).toBe('A\n');
    expect(head).not.toBe(a);
  } finally { await f.close(); }
});

test('cancelling a paused run releases the freeze, cancels the merger and keeps landed work', async () => {
  const f = await setup();
  try {
    const main = await git(f.root, 'rev-parse', 'HEAD');
    await commitOn(f, 'input-A', main, 'a.txt', 'A\n');
    f.store.recordBranch({ branch: 'input-A', parent: 'main', created_from_commit: main });
    fs.writeFileSync(path.join(f.root, 'main.txt'), 'M\n');
    await git(f.root, 'add', 'main.txt'); await git(f.root, 'commit', '-m', 'main moves');

    await f.project.mergeAll('main');
    await f.project.driveMergeRun('main');
    const paused = f.store.branchMergeRun('main');
    const mergerId = paused.waiting_task_id;

    const result = f.project.cancelMergeAll('main');
    expect(result.status).toBe('cancelled');
    expect(f.store.branchMergeRun('main')).toBeNull();
    expect(f.project.branchFreeze()).toEqual([]);
    expect(f.store.task(mergerId).status).toBe('cancelled');
  } finally { await f.close(); }
});
