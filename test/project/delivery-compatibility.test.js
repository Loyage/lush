import { test, expect, setDefaultTimeout } from 'bun:test';
setDefaultTimeout(15000);
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';

const booking = (f, task) => JSON.parse(f.store.task(task.id).reservation);
async function world() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  return f;
}
async function source(f, name) {
  const { task } = await f.project.order(name);
  fs.writeFileSync(path.join(task.workspace, `${name}.txt`), name);
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', name);
  f.store.update(task.id, { status: 'waiting', result: 'tested' });
  await f.project.reserveTask(task.id, 'merge');
  return task;
}
async function drive(f, task) { f.project.stopping = false; await f.project.driveTaskMerge(task.parent_id); }
function oldQueue(f, task, audit = true) {
  const queue = f.store.create({ parent_id: task.parent_id, role: 'agent', task_kind: 'merge', name: 'merge', goal: 'historical identity' });
  f.store.update(queue.id, { status: 'waiting' });
  const current = booking(f, task);
  const baseline = f.store.task(task.parent_id).head_commit;
  f.store.update(task.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'requested',
    parent_id: task.parent_id, commit: current.commit, baseline }) });
  f.store.run('UPDATE tasks SET parent_id=? WHERE id=?', queue.id, task.id);
  if (audit) f.store.event(task.id, 'task.reparented_for_merge', { from: task.parent_id, to: queue.id });
  return queue;
}

test('code dependencies outrank enqueue order without introducing new public dependency edges', async () => {
  const f = await world();
  try {
    const upstream = await source(f, 'upstream'), downstream = await source(f, 'downstream');
    // Existing persisted dependencies remain a landing constraint; new spawn has no legacy deps API.
    f.store.addDep(downstream.id, upstream.id, 'code');
    const first = booking(f, upstream), second = booking(f, downstream);
    f.store.update(upstream.id, { reservation: JSON.stringify({ ...first, enqueue_seq: second.enqueue_seq + 1 }) });
    await drive(f, upstream);
    expect(f.store.task(upstream.id).integration).toBe('merged');
    expect(booking(f, downstream).attempt_id).toBeUndefined();
    await drive(f, downstream);
    expect(booking(f, downstream).status).toBe('resolving');
  } finally { await f.close(); }
});

test('duplicate requests are idempotent, including a later round with the identical source SHA', async () => {
  const f = await world();
  try {
    const task = await source(f, 'duplicate'); const first = booking(f, task);
    await f.project.reserveTask(task.id, 'merge'); await f.project.reserveTask(task.id, 'merge');
    expect(booking(f, task).delivery_id).toBe(first.delivery_id);
    expect(f.store.history(task.id).filter(event => event.type === 'merge.enqueued')).toHaveLength(1);
    await drive(f, task);
    await f.project.reserveTask(task.id, 'merge');
    expect(f.store.history(task.id).filter(event => event.type === 'task.merge_integrated')).toHaveLength(1);
    // A target reset is an external loss of delivery, not a reason to reuse the old signal key.
    await git(f.root, 'update-ref', 'refs/heads/main', first.commit); // retains reviewed work by ancestry
    f.store.update(task.id, { reservation: null, integration: 'pending', status: 'waiting' });
    await git(f.root, 'update-ref', 'refs/heads/main', task.base_commit);
    // Synchronize the intentionally reset test checkout without deleting user files.
    await git(f.root, 'read-tree', '-m', '-u', first.commit, task.base_commit);
    await f.project.reserveTask(task.id, 'merge');
    const second = booking(f, task);
    expect(second.commit).toBe(first.commit);
    expect(second.delivery_id).not.toBe(first.delivery_id);
    expect(second.enqueue_seq).toBeGreaterThan(first.enqueue_seq);
    expect(f.store.all("SELECT id FROM messages WHERE sender_id=? AND signal_type='merge.requested'", task.id)).toHaveLength(2);
  } finally { await f.close(); }
});

test('audited old v2 in-flight reparent is restored without deleting its historical identity', async () => {
  const f = await world();
  try {
    const task = await source(f, 'legacy'), queue = oldQueue(f, task);
    f.project.recoverTaskDeliveries(); await f.project.workspaces.queue;
    expect(f.store.task(task.id).parent_id).toBe(task.parent_id);
    expect(f.store.task(queue.id)).toMatchObject({ task_kind: 'merge', status: 'completed', calls: 0 });
    expect(booking(f, task).queue_protocol).toBe(1);
    await drive(f, task);
    expect(f.store.task(task.id)).toMatchObject({ status: 'awaiting_acceptance', integration: 'merged' });
    expect(f.store.history(task.id).filter(event => event.type === 'task.reparented_for_merge')).toHaveLength(1);
    expect(f.store.get('SELECT count(*) AS n FROM tasks WHERE task_kind=\'merge\'').n).toBe(1);
  } finally { await f.close(); }
});

test('old v2 recovery refuses an unaudited parent instead of guessing from merge identity or branch', async () => {
  const f = await world();
  try {
    const task = await source(f, 'unaudited'), queue = oldQueue(f, task, false);
    const tip = await git(f.root, 'rev-parse', 'main');
    f.project.recoverTaskDeliveries(); await f.project.workspaces.queue; await drive(f, task);
    expect(f.store.task(task.id).parent_id).toBe(queue.id);
    expect(f.store.task(task.id).integration_error).toContain('audit');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(tip);
    expect(booking(f, task).queue_protocol).toBeUndefined();
  } finally { await f.close(); }
});

test('old v2 Git/DB window is converted to an exact credential and verified, never reapplied', async () => {
  const f = await world();
  try {
    const task = await source(f, 'legacy-window'); oldQueue(f, task);
    const old = booking(f, task);
    const landed = await f.project.workspaces.exclusive(() => f.project.workspaces.squashBranchUnsafe(task.branch,
      old.commit, old.baseline, `Merge task #${task.id}: ${task.goal.split('\n')[0].slice(0, 100)}`));
    f.project.recoverTaskDeliveries(); await f.project.workspaces.queue;
    expect(booking(f, task)).toMatchObject({ status: 'blocked', landing_receipt: { commit: landed.commit } });
    f.project.workspaces.applyTaskSquashUnsafe = () => { throw new Error('unknown replay forbidden'); };
    await drive(f, task);
    expect(f.store.task(task.id).integration).toBe('merged');
    expect(booking(f, task).landed_commit).toBe(landed.commit);
  } finally { await f.close(); }
});

test('source drift after Git success cannot be mistaken for the committed delivery during DB recovery', async () => {
  const f = await world();
  try {
    const task = await source(f, 'drift');
    f.project.finalizeTaskMerge = () => { throw new Error('DB unavailable'); };
    await drive(f, task); const receipt = booking(f, task).landing_receipt;
    await git(task.workspace, 'commit', '--allow-empty', '-m', 'external source movement');
    f.project.recoverTaskDeliveries(); await drive(f, task);
    expect(booking(f, task).status).toBe('blocked');
    expect(booking(f, task).blocked_reason).toContain('source ref drifted');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(receipt.commit);
    expect(f.project.activeTaskMerge(task.parent_id)?.id).toBe(task.id);
  } finally { await f.close(); }
});
