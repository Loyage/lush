import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import safety from '../../src/core/project/convergence-safety.js';
import queue from '../../src/core/project/convergence-queue.js';
import { convergenceJSON } from '../../src/core/convergence-contract.js';
import { convergenceResourceReason, convergenceHelperContext } from '../../src/core/convergence-resources.js';
import { isSettled } from '../../src/core/types.js';

// Only the protocol Store seam is simulated. Facts/transactions/messages/tasks use a real temporary SQLite DB.
function protocolStore(f, run, members) {
  const key = 'test_convergence_delivery';
  const read = () => JSON.parse(f.store.get('SELECT value FROM meta WHERE key=?', key).value);
  const save = value => f.store.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
  save({ run, members });
  f.store.deliveryRun = runId => { const value = read().run; return value.id === runId ? value : null; };
  f.store.deliveryRuns = (parentId, states) => { const value = read().run; return value.parent_id === parentId && (!states || states.includes(value.state)) ? [value] : []; };
  f.store.deliveryMembers = (runId, activeOnly = false) => read().members.filter(member => member.run_id === runId && (!activeOnly || member.active));
  f.store.updateDeliveryRun = (runId, patch, generation = null) => {
    const value = read();
    if (value.run.id !== runId || (generation !== null && value.run.generation !== generation)) throw new Error('stale generation');
    Object.assign(value.run, patch); save(value); return value.run;
  };
  f.store.releaseDeliveryMembers = (runId, taskId = null) => {
    const value = read(); for (const member of value.members) if (member.run_id === runId && (taskId === null || member.task_id === taskId)) member.active = 0;
    save(value);
  };
  Object.assign(f.project, queue, safety);
  f.project.scheduleTaskMerge = () => {};
  f.project.scheduleConvergence = () => {};
  f.project.wakeConvergenceAfterIntegration = () => {};
}

async function prepared(f, count = 1) {
  f.project.stopping = true; await repo(f.root);
  const tasks = [];
  for (let i = 0; i < count; i++) {
    const { task } = await f.project.order(`fixed ${i}`);
    fs.writeFileSync(path.join(task.workspace, `source-${i}.txt`), `source ${i}\n`);
    await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', `source ${i}`);
    await f.project.workspaces.finish(f.store.task(task.id));
    f.store.update(task.id, { status: 'waiting', reservation: JSON.stringify({ version: 3, kind: 'merge', status: 'requested',
      parent_id: task.parent_id, run_id: 10, generation: 1, commit: f.store.task(task.id).head_commit,
      delivery_id: i + 101, enqueue_seq: i + 101 }) });
    tasks.push(f.store.task(task.id));
  }
  const run = { id: 10, parent_id: tasks[0].parent_id, target_branch: 'main', state: 'preparing', generation: 1,
    baseline: await git(f.root, 'rev-parse', 'main'), landing_receipt: null,
    validation: { command_id: 'historical-command', command_version: 1 }, data: '{}' };
  protocolStore(f, run, tasks.map((task, ordinal) => ({ run_id: 10, task_id: task.id, source_branch: task.branch,
    source_commit: task.head_commit, delivery_id: ordinal + 101, enqueue_seq: ordinal + 101, active: 1, ordinal })));
  return { tasks, run };
}

test('clean withdrawal invalidates the attempt and reconstructs only remaining fixed members', async () => {
  const f = fixture();
  try {
    const { tasks, run } = await prepared(f, 2), parentTip = await git(f.root, 'rev-parse', 'main');
    const result = f.project.withdrawConvergenceMember(tasks[0].id);
    expect(result).toMatchObject({ changed: true, withdrawal_pending: false });
    expect(f.store.task(tasks[0].id).reservation).toBeNull();
    const next = f.store.deliveryRun(run.id);
    expect(next).toMatchObject({ generation: 2, state: 'preparing' });
    expect(convergenceJSON(next.data).plan.nodes).toHaveLength(1);
    expect(f.store.deliveryMembers(run.id, true).map(row => row.task_id)).toEqual([tasks[1].id]);
    expect(convergenceJSON(f.store.task(tasks[1].id).reservation)).toMatchObject({ version: 3, generation: 2, status: 'requested' });
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parentTip);
    expect(await git(tasks[0].workspace, 'rev-parse', 'HEAD')).toBe(tasks[0].head_commit);
  } finally { await f.close(); }
});

test('withdrawal waits for actual command and helper release, never treats abort as exit', async () => {
  const f = fixture();
  try {
    const { tasks, run } = await prepared(f);
    const helper = f.store.create({ parent_id: run.parent_id, role: 'agent', task_kind: 'integration', goal: 'private fixed node' });
    f.store.event(helper.id, 'convergence.integration_created', { run_id: run.id, node_id: 5, generation: 1 });
    const helperController = new AbortController(), commandController = new AbortController();
    f.project.running.set(helper.id, { controller: helperController });
    f.project.convergenceJobs = new Map([[run.id, { controller: commandController }]]);
    expect(f.project.withdrawConvergenceMember(tasks[0].id)).toMatchObject({ withdrawal_pending: true });
    expect(helperController.signal.aborted).toBe(true);
    expect(commandController.signal.aborted).toBe(true);
    expect(convergenceJSON(f.store.task(tasks[0].id).reservation).status).toBe('blocked');
    f.project.convergenceJobs.delete(run.id);
    f.project.drainConvergenceWithdrawals(run.parent_id);
    expect(f.store.deliveryMembers(run.id, true)).toHaveLength(1);
    f.project.running.delete(helper.id);
    f.project.drainConvergenceWithdrawals(run.parent_id);
    expect(f.store.task(tasks[0].id).reservation).toBeNull();
    expect(f.store.deliveryRun(run.id).state).toBe('withdrawn');
  } finally { f.project.running.clear(); f.project.convergenceJobs?.clear(); await f.close(); }
});

test('publication receipt prevents cancellation before changing any member or task state', async () => {
  const f = fixture();
  try {
    const { tasks, run } = await prepared(f);
    f.store.updateDeliveryRun(run.id, { state: 'landing', landing_receipt: '{"commit":"exact"}' });
    const before = f.store.task(tasks[0].id).reservation;
    expect(() => f.project.cancel(tasks[0].id)).toThrow('publication has started');
    expect(f.store.task(tasks[0].id)).toMatchObject({ status: 'waiting', reservation: before });
    expect(f.store.deliveryMembers(run.id, true)).toHaveLength(1);
  } finally { await f.close(); }
});

test('recovery records unknown final validation without invoking Shell again', async () => {
  const f = fixture();
  try {
    const { tasks, run } = await prepared(f);
    f.store.updateDeliveryRun(run.id, { state: 'validating', validation_result: '{"state":"running","tested_commit":"fixed"}' });
    f.project.recoverConvergence();
    expect(f.store.deliveryRun(run.id).state).toBe('failed');
    expect(convergenceJSON(f.store.deliveryRun(run.id).validation_result)).toMatchObject({ state: 'unknown', tested_commit: 'fixed' });
    expect(convergenceJSON(f.store.task(tasks[0].id).reservation).status).toBe('blocked');
  } finally { await f.close(); }
});

test('an internal output can be settled without pretending publication; live resources and missing context stay protected', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const helper = f.store.create({ role: 'agent', task_kind: 'integration', goal: 'internal' });
    expect(convergenceHelperContext(f.store, helper)).toBeNull();
    expect(convergenceResourceReason(f.project, helper)).toContain('缺少');
    expect(isSettled({ ...helper, status: 'awaiting_acceptance', integration: 'pending' })).toBe(true);
    expect(isSettled({ ...helper, status: 'running', integration: 'pending' })).toBe(false);
    expect(isSettled({ task_kind: 'child', status: 'awaiting_acceptance', integration: 'pending' })).toBe(false);
  } finally { await f.close(); }
});
