import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import iteration, { taskSyncDeliveryPaused } from '../../src/core/project/iteration.js';
import { fixture, repo, git, until } from '../helpers.js';

async function prepared(provider) {
  const f = fixture(provider); Object.assign(f.project, iteration); f.project.stopping = true;
  await repo(f.root);
  const { task: parent } = await f.project.say('parent'); f.store.update(parent.id, { status: 'waiting' });
  const child = await f.project.spawn(parent.id, 'sync repair', undefined, [], 'sync-repair');
  f.store.update(child.id, { status: 'waiting' });
  return { ...f, parent, child };
}
async function commit(dir, file) {
  fs.writeFileSync(path.join(dir, file), `${file}\n`);
  await git(dir, 'add', file); await git(dir, 'commit', '-m', file);
}
function request(f) {
  f.store.event(f.child.id, 'task.sync_resolution_requested', {
    source_commit: f.child.base_commit, parent_commit: f.parent.base_commit, parent_id: f.parent.id,
  });
  f.store.message(f.child.id, 'resolve the fixed sync conflict');
  f.store.update(f.child.id, { status: 'queued' });
}
function mockSyncHook(f, integration) {
  f.project.settleTaskSyncResolution = async taskId => {
    const previous = f.store.get("SELECT id FROM events WHERE task_id=? AND type='task.parent_synced'", taskId);
    if (previous) return false;
    return f.project.workspaces.exclusive(async () => {
      const task = f.store.task(taskId);
      await f.project.workspaces.clean(task.workspace);
      const head = await git(task.workspace, 'rev-parse', 'HEAD');
      f.store.update(taskId, { head_commit: head, iteration_base_commit: f.parent.base_commit, integration });
      f.store.event(taskId, 'task.parent_synced', { source_commit: task.base_commit,
        parent_commit: f.parent.base_commit, head_commit: head, resolved: true });
      return true;
    });
  };
}

test('sync repair hook runs outside the Git lock and cannot implicitly deliver a pending child', async () => {
  const f = await prepared({ resolve() { return { agent: 'mock' }; }, async run({ cwd }) {
    await commit(cwd, 'private.txt'); return 'sync repair only';
  } });
  try {
    const before = await git(f.parent.workspace, 'rev-parse', 'HEAD');
    const booking = f.store.task(f.child.id).reservation;
    request(f); mockSyncHook(f, 'pending');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(f.child.id).status === 'waiting' && f.store.task(f.child.id).calls === 1 && !f.project.running.has(f.child.id));
    expect(f.store.task(f.child.id)).toMatchObject({ integration: 'pending', reservation: booking });
    expect(taskSyncDeliveryPaused(f.project, f.child.id)).toBe(true);
    expect(await f.project.settleQueuedMerge(f.child.id)).toBe(false);
    expect(await git(f.parent.workspace, 'rev-parse', 'HEAD')).toBe(before);
    f.project.stopping = true; f.project.recover();
    await f.project.workspaces.queue;
    expect(f.store.task(f.child.id).reservation).toBe(booking);
    expect(await git(f.parent.workspace, 'rev-parse', 'HEAD')).toBe(before);
    // A later explicit merge action releases the persistent sync-only intention.
    const resumed = await f.project.reserveTask(f.child.id, 'merge');
    expect(resumed.reservation.status).toBe('requested');
    expect(taskSyncDeliveryPaused(f.project, f.child.id)).toBe(false);
    f.project.stopping = false; f.project.kick = () => {};
    await f.project.driveTaskMerge(f.parent.id);
    expect(f.store.task(f.child.id).status).toBe('awaiting_acceptance');
    expect(await git(f.parent.workspace, 'show', 'HEAD:private.txt')).toBe('private.txt');
  } finally { await f.close(); }
});

test('no-unique-code sync repair awaits acceptance without consuming the old reservation or creating a delivery', async () => {
  const f = await prepared({ resolve() { return { agent: 'mock' }; }, async run() { return 'synchronized'; } });
  try {
    const booking = f.store.task(f.child.id).reservation;
    const before = await git(f.parent.workspace, 'rev-parse', 'HEAD');
    request(f); mockSyncHook(f, 'merged');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(f.child.id).status === 'awaiting_acceptance' && !f.project.running.has(f.child.id));
    expect(f.store.task(f.child.id)).toMatchObject({ integration: 'merged', reservation: booking });
    expect(f.store.history(f.child.id).filter(event => event.type === 'task.merge_integrated')).toHaveLength(0);
    expect(await git(f.parent.workspace, 'rev-parse', 'HEAD')).toBe(before);
    expect((await f.project.acceptTask(f.child.id)).status).toBe('completed');
    expect(f.store.task(f.child.id).reservation).toBeNull();
  } finally { await f.close(); }
});

test('sync validation failure is a failed invocation and preserves dirty files without a false success receipt', async () => {
  const f = await prepared({ resolve() { return { agent: 'mock' }; }, async run({ cwd }) {
    fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'unfinished repair\n'); return 'claimed success';
  } });
  try {
    request(f); mockSyncHook(f, 'merged');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(f.child.id).status === 'failed' && !f.project.running.has(f.child.id));
    expect(f.store.runsForTask(f.child.id).at(-1).status).toBe('failed');
    expect(f.store.history(f.child.id).filter(event => event.type === 'task.parent_synced')).toHaveLength(0);
    expect(fs.readFileSync(path.join(f.child.workspace, 'dirty.txt'), 'utf8')).toBe('unfinished repair\n');
    expect(taskSyncDeliveryPaused(f.project, f.child.id)).toBe(true);
  } finally { await f.close(); }
});

test('sync busy guards reject input and writes, hold scheduling, and replay deferred runtime wakes on release', async () => {
  const f = await prepared({ resolve() { return { agent: 'mock' }; }, async run() { return 'processed'; } });
  try {
    f.project.taskSyncBusy = new Set([f.child.id, f.parent.id]);
    expect(() => f.project.message(f.child.id, 'do not race')).toThrow('sync is in flight');
    await expect(f.project.spawn(f.parent.id, 'racing child')).rejects.toThrow('sync is in flight');
    await expect(f.project.reserveTask(f.child.id, 'merge')).rejects.toThrow('sync is in flight');
    await expect(f.project.acceptTask(f.child.id)).rejects.toThrow('sync is in flight');
    await expect(f.project.reopenTask(f.child.id)).rejects.toThrow('sync is in flight');
    f.store.update(f.child.id, { status: 'paused' });
    expect(() => f.project.resumeTask(f.child.id)).toThrow('sync is in flight');
    f.store.update(f.child.id, { status: 'waiting' });
    // A runtime receipt arriving during asynchronous synchronization must not be lost.
    f.store.message(f.child.id, 'runtime input during sync'); f.project.wake(f.child.id);
    expect(f.store.task(f.child.id).status).toBe('waiting');
    expect(f.project.taskSyncWakePending.has(f.child.id)).toBe(true);
    f.project.taskSyncBusy.clear(); f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(f.child.id).calls === 1 && !f.project.running.has(f.child.id));
    expect(f.store.unread(f.child.id)).toHaveLength(0);
    expect(f.project.taskSyncWakePending.has(f.child.id)).toBe(false);
  } finally { await f.close(); }
});

test('real source-side sync conflict repair preserves the automatic child reservation but never lands it', async () => {
  const f = await prepared({ resolve() { return { agent: 'mock' }; }, async run({ task, cwd, messages }) {
    expect(task.task_kind).toBe('child');
    const instruction = messages.find(row => row.body.includes('父分支同步冲突'));
    expect(instruction).toBeTruthy();
    const parent = instruction.body.match(/[0-9a-f]{40}/)[0];
    await git(cwd, 'merge', '--no-commit', parent).catch(() => {});
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'resolved child and parent intent\n');
    await git(cwd, 'add', 'file.txt'); await git(cwd, 'commit', '-m', 'resolve fixed sync conflict');
    return 'real repair tested';
  } });
  try {
    // These methods come from the parent's independently owned task-sync mixin.
    // The test exercises the runtime hook after source-side repair instead of mocking a receipt.
    fs.writeFileSync(path.join(f.child.workspace, 'file.txt'), 'source conflict\n');
    await git(f.child.workspace, 'add', 'file.txt'); await git(f.child.workspace, 'commit', '-m', 'source conflict');
    fs.writeFileSync(path.join(f.parent.workspace, 'file.txt'), 'parent conflict\n');
    await git(f.parent.workspace, 'add', 'file.txt'); await git(f.parent.workspace, 'commit', '-m', 'parent conflict');
    const before = await git(f.parent.workspace, 'rev-parse', 'HEAD');
    const booking = f.store.task(f.child.id).reservation;
    expect((await f.project.syncTaskParent(f.child.id)).conflict).toBe(true);
    await f.project.resolveTaskSync(f.child.id);
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(f.child.id).status === 'waiting' && f.store.task(f.child.id).calls === 1
      && !f.project.running.has(f.child.id), 8000);
    expect(f.store.task(f.child.id)).toMatchObject({ integration: 'pending', iteration_base_commit: before, reservation: booking });
    expect(await git(f.parent.workspace, 'rev-parse', 'HEAD')).toBe(before);
    expect(taskSyncDeliveryPaused(f.project, f.child.id)).toBe(true);
    expect(await f.project.settleQueuedMerge(f.child.id)).toBe(false);
    expect(f.store.history(f.child.id).some(event => event.type === 'task.sync_resolution_settled')).toBe(true);
    expect(f.project.inspect(f.child.id).parent_sync_conflict).toBeNull();
    f.project.stopping = true;
    await f.project.reserveTask(f.child.id, 'merge');
    f.project.stopping = false; f.project.kick = () => {};
    await f.project.driveTaskMerge(f.parent.id);
    expect(f.store.task(f.child.id).status).toBe('awaiting_acceptance');
    expect(await git(f.parent.workspace, 'show', 'HEAD:file.txt')).toBe('resolved child and parent intent');
  } finally { await f.close(); }
});

test('Agent messages, runtime receipts and delegation cannot release a user sync-only delivery hold', async () => {
  const f = await prepared();
  try {
    for (const task of [f.child, f.parent]) f.store.event(task.id, 'task.parent_synced', {
      source_commit: task.base_commit, parent_commit: task.base_commit,
    });
    f.project.message(f.child.id, 'ordinary parent Agent update', f.parent.id);
    expect(taskSyncDeliveryPaused(f.project, f.child.id)).toBe(true);
    f.project.sendTaskSignal(f.child.id, f.parent.id, 'child.completed', 'hold-receipt', { result: 'receipt' });
    expect(taskSyncDeliveryPaused(f.project, f.parent.id)).toBe(true);
    await f.project.spawn(f.parent.id, 'delegation is not user delivery approval');
    expect(taskSyncDeliveryPaused(f.project, f.parent.id)).toBe(true);
    f.store.update(f.parent.id, { status: 'paused' });
    f.project.resumeTask(f.parent.id);
    expect(taskSyncDeliveryPaused(f.project, f.parent.id)).toBe(false);
    f.project.message(f.child.id, 'explicit new user development');
    expect(taskSyncDeliveryPaused(f.project, f.child.id)).toBe(false);
  } finally { await f.close(); }
});

test('ordinary new input resumes a sync-held reservation without reconstructing a child', async () => {
  const f = await prepared({ resolve() { return { agent: 'mock' }; }, async run({ task, cwd }) {
    if (task.task_kind === 'child') await commit(cwd, 'after-sync.txt'); return 'new work';
  } });
  try {
    f.store.event(f.child.id, 'task.parent_synced', { source_commit: f.child.base_commit, parent_commit: f.parent.base_commit });
    expect(taskSyncDeliveryPaused(f.project, f.child.id)).toBe(true);
    f.project.message(f.child.id, 'please continue real development');
    expect(taskSyncDeliveryPaused(f.project, f.child.id)).toBe(false);
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(f.child.id).status === 'awaiting_acceptance', 8000);
    expect(await git(f.parent.workspace, 'show', 'HEAD:after-sync.txt')).toBe('after-sync.txt');
    expect(f.store.children(f.parent.id).filter(task => task.task_kind === 'child')).toHaveLength(1);
  } finally { await f.close(); }
});
