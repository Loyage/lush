import { test, expect, setDefaultTimeout } from 'bun:test';
setDefaultTimeout(15000);
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';

async function stranded(f, historical = false) {
  f.project.stopping = true;
  await repo(f.root);
  const { task } = await f.project.say('recover delivery');
  fs.writeFileSync(path.join(task.workspace, 'child.txt'), 'child work\n');
  await git(task.workspace, 'add', 'child.txt');
  await git(task.workspace, 'commit', '-m', 'child work');
  fs.writeFileSync(path.join(f.root, 'parent.txt'), 'parent work\n');
  await git(f.root, 'add', 'parent.txt');
  await git(f.root, 'commit', '-m', 'parent advanced');
  f.store.update(task.id, { status: 'waiting', result: 'ready' });
  await f.project.reserveTask(task.id, 'merge');
  const kick = f.project.kick;
  f.project.kick = () => {};
  f.project.stopping = false;
  await f.project.driveTaskMerge(task.parent_id);
  f.project.stopping = true;
  f.project.kick = kick;
  const source = f.store.task(task.id);
  expect(JSON.parse(source.reservation).status).toBe('resolving');
  expect(source.parent_id).toBe(task.parent_id);
  if (!historical) return { task };
  // Explicitly reproduce the old v2 reparent/audit facts. New deliveries must never do this.
  const queue = f.store.create({ parent_id: task.parent_id, role: 'agent', task_kind: 'merge', name: 'merge', goal: 'historical queue' });
  f.store.update(queue.id, { status: 'waiting' });
  f.store.run('UPDATE tasks SET parent_id=? WHERE id=?', queue.id, task.id);
  f.store.event(task.id, 'task.reparented_for_merge', { from: task.parent_id, to: queue.id });
  const { queue_protocol, delivery_id, enqueue_seq, attempt_id, ...old } = JSON.parse(source.reservation);
  f.store.update(task.id, { reservation: JSON.stringify(old) });
  return { task, queueId: queue.id };
}

test('quota failure and restart keep repair intent for explicit retry, without replaying the failed Agent', async () => {
  let calls = 0;
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ cwd, messages }) {
    calls++;
    const repair = messages.find(row => row.body.includes('合并分歧'));
    if (!repair) return 'explicit retry inspection completed';
    await git(cwd, 'merge', '--no-edit', repair.body.match(/[0-9a-f]{40}/)[0]);
    return 'repaired';
  } });
  try {
    const { task } = await stranded(f);
    const pinned = JSON.parse(f.store.task(task.id).reservation);
    f.project.cancel(task.id, 'usage limit reached', 'failed');
    expect(JSON.parse(f.store.task(task.id).reservation)).toMatchObject({ status: 'suspended', retry_status: 'pending', parent_id: task.parent_id });
    expect(f.project.branchFreeze('main')).toBeNull();
    f.project.recover(); f.project.recover();
    expect(calls).toBe(0);
    expect(f.store.task(task.id)).toMatchObject({ status: 'failed', parent_id: task.parent_id });
    f.project.retry(task.id);
    expect(JSON.parse(f.store.task(task.id).reservation)).toMatchObject({ status: 'pending', parent_id: task.parent_id });
    expect(JSON.parse(f.store.task(task.id).reservation).baseline).toBeUndefined();
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(task.id).integration === 'merged', 8000);
    expect(calls).toBe(2);
    expect(JSON.parse(f.store.task(task.id).reservation).attempt_id).not.toBe(pinned.attempt_id);
    expect(f.store.task(task.id)).toMatchObject({ status: 'awaiting_acceptance', parent_id: task.parent_id });
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='merge'").n).toBe(0);
    expect(await git(f.root, 'show', 'main:child.txt')).toBe('child work');
    expect(await git(f.root, 'show', 'main:parent.txt')).toBe('parent work');
  } finally { await f.close(); }
});

test('legacy retry losing its booking restores the audited parent and can be reserved again after recovery', async () => {
  const f = fixture();
  try {
    const { task, queueId } = await stranded(f, true);
    const pinned = JSON.parse(f.store.task(task.id).reservation);
    await git(task.workspace, 'merge', '--no-edit', pinned.parent_commit);
    f.store.update(task.id, { status: 'waiting', reservation: null });
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', task.id);
    f.project.recover(); f.project.recover();
    expect(f.store.task(task.id)).toMatchObject({ parent_id: task.parent_id, reservation: null, status: 'waiting', calls: 0 });
    expect(f.store.history(task.id).filter(row => row.type === 'task.merge_parent_restored')).toHaveLength(1);
    expect(f.store.task(queueId).calls).toBe(0);
    await f.project.reserveTask(task.id, 'merge');
    f.project.kick = () => {}; f.project.stopping = false;
    await f.project.driveTaskMerge(task.parent_id);
    expect(f.store.task(task.id).integration).toBe('merged');
    expect(f.store.task(queueId).status).toBe('completed');
  } finally { await f.close(); }
});

test('explicit cancellation retry restores the parent but does not recreate delivery approval', async () => {
  const f = fixture();
  try {
    const { task } = await stranded(f);
    f.project.cancel(task.id);
    f.project.retry(task.id);
    expect(f.store.task(task.id)).toMatchObject({ parent_id: task.parent_id, status: 'queued', reservation: null });
  } finally { await f.close(); }
});

test('explicit re-reservation repairs old pending bookings without guessing an unaudited parent', async () => {
  const f = fixture();
  try {
    const { task, queueId } = await stranded(f, true);
    const pinned = JSON.parse(f.store.task(task.id).reservation);
    await git(task.workspace, 'merge', '--no-edit', pinned.parent_commit);
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', task.id);
    f.store.update(task.id, { status: 'waiting', reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'pending' }) });
    f.store.run('UPDATE tasks SET target_branch=? WHERE id=?', 'wrong-parent', task.id);
    await expect(f.project.reserveTask(task.id, 'merge')).rejects.toThrow(/ownership changed/);
    expect(f.store.task(task.id).parent_id).toBe(queueId);
    f.store.run('UPDATE tasks SET target_branch=? WHERE id=?', 'main', task.id);
    const result = await f.project.reserveTask(task.id, 'merge');
    expect(result.reservation).toMatchObject({ status: 'requested', parent_id: task.parent_id });
    expect(f.store.task(task.id).parent_id).toBe(task.parent_id);
  } finally { await f.close(); }
});

test('iteration actions are registered on the production Project', async () => {
  const f = fixture();
  try {
    expect(typeof f.project.acceptTask).toBe('function');
    expect(typeof f.project.reopenTask).toBe('function');
  } finally { await f.close(); }
});
