import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';

function retire(store, taskId) {
  store.run('CREATE TABLE IF NOT EXISTS runner_bindings(worker_id INTEGER PRIMARY KEY)');
  store.run('INSERT INTO runner_bindings VALUES (?)', taskId);
}
function retained(store, taskId) {
  return { task: store.task(taskId), events: store.all('SELECT * FROM events WHERE task_id=? ORDER BY id', taskId),
    messages: store.all('SELECT * FROM messages WHERE task_id=? ORDER BY id', taskId),
    binding: store.get('SELECT * FROM runner_bindings WHERE worker_id=?', taskId) };
}
async function world() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  // Exercise the real freeze projection, queue driver and parent Git publication together.
  f.project.kick = () => {};
  try {
    const old = (await f.project.order('legacy source', null, [], null, false)).task;
    const sibling = (await f.project.order('new local sibling', null, [], null, false)).task;
    fs.writeFileSync(path.join(sibling.workspace, 'sibling.txt'), 'local delivery\n');
    await git(sibling.workspace, 'add', 'sibling.txt'); await git(sibling.workspace, 'commit', '-m', 'local sibling increment');
    f.store.update(sibling.id, { status: 'waiting', head_commit: await git(sibling.workspace, 'rev-parse', 'HEAD'), integration: 'pending' });
    return { ...f, old, sibling, baseline: await git(f.root, 'rev-parse', 'main') };
  } catch (error) { await f.close(); throw error; }
}
function booking(f, version, status, extra = {}) {
  f.store.update(f.old.id, { status: 'waiting', head_commit: f.old.base_commit,
    reservation: JSON.stringify({ version, kind: 'merge', queue_protocol: 1, status, parent_id: f.old.parent_id,
      delivery_id: 1, enqueue_seq: 1, attempt_id: 1, commit: f.old.base_commit, ...extra }) });
  retire(f.store, f.old.id);
}
function runFor(f, task, state, receipt = false) {
  const run = f.store.createDeliveryRun({ parent_id: task.parent_id, target_branch: task.target_branch, baseline: task.base_commit,
    members: [{ task_id: task.id, delivery_id: task.id, enqueue_seq: task.id, source_branch: task.branch, source_commit: task.base_commit }],
    data: { verification_mode: 'agent' } });
  f.store.updateDeliveryRun(run.id, { state, ...(receipt ? { landing_receipt: { commit: task.base_commit, baseline: task.base_commit } } : {}) });
  return f.store.deliveryRun(run.id);
}
async function deliver(f, blocked) {
  const before = retained(f.store, f.old.id);
  f.project.stopping = false;
  await f.project.requestTaskMerge(f.sibling.id);
  await f.project.driveTaskMerge(f.old.parent_id);
  await Promise.all([...(f.project.taskMergeJobs ?? [])]);
  if (blocked) {
    expect(f.store.task(f.sibling.id).integration).not.toBe('merged');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
  } else {
    await until(() => f.store.task(f.sibling.id).integration === 'merged');
    expect(await git(f.root, 'show', 'main:sibling.txt')).toBe('local delivery');
    expect(await git(f.root, 'rev-list', '--count', `${f.baseline}..main`)).toBe('1');
  }
  expect(retained(f.store, f.old.id)).toEqual(before);
  expect(f.store.runsForTask(f.old.id)).toEqual([]);
}

for (const status of ['executing', 'resolving', 'blocked']) for (const receipt of [false, true]) {
  test(`retired v2 ${status}, receipt=${receipt}: ${receipt ? 'preserve parent barrier without replay' : 'local sibling can land'}`, async () => {
    const f = await world();
    try {
      booking(f, 2, status, receipt ? { landing_receipt: { commit: f.old.base_commit, baseline: f.old.base_commit } } : {});
      expect(f.project.activeTaskMerge(f.old.parent_id)?.id ?? null).toBe(receipt ? f.old.id : null);
      await deliver(f, receipt);
    } finally { await f.close(); }
  });
}

for (const [state, receipt] of [['ready', false], ['landing', false], ['blocked', false], ['landing', true], ['blocked', true]]) {
  test(`retired convergence ${state}, receipt=${receipt}: no continuation or unnecessary parent slot`, async () => {
    const f = await world();
    try {
      const run = runFor(f, f.old, state, receipt);
      booking(f, 3, state === 'ready' ? 'requested' : state === 'landing' ? 'executing' : 'blocked', { run_id: run.id, generation: run.generation });
      expect(f.project.activeConvergenceLanding(f.old.parent_id)?.id ?? null).toBe(receipt ? run.id : null);
      expect(f.project.nextConvergenceLanding(f.old.parent_id)).toBeNull();
      expect(f.project.startConvergenceJob(run.id)).toBe(false);
      await deliver(f, receipt);
      expect(f.store.deliveryRun(run.id)).toEqual(run);
      expect(f.store.deliveryMembers(run.id)).toHaveLength(1);
    } finally { await f.close(); }
  });
}

for (const status of ['requested', 'resolving', 'executing', 'blocked']) {
  test(`retired v3 missing run, ${status}: only possible publication retains the parent barrier`, async () => {
    const f = await world(), blocked = ['executing', 'blocked'].includes(status);
    try {
      booking(f, 3, status, { run_id: 98765 });
      expect(f.project.retiredConvergenceParentBlocked(f.old.parent_id)).toBe(blocked);
      await deliver(f, blocked);
      expect(f.store.deliveryRun(98765)).toBeNull();
    } finally { await f.close(); }
  });
}

test('retired earlier v2/v3 requests do not outrank a ready local convergence candidate', async () => {
  const f = await world();
  try {
    const run = runFor(f, f.sibling, 'ready');
    booking(f, 2, 'requested'); f.project.stopping = false;
    expect(f.project.nextConvergenceLanding(f.old.parent_id)?.run.id).toBe(run.id);
    expect(f.project.convergenceCanPublish(run)).toBe(true);
    // Seed a different retained historical version without changing it through a live API.
    f.store.run('UPDATE tasks SET reservation=? WHERE id=?', JSON.stringify({ version: 3, kind: 'merge', status: 'executing', parent_id: f.old.parent_id }), f.old.id);
    const before = retained(f.store, f.old.id);
    expect(f.project.retiredConvergenceParentBlocked(f.old.parent_id)).toBe(true);
    expect(f.project.nextConvergenceLanding(f.old.parent_id)).toBeNull();
    expect(f.project.convergenceCanPublish(run)).toBe(false);
    await f.project.driveConvergence(f.old.parent_id);
    expect(f.store.deliveryRun(run.id)).toEqual(run);
    expect(retained(f.store, f.old.id)).toEqual(before);
  } finally { await f.close(); }
});
