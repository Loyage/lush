import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture, repo, git } from './helpers.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../src/rpc/registry.js';
import { run } from '../src/cli/commands/branch.js';

/** 在一条新分支上提交一次改动，然后把这个临时 worktree 收掉；返回新 commit。 */
async function commitOn(f, branchName, from, filename, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-orch-wt-'));
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

/** 造一个已完成、带 requested / pending 合并预约的 say Task 及其分支（父是另一个 Task 的分支）。 */
async function makeSay(f, { branch, parentBranch, from, parentId, filename, content,
  status = 'completed', reservationStatus = 'requested', blockedCode = null }) {
  const commit = await commitOn(f, branch, from, filename, content);
  f.store.recordBranch({ branch, parent: parentBranch, created_from_commit: from });
  const task = f.store.create({ parent_id: parentId, role: 'agent', task_kind: 'say', goal: `say ${branch}`, name: `say-${branch}` });
  f.store.update(task.id, { status, branch, target_branch: parentBranch, base_commit: from, head_commit: commit, integration: 'pending' });
  if (reservationStatus !== null) {
    const reservation = { version: 1, kind: 'merge', status: reservationStatus, created_at: new Date().toISOString() };
    if (reservationStatus === 'requested') { reservation.commit = commit; reservation.baseline = from; reservation.parent_id = parentId; }
    if (blockedCode) reservation.blocked_code = blockedCode;
    f.store.update(task.id, { reservation: JSON.stringify(reservation) });
  }
  return { task: f.store.task(task.id), commit };
}

test('registry：orchestrate_plan 只读，orchestrate / orchestrate_cancel 是用户专属', () => {
  expect(PARAMS['branch.orchestrate_plan']).toEqual(['branch']);
  expect(PARAMS['branch.orchestrate']).toEqual(['branch']);
  expect(PARAMS['branch.orchestrate_cancel']).toEqual(['branch']);
  expect(USER_ONLY.has('branch.orchestrate_plan')).toBe(false);
  expect(USER_ONLY.has('branch.orchestrate')).toBe(true);
  expect(USER_ONLY.has('branch.orchestrate_cancel')).toBe(true);
  expect(assertAllowed('branch.orchestrate_plan', { branch: 'main' }, 7)).toBe(7);
  expect(() => assertAllowed('branch.orchestrate', { branch: 'main' }, 7)).toThrow(/requires user approval/);
  expect(() => assertAllowed('branch.orchestrate_cancel', { branch: 'main' }, 7)).toThrow(/requires user approval/);
});

test('CLI：branch orchestrate-plan / orchestrate / orchestrate-cancel 翻译成对应 RPC', async () => {
  const clientStub = result => { const calls = []; return { calls, async request(method, params) { calls.push({ method, params }); return result; } }; };
  const plan = clientStub({ target_branch: 'main', items: [], order: [] });
  expect(await run('branch', ['orchestrate-plan', 'main'], { client: plan, json: true })).toEqual({ target_branch: 'main', items: [], order: [] });
  expect(plan.calls).toEqual([{ method: 'branch.orchestrate_plan', params: { branch: 'main' } }]);
  const started = clientStub({ target_branch: 'main', status: 'running', plan: { order: ['a'] } });
  await run('branch', ['orchestrate', 'main'], { client: started, json: true });
  expect(started.calls).toEqual([{ method: 'branch.orchestrate', params: { branch: 'main' } }]);
  const cancelled = clientStub({ target_branch: 'main', status: 'cancelled', done: ['a'] });
  await run('branch', ['orchestrate-cancel', 'main'], { client: cancelled, json: true });
  expect(cancelled.calls).toEqual([{ method: 'branch.orchestrate_cancel', params: { branch: 'main' } }]);
});

test('plan enumerates say sub-branches leaf-first with fixed commits, baselines and actions', async () => {
  const f = await setup();
  try {
    const main = await f.project.ensureMainTask();
    const mainHead = await git(f.root, 'rev-parse', 'HEAD');
    const a = await makeSay(f, { branch: 'say-A', parentBranch: 'main', from: mainHead, parentId: main.id, filename: 'a.txt', content: 'A\n' });
    const b = await makeSay(f, { branch: 'say-B', parentBranch: 'say-A', from: a.commit, parentId: a.task.id, filename: 'b.txt', content: 'B\n' });

    const plan = await f.project.orchestratePlan('main');
    expect(plan.target_branch).toBe('main');
    expect(plan.order).toEqual(['say-B', 'say-A']);
    expect(plan.items.find(item => item.branch === 'say-B')).toMatchObject({ depth: 2, action: 'merge', ready: true, commit: b.commit, baseline: a.commit, task_id: b.task.id });
    expect(plan.items.find(item => item.branch === 'say-A')).toMatchObject({ depth: 1, action: 'merge', ready: false, commit: a.commit, baseline: mainHead });
    // 只读：没有写运行，也没有建编排 Task。
    expect(f.store.branchMergeRun('main')).toBeNull();
    expect(f.store.all("SELECT id FROM tasks WHERE task_kind='merge'")).toHaveLength(0);
  } finally { await f.close(); }
});

test('orchestrate lands every requested say merge ff-only and finishes the orchestration task', async () => {
  const f = await setup();
  try {
    const main = await f.project.ensureMainTask();
    const mainHead = await git(f.root, 'rev-parse', 'HEAD');
    // say-A 先不固定提交（pending），等子分支 say-B 落地后由编排按最新 tip 重新固定并落地。
    await makeSay(f, { branch: 'say-A', parentBranch: 'main', from: mainHead, parentId: main.id, filename: 'a.txt', content: 'A\n', reservationStatus: 'pending' });
    const b = await makeSay(f, { branch: 'say-B', parentBranch: 'say-A', from: (await git(f.root, 'rev-parse', 'say-A')), parentId: (await f.store.get("SELECT id FROM tasks WHERE branch='say-A'")).id, filename: 'b.txt', content: 'B\n' });

    const started = await f.project.orchestrate('main');
    expect(started.status).toBe('running');
    expect(f.store.task(started.task.id).task_kind).toBe('merge');
    // 运行中：目标与整棵后代子树（含没有 worktree 的 say 分支）都被冻结。
    const frozen = f.project.branchFreeze().map(row => row.branch);
    expect(frozen).toEqual(expect.arrayContaining(['main', 'say-A', 'say-B']));
    expect(() => f.project.assertBranchWritable('main', 'merge')).toThrow(/frozen/);

    await f.project.driveOrchestrate('main');
    expect(f.store.branchMergeRun('main')).toBeNull();
    expect(f.project.branchFreeze()).toEqual([]);
    // 最终 main 就是叶子 say-B 的固定提交；没有产生 merge commit。
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(b.commit);
    expect(await git(f.root, 'rev-list', '--merges', '--count', 'HEAD')).toBe('0');
    expect(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8')).toBe('A\n');
    expect(fs.readFileSync(path.join(f.root, 'b.txt'), 'utf8')).toBe('B\n');
    const task = f.store.task(started.task.id);
    expect(task.status).toBe('completed');
    expect(f.store.get("SELECT integration FROM tasks WHERE branch='say-B'").integration).toBe('merged');
    const events = f.store.all("SELECT type FROM events WHERE type LIKE 'merge.orchestrate.%' ORDER BY id").map(row => row.type);
    expect(events).toContain('merge.orchestrate.started');
    expect(events).toContain('merge.orchestrate.completed');
  } finally { await f.close(); }
});

test('a pending fast-forward say is settled to requested then landed by the orchestration', async () => {
  const f = await setup();
  try {
    const main = await f.project.ensureMainTask();
    const mainHead = await git(f.root, 'rev-parse', 'HEAD');
    const a = await makeSay(f, { branch: 'say-A', parentBranch: 'main', from: mainHead, parentId: main.id,
      filename: 'a.txt', content: 'A\n', status: 'waiting', reservationStatus: 'pending' });
    const started = await f.project.orchestrate('main');
    await f.project.driveOrchestrate('main');
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(a.commit);
    const say = f.store.task(a.task.id);
    expect(say.status).toBe('completed');
    expect(JSON.parse(say.reservation).status).toBe('integrated');
    expect(f.store.task(started.task.id).status).toBe('completed');
  } finally { await f.close(); }
});

test('plan marks un-requested eligible say branches for an automatic merge request', async () => {
  const f = await setup();
  try {
    const main = await f.project.ensureMainTask();
    const mainHead = await git(f.root, 'rev-parse', 'HEAD');
    const a = await makeSay(f, { branch: 'say-A', parentBranch: 'main', from: mainHead, parentId: main.id,
      filename: 'a.txt', content: 'A\n', status: 'waiting', reservationStatus: null });
    const plan = await f.project.orchestratePlan('main');
    const item = plan.items.find(row => row.branch === 'say-A');
    expect(item).toMatchObject({ action: 'merge', auto_request: true, ready: true, commit: a.commit });
    expect(plan.order).toEqual(['say-A']);
    // 只读计划不写预约、不落地、不建编排 Task。
    expect(f.store.task(a.task.id).reservation).toBeNull();
    expect(f.store.branchMergeRun('main')).toBeNull();
    expect(f.store.all("SELECT id FROM tasks WHERE task_kind='merge'")).toHaveLength(0);
  } finally { await f.close(); }
});

test('orchestration auto-requests and lands an un-requested fast-forward say', async () => {
  const f = await setup();
  try {
    const main = await f.project.ensureMainTask();
    const mainHead = await git(f.root, 'rev-parse', 'HEAD');
    const a = await makeSay(f, { branch: 'say-A', parentBranch: 'main', from: mainHead, parentId: main.id,
      filename: 'a.txt', content: 'A\n', status: 'waiting', reservationStatus: null });
    const started = await f.project.orchestrate('main');
    expect(started.status).toBe('running');
    await f.project.driveOrchestrate('main');
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(a.commit);
    const say = f.store.task(a.task.id);
    expect(say.status).toBe('completed');
    expect(JSON.parse(say.reservation)).toMatchObject({ kind: 'merge', status: 'integrated' });
    expect(f.store.task(started.task.id).status).toBe('completed');
    // 代发请求留痕，事件标 via=orchestrate。
    const reserved = f.store.get("SELECT data FROM events WHERE task_id=? AND type='task.reserved'", a.task.id);
    expect(JSON.parse(reserved.data).via).toBe('orchestrate');
  } finally { await f.close(); }
});

test('orchestration auto-requests a diverged un-requested say and spawns a resolution child', async () => {
  const f = await setup();
  try {
    const main = await f.project.ensureMainTask();
    const mainHead = await git(f.root, 'rev-parse', 'HEAD');
    const a = await makeSay(f, { branch: 'say-A', parentBranch: 'main', from: mainHead, parentId: main.id,
      filename: 'a.txt', content: 'A\n', status: 'waiting', reservationStatus: null });
    fs.writeFileSync(path.join(f.root, 'main.txt'), 'M\n');
    await git(f.root, 'add', 'main.txt'); await git(f.root, 'commit', '-m', 'main moves');
    const plan = await f.project.orchestratePlan('main');
    expect(plan.items.find(row => row.branch === 'say-A')).toMatchObject({ action: 'resolve', auto_request: true });
    await f.project.orchestrate('main');
    await f.project.driveOrchestrate('main');
    const paused = f.store.branchMergeRun('main');
    expect(paused.status).toBe('paused');
    expect(f.store.task(paused.waiting_task_id).resolves_task_id).toBe(a.task.id);
    expect(JSON.parse(f.store.task(a.task.id).reservation).kind).toBe('merge');
  } finally { await f.close(); }
});

test('un-requested say that is still running or awaiting the user is skipped with a reason', async () => {
  const f = await setup();
  try {
    const main = await f.project.ensureMainTask();
    const mainHead = await git(f.root, 'rev-parse', 'HEAD');
    const running = await makeSay(f, { branch: 'say-run', parentBranch: 'main', from: mainHead, parentId: main.id,
      filename: 'r.txt', content: 'R\n', status: 'running', reservationStatus: null });
    const awaiting = await makeSay(f, { branch: 'say-ask', parentBranch: 'main', from: mainHead, parentId: main.id,
      filename: 'q.txt', content: 'Q\n', status: 'awaiting', reservationStatus: null });
    const plan = await f.project.orchestratePlan('main');
    expect(plan.items.find(row => row.branch === 'say-run')).toMatchObject({ action: 'skip', auto_request: false });
    expect(plan.items.find(row => row.branch === 'say-run').blockers.join(' ')).toMatch(/仍在 running/);
    expect(plan.items.find(row => row.branch === 'say-ask')).toMatchObject({ action: 'skip', auto_request: false });
    expect(plan.items.find(row => row.branch === 'say-ask').blockers.join(' ')).toMatch(/等待用户答复/);
    const result = await f.project.orchestrate('main');
    expect(result.status).toBe('empty');
    expect(f.store.branchMergeRun('main')).toBeNull();
    expect(f.store.task(running.task.id).reservation).toBeNull();
    expect(f.store.task(awaiting.task.id).reservation).toBeNull();
  } finally { await f.close(); }
});

test('orchestration holds the freeze until a running target Agent reaches a safe point', async () => {
  const f = await setup();
  try {
    const main = await f.project.ensureMainTask();
    const initial = await git(f.root, 'rev-parse', 'HEAD');
    const parent = await makeSay(f, { branch: 'say-A', parentBranch: 'main', from: initial, parentId: main.id,
      filename: 'a.txt', content: 'A\n', status: 'waiting', reservationStatus: null });
    const source = await makeSay(f, { branch: 'say-B', parentBranch: 'say-A', from: parent.commit, parentId: parent.task.id,
      filename: 'b.txt', content: 'B\n' });
    const moved = await commitOn(f, 'temporary-tip', parent.commit, 'other.txt', 'other\n');
    await git(f.root, 'update-ref', 'refs/heads/say-A', moved);
    const started = await f.project.orchestrate('main');
    f.store.update(parent.task.id, { status: 'running' });
    f.project.running.set(parent.task.id, { agent: { agent: 'mock' } });
    await f.project.driveOrchestrate('main');
    const paused = f.store.branchMergeRun('main');
    expect(paused).toMatchObject({ status: 'paused', waiting_safe_task_id: parent.task.id, waiting_task_id: null });
    expect(f.project.branchFreeze(source.task.branch)).toBeTruthy();
    expect(f.store.get("SELECT id FROM tasks WHERE resolves_task_id=?", source.task.id)).toBeNull();
    f.project.running.delete(parent.task.id); f.store.update(parent.task.id, { status: 'waiting' });
    await f.project.driveOrchestrate('main');
    const ready = f.store.branchMergeRun('main');
    expect(ready.status).toBe('paused');
    expect(f.store.task(ready.waiting_task_id).parent_id).toBe(started.task.id);
  } finally { await f.close(); }
});

test('a diverged say spawns a source-side resolution child; the runtime finalizes it and lands the commit', async () => {
  const f = await setup();
  try {
    const main = await f.project.ensureMainTask();
    const mainHead = await git(f.root, 'rev-parse', 'HEAD');
    const a = await makeSay(f, { branch: 'say-A', parentBranch: 'main', from: mainHead, parentId: main.id, filename: 'a.txt', content: 'A\n' });
    // main 前进：say-A 与 main 分歧。
    fs.writeFileSync(path.join(f.root, 'main.txt'), 'M\n');
    await git(f.root, 'add', 'main.txt'); await git(f.root, 'commit', '-m', 'main moves');
    const moved = await git(f.root, 'rev-parse', 'HEAD');

    const plan = await f.project.orchestratePlan('main');
    expect(plan.items.find(item => item.branch === 'say-A').action).toBe('resolve');

    await f.project.orchestrate('main');
    await f.project.driveOrchestrate('main');
    const paused = f.store.branchMergeRun('main');
    expect(paused.status).toBe('paused');
    expect(paused.waiting_task_id).not.toBeNull();
    const resolution = f.store.task(paused.waiting_task_id);
    expect(resolution.task_kind).toBe('child');
    expect(resolution.resolves_task_id).toBe(a.task.id);
    expect(resolution.parent_id).toBe(f.store.branchMergeRun('main').task_id);
    expect(f.project.branchFreeze(a.task.branch)).toBeTruthy();
    // 编排派的解分歧子任务被标记，走 runtime 收尾而不是旧的终态 say 路径。
    const event = f.store.get("SELECT data FROM events WHERE task_id=? AND type='task.divergence_resolution_requested'", resolution.id);
    expect(JSON.parse(event.data).orchestrated).toBe(true);

    // 扮演那个子任务：把 main 的移动合进来、提交并结算。
    const cwd = await f.project.workspaces.ensure(resolution);
    await git(cwd, 'merge', moved);
    await f.project.workspaces.finish(f.store.task(resolution.id));
    f.project.finish(resolution.id, 'completed');
    await f.project.workspaces.fastForwardBranch('say-A', f.store.task(resolution.id).head_commit);
    // 模拟 Git 已快进、DB 仍在 resolving 的重启窗口：driver 必须复核后幂等收尾。
    await f.project.driveOrchestrate('main');

    expect(f.store.branchMergeRun('main')).toBeNull();
    expect(await git(f.root, 'rev-parse', 'HEAD')).not.toBe(a.commit);
    expect(await git(f.root, 'merge-base', '--is-ancestor', a.commit, 'HEAD')).toBe('');
    expect(await git(f.root, 'merge-base', '--is-ancestor', moved, 'HEAD')).toBe('');
    expect(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8')).toBe('A\n');
    expect(fs.readFileSync(path.join(f.root, 'main.txt'), 'utf8')).toBe('M\n');
    expect(JSON.parse(f.store.task(a.task.id).reservation).status).toBe('integrated');
  } finally { await f.close(); }
});

test('cancelling an orchestration releases the freeze, cancels the waiting resolution and keeps landed work', async () => {
  const f = await setup();
  try {
    const main = await f.project.ensureMainTask();
    const mainHead = await git(f.root, 'rev-parse', 'HEAD');
    await makeSay(f, { branch: 'say-A', parentBranch: 'main', from: mainHead, parentId: main.id,
      filename: 'a.txt', content: 'A\n', status: 'waiting', reservationStatus: 'pending' });
    fs.writeFileSync(path.join(f.root, 'main.txt'), 'M\n');
    await git(f.root, 'add', 'main.txt'); await git(f.root, 'commit', '-m', 'main moves');

    const started = await f.project.orchestrate('main');
    await f.project.driveOrchestrate('main');
    const paused = f.store.branchMergeRun('main');
    const resolutionId = paused.waiting_task_id;

    const result = f.project.cancelOrchestrate('main');
    expect(result.status).toBe('cancelled');
    expect(f.store.branchMergeRun('main')).toBeNull();
    expect(f.project.branchFreeze()).toEqual([]);
    expect(f.store.task(resolutionId).status).toBe('cancelled');
    expect(f.store.task(started.task.id).status).toBe('cancelled');
  } finally { await f.close(); }
});

test('cancelling the orchestration Task directly clears the run and releases the freeze', async () => {
  const f = await setup();
  try {
    const main = await f.project.ensureMainTask();
    const mainHead = await git(f.root, 'rev-parse', 'HEAD');
    await makeSay(f, { branch: 'say-A', parentBranch: 'main', from: mainHead, parentId: main.id,
      filename: 'a.txt', content: 'A\n', reservationStatus: 'pending' });
    fs.writeFileSync(path.join(f.root, 'main.txt'), 'M\n');
    await git(f.root, 'add', 'main.txt'); await git(f.root, 'commit', '-m', 'main moves');
    const started = await f.project.orchestrate('main');
    await f.project.driveOrchestrate('main');
    const resolutionId = f.store.branchMergeRun('main').waiting_task_id;
    f.project.cancel(started.task.id, '直接取消编排');
    expect(f.store.branchMergeRun('main')).toBeNull();
    expect(f.project.branchFreeze()).toEqual([]);
    expect(f.store.task(resolutionId).status).toBe('cancelled');
    expect(f.store.task(started.task.id).status).toBe('cancelled');
  } finally { await f.close(); }
});

test('a source branch that moved past its fixed commit is never silently merged; orchestration reports it as a skip', async () => {
  const f = await setup();
  try {
    const main = await f.project.ensureMainTask();
    const mainHead = await git(f.root, 'rev-parse', 'HEAD');
    const a = await makeSay(f, { branch: 'say-A', parentBranch: 'main', from: mainHead, parentId: main.id, filename: 'a.txt', content: 'A\n' });
    // 请求发出后源分支又前进：固定提交不再等于分支顶端，编排不能把新提交当成已审阅内容落地。
    await commitOn(f, 'say-A-tip', a.commit, 'late.txt', 'LATE\n');
    await git(f.root, 'branch', '-f', 'say-A', 'say-A-tip');
    const plan = await f.project.orchestratePlan('main');
    const item = plan.items.find(row => row.branch === 'say-A');
    expect(item.action).toBe('skip');
    expect(item.blockers.join(' ')).toMatch(/不再是固定提交/);
    const result = await f.project.orchestrate('main');
    expect(result.status).toBe('empty');
    expect(f.store.branchMergeRun('main')).toBeNull();
    expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(mainHead);
  } finally { await f.close(); }
});

test('orchestrate refuses to start while a run is active, and legacy merge-cancel refuses an orchestration run', async () => {
  const f = await setup();
  try {
    const main = await f.project.ensureMainTask();
    const mainHead = await git(f.root, 'rev-parse', 'HEAD');
    await makeSay(f, { branch: 'say-A', parentBranch: 'main', from: mainHead, parentId: main.id,
      filename: 'a.txt', content: 'A\n', reservationStatus: 'pending' });
    await f.project.orchestrate('main');
    await expect(f.project.orchestrate('main')).rejects.toThrow(/already has an active merge run/);
    // 旧入口对含新 say Task 的子树一律拒绝，不会绕过固定提交与父确认。
    await expect(f.project.mergeAll('main')).rejects.toThrow(/cannot use legacy branch.merge_all/);
    expect(() => f.project.cancelMergeAll('main')).toThrow(/merge orchestration/);
    // cancel clears it and releases the freeze so a fresh run can start.
    f.project.cancelOrchestrate('main');
    expect(f.project.branchFreeze()).toEqual([]);
    const again = await f.project.orchestrate('main');
    expect(again.status).toBe('running');
  } finally { await f.close(); }
});
