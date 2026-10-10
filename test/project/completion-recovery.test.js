import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Project } from '../../src/core/project.js';
import { fixture, repo, git, until, gate } from '../helpers.js';

const value = (f, task) => JSON.parse(f.store.task(task.id).auto_merge);
const set = (f, task, level) => f.project.setTaskCompletion(task.id, level, f.project.taskHooks(task.id).revision);
async function setup() { const f = fixture(); f.project.stopping = true; await repo(f.root); return f; }
async function acceptIdle(f, task) {
  // Exact old-format acceptance: its development resources have not yet been reclaimed.
  await f.project.workspaces.finish(f.store.task(task.id));
  f.store.update(task.id, { status: 'completed', reservation: null });
  f.store.event(task.id, 'task.accepted', { head_commit: f.store.task(task.id).head_commit, accepted_by: 'user' });
}
function claim(f, task, phase) {
  const config = value(f, task), data = config.completion;
  const receipt = { id: f.store.event(task.id, 'completion.execution_started', { phase }), phase, round: data.round,
    authorization: data.authorization, head_commit: f.store.task(task.id).head_commit,
    status: 'running', created_at: new Date().toISOString(), finished_at: null };
  data.executions[phase] = receipt;
  f.store.update(task.id, { auto_merge: JSON.stringify(config) }); return receipt;
}
async function restart(f) {
  await f.project.shutdown();
  const restarted = new Project(f.config, f.store); restarted.stopping = true;
  restarted.recoverTaskCompletion(); return restarted;
}

test('partial archive records actual outcomes and is not continued automatically on restart', async () => {
  const f = await setup(); let restarted;
  try {
    const { task } = await f.project.order('subtree archive');
    const child = await f.project.spawn(task.id, 'child'); await acceptIdle(f, child); await acceptIdle(f, task);
    await set(f, task, 'archive');
    const original = f.project.workspaces.git.bind(f.project.workspaces); let removes = 0;
    f.project.workspaces.git = async (cwd, ...args) => {
      if (args[0] === 'worktree' && args[1] === 'remove' && ++removes === 2) throw new Error('synthetic I/O SECRET_ERROR');
      return original(cwd, ...args);
    };
    f.project.stopping = false; f.project.scheduleTaskCompletion(task.id);
    await until(() => value(f, task).completion.executions.archive?.status === 'unknown', 10000);
    const summary = f.store.history(task.id).find(event => event.type === 'branch.archive');
    expect(summary.data.completed).toEqual([task.branch]);
    expect(summary.data.failed).toHaveLength(1);
    expect(f.store.branch(task.branch).status).toBe('archived');
    expect(f.store.branch(child.branch).status).toBe('active');
    expect(f.store.task(task.id).workspace).toBeNull();
    expect(fs.existsSync(child.workspace)).toBe(true);
    expect(JSON.stringify(f.project.taskHooks(task.id))).not.toContain('SECRET_ERROR');
    restarted = await restart(f);
    restarted.workspaces.archiveBranches = () => { throw new Error('must not replay partial archive'); };
    restarted.stopping = false; restarted.scheduleTaskCompletion(task.id); await restarted.completionQueue;
    expect(value(f, task).completion.executions.archive.status).toBe('unknown');
    expect(removes).toBe(2);
    expect(f.store.history(task.id).filter(event => event.type === 'branch.archive')).toHaveLength(1);
  } finally { if (restarted) await restarted.shutdown(); await f.close(); }
});

for (const missing of [false, true]) test(`unknown archive claim preserves the scene and never replays (missing path=${missing})`, async () => {
  const f = await setup(); let restarted;
  try {
    const { task } = await f.project.order('unknown archive'); await acceptIdle(f, task); await set(f, task, 'archive');
    const receipt = claim(f, task, 'archive');
    if (missing) fs.rmSync(task.workspace, { recursive: true }); // own test checkout, not a user's project
    restarted = await restart(f);
    expect(value(f, task).completion.executions.archive.status).toBe('unknown');
    expect(restarted.taskHooks(task.id).completion).toMatchObject({ state: 'unknown', editable: false });
    await expect(restarted.setTaskCompletion(task.id, 'archive', restarted.taskHooks(task.id).revision)).rejects.toThrow('未知');
    const before = f.store.history(task.id).length;
    restarted.workspaces.archiveBranches = () => { throw new Error('must not replay'); };
    restarted.stopping = false; restarted.scheduleTaskCompletion(task.id); await restarted.completionQueue;
    restarted.recoverTaskCompletion();
    expect(f.store.history(task.id)).toHaveLength(before);
    expect(f.store.branch(task.branch).status).toBe('active');
    expect(f.store.all("SELECT id FROM notices WHERE task_id=? AND kind='info'", task.id)).toHaveLength(1);
    expect(value(f, task).completion.executions.archive.id).toBe(receipt.id);
  } finally { if (restarted) await restarted.shutdown(); await f.close(); }
});

for (const phase of ['accept', 'archive']) test(`restart reconciles the exact ${phase} transaction receipt without repeating side effects`, async () => {
  const f = await setup(); let restarted;
  try {
    const { task } = await f.project.order(`exact ${phase}`);
    f.store.update(task.id, { status: 'waiting' });
    await set(f, task, phase);
    await f.project.settleQueuedMerge(task.id); // no-change order proof
    if (phase === 'archive') await acceptIdle(f, task); // historical tail keeps the old phase receipt
    f.project.stopping = false; f.project.scheduleTaskCompletion(task.id);
    await until(() => value(f, task).completion.executions[phase]?.status === 'succeeded', 10000);
    await f.project.completionQueue;
    const config = value(f, task); config.completion.executions[phase].status = 'running';
    f.store.update(task.id, { auto_merge: JSON.stringify(config) });
    const accepted = f.store.history(task.id).filter(event => event.type === 'task.accepted').length;
    const archived = f.store.history(task.id).filter(event => event.type === 'branch.archive').length;
    restarted = await restart(f);
    expect(value(f, task).completion.executions[phase].status).toBe('succeeded');
    restarted.stopping = false; restarted.scheduleTaskCompletion(task.id); await restarted.completionQueue;
    expect(f.store.history(task.id).filter(event => event.type === 'task.accepted')).toHaveLength(accepted);
    expect(f.store.history(task.id).filter(event => event.type === 'branch.archive')).toHaveLength(archived);
  } finally { if (restarted) await restarted.shutdown(); await f.close(); }
});

test('wrong-head acceptance receipt cannot reconcile a claimed stage as successful', async () => {
  const f = await setup(); let restarted;
  try {
    const { task } = await f.project.order('invalid proof'); await acceptIdle(f, task); await set(f, task, 'archive');
    const receipt = claim(f, task, 'accept');
    f.store.event(task.id, 'task.accepted', { head_commit: 'f'.repeat(40), completion_execution: receipt.id,
      authorization: receipt.authorization, round: receipt.round, accepted_by: 'user', via: 'completion_hook' });
    restarted = await restart(f);
    expect(value(f, task).completion.executions.accept.status).toBe('unknown');
    expect(restarted.taskHooks(task.id).completion.editable).toBe(false);
  } finally { if (restarted) await restarted.shutdown(); await f.close(); }
});

test('automatic archive rechecks authorization after waiting for the Git queue', async () => {
  const f = await setup(), entered = gate(), release = gate();
  try {
    const { task } = await f.project.order('archive guard'); await acceptIdle(f, task); await set(f, task, 'archive');
    const original = f.project.workspaces.archiveBranchesUnsafe.bind(f.project.workspaces);
    f.project.workspaces.archiveBranchesUnsafe = async (names, options) => { entered.resolve(); await release.promise; return original(names, options); };
    f.project.stopping = false; f.project.scheduleTaskCompletion(task.id); await entered.promise;
    // Simulate a changed persistent identity at the awaited Git boundary. Public setters cannot edit a running claim.
    const config = value(f, task); config.completion.authorization = 'changed'; f.store.update(task.id, { auto_merge: JSON.stringify(config) });
    release.resolve(); await f.project.completionQueue;
    expect(f.store.branch(task.branch).status).toBe('active');
    expect(fs.existsSync(task.workspace)).toBe(true);
    expect(value(f, task).completion.executions.archive.status).toBe('failed');
  } finally { release.resolve(); await f.close(); }
});

test('accepted historical settlements and frozen requests cannot be silently promoted', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('boundaries');
    f.store.update(task.id, { status: 'completed' });
    await expect(set(f, task, 'archive')).rejects.toThrow('不是验收');
    f.store.update(task.id, { status: 'waiting', reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'requested', parent_id: task.parent_id }) });
    await expect(set(f, task, 'accept')).rejects.toThrow('冻结');
    expect(f.project.autoCompletionView(f.store.task(task.parent_id))).toBeNull();
  } finally { await f.close(); }
});
