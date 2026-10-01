import { test, expect, setDefaultTimeout } from 'bun:test';
setDefaultTimeout(15000);
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, gate } from '../helpers.js';

const booking = (f, task) => JSON.parse(f.store.task(task.id).reservation);
async function world() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  return f;
}
async function source(f, name) {
  const { task } = await f.project.say(name);
  fs.writeFileSync(path.join(task.workspace, `${name}.txt`), name);
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', name);
  f.store.update(task.id, { status: 'waiting', result: 'tested' });
  return task;
}
async function queue(f, task) { await f.project.reserveTask(task.id, 'merge'); }
async function drive(f, parent) { f.project.stopping = false; await f.project.driveTaskMerge(parent); }
async function repair(f, task) {
  const request = booking(f, task);
  await git(task.workspace, 'merge', '--no-edit', request.baseline);
  await f.project.workspaces.finish(f.store.task(task.id));
  // Model invocation settlement: only this attempt's delivered repair message is consumed.
  f.store.run("UPDATE messages SET consumed=1 WHERE task_id=? AND signal_type='merge.repair'", task.id);
  f.store.update(task.id, { status: 'waiting', reservation: JSON.stringify({ ...request, repair_ready: true, repair_run_id: 123 }) });
}

test('queue order is durable request order, not Task ID; enqueue does not pin the parent', async () => {
  const f = await world();
  try {
    const early = await source(f, 'early'), later = await source(f, 'later');
    await queue(f, later); await queue(f, early);
    expect(booking(f, later).enqueue_seq).toBeLessThan(booking(f, early).enqueue_seq);
    expect(booking(f, later).baseline).toBeUndefined();
    expect(f.project.branchFreeze('main')).toBeNull();
    await drive(f, early.parent_id);
    expect(f.store.task(later.id).integration).toBe('merged');
    expect(f.store.task(early.id).integration).not.toBe('merged');
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='merge'").n).toBe(0);
    expect(f.store.task(early.id).parent_id).toBe(early.parent_id);
  } finally { await f.close(); }
});

test('three siblings: the repair owns the logical parent slot across invocations', async () => {
  const f = await world();
  try {
    const one = await source(f, 'one'), two = await source(f, 'two'), three = await source(f, 'three');
    for (const task of [one, two, three]) await queue(f, task);
    await drive(f, one.parent_id); await drive(f, one.parent_id);
    const fixed = booking(f, two);
    expect(fixed.status).toBe('resolving');
    const signal = JSON.parse(f.store.unread(two.id).find(message => message.signal_type === 'merge.repair').body);
    expect(signal).toMatchObject({ version: 1, signal: 'merge.repair', source_task_id: one.parent_id,
      target_task_id: two.id, payload: { delivery_id: fixed.delivery_id, attempt_id: fixed.attempt_id,
        parent_commit: fixed.baseline, source_commit: fixed.original_commit } });
    const baseline = await git(f.root, 'rev-parse', 'main');
    await drive(f, one.parent_id);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(baseline);
    expect(f.project.activeTaskMerge(one.parent_id)?.id).toBe(two.id);
    expect(booking(f, three).attempt_id).toBeUndefined();
    expect(f.project.branchFreeze('main')?.task_id).toBe(two.id);
    await repair(f, two); await drive(f, one.parent_id);
    expect(f.store.task(two.id).integration).toBe('merged');
    expect(booking(f, two).attempt_id).toBe(fixed.attempt_id);
    expect(f.project.activeTaskMerge(one.parent_id)).toBeNull();
  } finally { await f.close(); }
});

test('repair questionnaire suspends and releases the slot; retry creates a fresh baseline and attempt', async () => {
  const f = await world();
  try {
    const one = await source(f, 'one'), two = await source(f, 'two'), three = await source(f, 'three');
    for (const task of [one, two, three]) await queue(f, task);
    await drive(f, one.parent_id); await drive(f, one.parent_id);
    const old = booking(f, two);
    f.project.parkForQuestion(two.id, 999);
    expect(booking(f, two).status).toBe('suspended');
    expect(f.project.activeTaskMerge(one.parent_id)).toBeNull();
    await drive(f, one.parent_id); await repair(f, three); await drive(f, one.parent_id);
    expect(f.store.task(three.id).integration).toBe('merged');
    f.project.resumeQueuedTaskMerge(two.id);
    f.store.update(two.id, { status: 'waiting' }); await queue(f, two); await drive(f, one.parent_id);
    expect(booking(f, two).attempt_id).not.toBe(old.attempt_id);
    expect(booking(f, two).baseline).not.toBe(old.baseline);
    expect(() => f.project.assertTaskMergeAttempt(two.id, old.attempt_id, true)).toThrow('attempt changed');
  } finally { await f.close(); }
});

test('failed repair releases the slot without pretending success or replaying its attempt', async () => {
  const f = await world();
  try {
    const one = await source(f, 'one'), two = await source(f, 'two');
    await queue(f, one); await queue(f, two); await drive(f, one.parent_id); await drive(f, one.parent_id);
    const old = booking(f, two);
    f.project.cancel(two.id, 'tests failed', 'failed');
    expect(booking(f, two).status).toBe('suspended');
    expect(f.project.activeTaskMerge(one.parent_id)).toBeNull();
    f.project.retry(two.id);
    expect(booking(f, two).status).toBe('pending');
    expect(booking(f, two).attempt_id).toBeUndefined();
    expect(f.store.history(two.id).some(event => event.type === 'task.merge_integrated')).toBe(false);
    expect(old.attempt_id).toBeDefined();
  } finally { await f.close(); }
});

test('parent in-flight invocation blocks acquisition even if its Task is already waiting', async () => {
  const f = await world();
  try {
    const { task: parent } = await f.project.say('parent'); f.store.update(parent.id, { status: 'waiting' });
    const child = await f.project.spawn(parent.id, 'child');
    fs.writeFileSync(path.join(child.workspace, 'child.txt'), 'child');
    await git(child.workspace, 'add', '.'); await git(child.workspace, 'commit', '-m', 'child');
    f.store.update(child.id, { status: 'waiting' }); await queue(f, child);
    f.project.running.set(parent.id, {});
    await drive(f, parent.id);
    expect(booking(f, child).attempt_id).toBeUndefined();
    f.project.running.delete(parent.id);
    f.store.message(parent.id, 'urgent input'); f.store.update(parent.id, { status: 'queued' });
    await drive(f, parent.id);
    expect(booking(f, child).attempt_id).toBeUndefined();
    expect(f.store.unread(parent.id).some(row => row.body === 'urgent input')).toBe(true);
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', parent.id);
    f.store.update(parent.id, { status: 'waiting' }); await drive(f, parent.id);
    expect(f.store.task(child.id).integration).toBe('merged');
  } finally { await f.close(); }
});

test('cancellation during asynchronous source inspection wins before any parent-side write', async () => {
  const f = await world(), entered = gate(), proceed = gate();
  try {
    const task = await source(f, 'cancel'); await queue(f, task);
    const original = await git(f.root, 'rev-parse', 'main');
    const branchState = f.project.workspaces.branchState.bind(f.project.workspaces);
    f.project.workspaces.branchState = async (...args) => { const state = await branchState(...args); entered.resolve(); await proceed.promise; return state; };
    const promise = drive(f, task.parent_id); await entered.promise;
    f.project.cancel(task.id); proceed.resolve(); await promise;
    expect(await git(f.root, 'rev-parse', 'main')).toBe(original);
    expect(f.store.task(task.id).status).toBe('cancelled');
    expect(booking(f, task).status).toBe('withdrawn');
    expect(f.project.activeTaskMerge(task.parent_id)).toBeNull();
  } finally { proceed.resolve(); await f.close(); }
});

test('a repaired equal tree preserves Squash policy and does not create an empty parent commit', async () => {
  const f = await world();
  try {
    const one = await source(f, 'same'), two = await source(f, 'same');
    await queue(f, one); await queue(f, two);
    await drive(f, one.parent_id); const landed = await git(f.root, 'rev-parse', 'main');
    await drive(f, one.parent_id);
    expect(booking(f, two).status).toBe('resolving');
    await repair(f, two); await drive(f, one.parent_id);
    expect(f.store.task(two.id).integration).toBe('merged');
    expect(booking(f, two).landed_commit).toBe(landed);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(landed);
    expect(f.store.history(two.id).some(event => event.type === 'merge.tree_already_present')).toBe(true);
  } finally { await f.close(); }
});

test('explicit pause and resume invalidate the repair attempt before automatic delivery is rearmed', async () => {
  const f = await world();
  try {
    const one = await source(f, 'one'), two = await source(f, 'two');
    await queue(f, one); await queue(f, two); await drive(f, one.parent_id); await drive(f, one.parent_id);
    const prior = booking(f, two);
    f.project.interrupt(two.id);
    expect(f.store.task(two.id).status).toBe('paused');
    expect(booking(f, two).status).toBe('suspended');
    expect(f.project.activeTaskMerge(one.parent_id)).toBeNull();
    f.project.resumeTask(two.id);
    expect(f.store.task(two.id).status).toBe('queued');
    expect(booking(f, two).status).toBe('pending');
    expect(booking(f, two).attempt_id).toBeUndefined();
    expect(() => f.project.assertTaskMergeAttempt(two.id, prior.attempt_id, true)).toThrow('attempt changed');
  } finally { await f.close(); }
});

test('Git success followed by DB failure is reconciled from the exact durable SHA, not replayed', async () => {
  const f = await world();
  try {
    const task = await source(f, 'recovery'); await queue(f, task);
    const finalize = f.project.finalizeTaskMerge.bind(f.project);
    f.project.finalizeTaskMerge = () => { throw new Error('simulated DB failure'); };
    await drive(f, task.parent_id);
    expect(booking(f, task).status).toBe('blocked');
    const receipt = booking(f, task).landing_receipt;
    expect(await git(f.root, 'rev-parse', 'main')).toBe(receipt.commit);
    expect(() => f.project.cancel(task.id)).toThrow('Git update');
    f.project.finalizeTaskMerge = finalize;
    let applies = 0;
    f.project.workspaces.applyTaskSquashUnsafe = () => { applies++; throw new Error('must not replay'); };
    f.project.recoverTaskDeliveries(); await drive(f, task.parent_id);
    expect(applies).toBe(0);
    expect(f.store.task(task.id)).toMatchObject({ integration: 'merged', status: 'awaiting_acceptance' });
    expect(booking(f, task).landed_commit).toBe(receipt.commit);
  } finally { await f.close(); }
});

test('failed apply preserves a visible blocked slot until explicit proof that the parent stayed unwritten', async () => {
  const f = await world();
  try {
    const task = await source(f, 'blocked'); await queue(f, task);
    f.project.workspaces.applyTaskSquashUnsafe = () => { throw new Error('unknown apply failure'); };
    await drive(f, task.parent_id);
    expect(booking(f, task).status).toBe('blocked');
    expect(f.project.branchFreeze('main')?.task_id).toBe(task.id);
    await f.project.reserveTask(task.id, 'merge');
    expect(booking(f, task).status).toBe('requested');
    expect(booking(f, task).attempt_id).toBeUndefined();
    expect(f.project.activeTaskMerge(task.parent_id)).toBeNull();
  } finally { await f.close(); }
});
