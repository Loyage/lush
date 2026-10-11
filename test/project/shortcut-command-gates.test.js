import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, gate, until } from '../helpers.js';
import { Project } from '../../src/core/project.js';

setDefaultTimeout(20000);
async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); const main = await f.project.bootstrapMain(); return { ...f, main };
}
function command(f, body = 'true') {
  const item = f.project.saveShortcutCommand({ name: 'gate command', command: body }, f.project.shortcutCommands().revision).commands.items.at(-1);
  f.project.authorizeShortcutCommand(item.id, 1, true, f.project.shortcutCommands().revision); return item;
}
const start = (f, item, worker) => f.project.startShortcutCommand(item.id, 1, worker.id, f.project.shortcutCommands().revision);
const drain = f => Promise.all([...f.project.shortcutCommandJobs ?? []]);
async function changed(f) {
  const { task } = await f.project.order('merge source', 'main', [], null, false);
  fs.writeFileSync(path.join(task.workspace, 'delivery.txt'), 'delivered\n');
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'source change');
  await f.project.workspaces.finish(task); f.store.update(task.id, { status: 'waiting', result: 'done' });
  return f.store.task(task.id);
}

test('pending parent command delays the merge writer slot without fixing a baseline, and settlement resumes its queue', async () => {
  const f = await setup(), held = gate(); let queued;
  try {
    const source = await changed(f); await f.project.requestTaskMerge(source.id);
    const item = command(f); queued = f.project.workspaces.exclusive(() => held.promise);
    start(f, item, f.main);
    await f.project.driveTaskMerge(f.main.id);
    expect(JSON.parse(f.store.task(source.id).reservation)).toMatchObject({ status: 'requested' });
    expect(JSON.parse(f.store.task(source.id).reservation).attempt_id).toBeUndefined();
    expect(f.store.all("SELECT id FROM events WHERE type='merge.baseline_fixed'")).toEqual([]);
    f.project.scheduleTaskMerge = Project.prototype.scheduleTaskMerge.bind(f.project);
    held.resolve(); await queued; await drain(f);
    await until(() => f.store.task(source.id).integration === 'merged', 10000);
    expect(f.store.task(source.id).status).toBe('awaiting_acceptance');
    expect(fs.readFileSync(path.join(f.root, 'delivery.txt'), 'utf8')).toBe('delivered\n');
  } finally { held.resolve(); await queued; await f.close(); }
});

test('pending source command keeps automatic reservation unrequested, then settlement resumes safe-point delivery', async () => {
  const f = await setup(), held = gate(); let queued;
  try {
    const source = await changed(f);
    f.store.update(source.id, { auto_merge: JSON.stringify({ version: 1, enabled: true, locked: false }),
      reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'pending', auto_merge: true }) });
    const item = command(f); queued = f.project.workspaces.exclusive(() => held.promise); start(f, item, source);
    expect(await f.project.settleQueuedMerge(source.id)).toBe(false);
    expect(JSON.parse(f.store.task(source.id).reservation).status).toBe('pending');
    f.project.scheduleTaskMerge = Project.prototype.scheduleTaskMerge.bind(f.project);
    held.resolve(); await queued; await drain(f);
    await until(() => f.store.task(source.id).integration === 'merged', 10000);
    expect(f.store.all("SELECT id FROM events WHERE type='merge.queue_failed'")).toEqual([]);
  } finally { held.resolve(); await queued; await f.close(); }
});

test('automatic acceptance waits for pending commands without a failed claim, then command settlement resumes resource reclamation', async () => {
  const f = await setup(), held = gate(); let queued;
  try {
    const { task } = await f.project.order('accept after command', 'main', [], null, false);
    await f.project.workspaces.finish(task);
    f.store.update(task.id, { status: 'awaiting_acceptance', integration: 'none', auto_merge: JSON.stringify({ version: 1, enabled: true, locked: false, level: 'accept',
      completion: { authorization: 'explicit-fixture', round: 0, executions: {}, notices: {} } }) });
    const item = command(f); queued = f.project.workspaces.exclusive(() => held.promise); start(f, item, task);
    f.project.scheduleTaskCompletion(task.id); await f.project.runTaskCompletion(task.id);
    expect(f.store.all("SELECT id FROM events WHERE type='completion.execution_started'")).toEqual([]);
    expect(f.store.all("SELECT id FROM events WHERE type='completion.execution_failed'")).toEqual([]);
    await expect(f.project.acceptTask(task.id)).rejects.toThrow('shortcut command');
    expect(fs.existsSync(task.workspace)).toBe(true);
    held.resolve(); await queued; await drain(f); await f.project.completionQueue;
    await until(() => f.store.task(task.id).status === 'completed');
    expect(f.store.branch(task.branch).status).toBe('archived');
    expect(f.store.all("SELECT id FROM events WHERE type='completion.execution_failed'")).toEqual([]);
    expect(f.store.all("SELECT id FROM events WHERE type='task.accepted'")).toHaveLength(1);
  } finally { held.resolve(); await queued; await f.close(); }
});

test('automatic ancestor acceptance waits for a cancelled descendant whose pending command is still settling', async () => {
  const f = await setup(), held = gate(); let queued;
  try {
    const { task: parent } = await f.project.order('ancestor', 'main', [], null, false);
    const { task: child } = await f.project.order('descendant', parent.branch, [], null, false);
    await f.project.workspaces.finish(parent); await f.project.workspaces.finish(child);
    const item = command(f); queued = f.project.workspaces.exclusive(() => held.promise); start(f, item, child);
    f.project.cancel(child.id);
    // The parent has already processed the cancellation notification; only the command is outstanding.
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', parent.id);
    f.store.update(parent.id, { status: 'awaiting_acceptance', integration: 'none', auto_merge: JSON.stringify({ version: 1, enabled: true, locked: false, level: 'accept',
      completion: { authorization: 'ancestor-fixture', round: 0, executions: {}, notices: {} } }) });
    await f.project.runTaskCompletion(parent.id);
    expect(f.store.all("SELECT id FROM events WHERE type='completion.execution_started'")).toEqual([]);
    await expect(f.project.acceptTask(parent.id)).rejects.toThrow('shortcut command');
    held.resolve(); await queued; await drain(f); await f.project.completionQueue;
    await until(() => f.store.task(parent.id).status === 'completed');
    expect(f.store.branch(parent.branch).status).toBe('archived');
    expect(f.store.branch(child.branch).status).toBe('archived');
    expect(f.store.all("SELECT id FROM events WHERE type='completion.execution_failed'")).toEqual([]);
  } finally { held.resolve(); await queued; await f.close(); }
});

test('parent and source synchronization gates reject pending commands before acquiring their Git/sync slots', async () => {
  const f = await setup(), held = gate(); let queued;
  try {
    const { task } = await f.project.order('sync target', 'main', [], null, false), item = command(f);
    queued = f.project.workspaces.exclusive(() => held.promise); start(f, item, f.main);
    expect(() => f.project.assertTaskSyncable(task.id)).toThrow('parent Worker must be idle');
    await expect(f.project.syncTaskParent(task.id)).rejects.toThrow('parent Worker must be idle');
    expect(f.project.taskSyncBusy?.size ?? 0).toBe(0);
    held.resolve(); await queued; await drain(f);
    expect(() => f.project.assertTaskSyncable(task.id)).not.toThrow();
    const held2 = gate(); queued = f.project.workspaces.exclusive(() => held2.promise);
    try {
      start(f, item, task);
      await expect(f.project.syncTaskParent(task.id)).rejects.toThrow('shortcut command');
      await expect(f.project.resolveTaskSync(task.id)).rejects.toThrow('shortcut command');
      expect(f.project.taskSyncBusy?.size ?? 0).toBe(0);
    } finally { held2.resolve(); await queued; await drain(f); }
  } finally { held.resolve(); await queued; await f.close(); }
});

test('pending command blocks cancel-then-cleanup, deletion preview, ordinary archive and project clear without deleting history or resources', async () => {
  const f = await setup(), held = gate(); let queued;
  try {
    const { task } = await f.project.order('cleanup target', 'main', [], null, false), item = command(f);
    queued = f.project.workspaces.exclusive(() => held.promise); const execution = start(f, item, task);
    f.project.cancel(task.id);
    await expect(f.project.workspaces.cleanup(task.id)).rejects.toThrow('shortcut command');
    await expect(f.project.deleteTaskPreview(task.id)).rejects.toThrow('shortcut command');
    await expect(f.project.deleteTask(task.id, { revision: 'a'.repeat(64), confirm: true })).rejects.toThrow('shortcut command');
    expect(f.project.workerDeleteIds?.size ?? 0).toBe(0);
    await expect(f.project.archiveBranch(task.branch)).rejects.toThrow('shortcut command');
    expect(() => f.project.clear()).toThrow('shortcut commands');
    expect(fs.existsSync(task.workspace)).toBe(true);
    expect(f.store.branch(task.branch).status).toBe('active');
    held.resolve(); await queued; await drain(f);
    expect(f.project.shortcutCommandHistory({ execution_id: execution.execution_id }).items[0].status).toBe('failed');
    expect(f.project.commandHookRunning.size).toBe(0);
  } finally { held.resolve(); await queued; await f.close(); }
});

test('automatic claims reject new commands during acceptance/completion; a delivered Worker cannot be reopened over a cancelled command', async () => {
  const f = await setup(), held = gate(); let queued;
  try {
    const { task } = await f.project.order('claim target', 'main', [], null, false), item = command(f);
    for (const field of ['acceptanceBusy', 'completionBusy']) {
      f.project[field] = new Set([task.id]); expect(() => start(f, item, task)).toThrow('验收'); f.project[field].clear();
    }
    queued = f.project.workspaces.exclusive(() => held.promise); start(f, item, task);
    f.store.update(task.id, { status: 'completed', integration: 'merged' });
    await expect(f.project.reopenTask(task.id)).rejects.toThrow('shortcut command');
    held.resolve(); await queued; await drain(f);
  } finally { held.resolve(); await queued; await f.close(); }
});

test('unstarted Hook yielding to a manual pending claim cannot release the manual lock; later Hook dispatch remains possible', async () => {
  const f = await setup(), hookEntered = gate(), hookRelease = gate(), manualEntered = gate(), manualRelease = gate();
  try {
    const item = command(f, 'printf x >> .lush/runs');
    f.project.attachTaskHook(f.main.id, { name: 'yielding Hook', trigger: 'worker.merge_received', mode: 'persistent', enabled: true,
      actions: [{ type: 'command', command_id: item.id, command_version: 1 }] }, f.project.taskHooks(f.main.id).revision);
    const original = f.project.workspaces.workspaceForBranch.bind(f.project.workspaces); let count = 0;
    f.project.workspaces.workspaceForBranch = async branch => {
      const value = await original(branch);
      if (++count === 1) { hookEntered.resolve(); await hookRelease.promise; }
      else if (count === 2) { manualEntered.resolve(); await manualRelease.promise; }
      return value;
    };
    f.project.emitTaskHook(f.main.id, 'worker.merge_received'); await hookEntered.promise;
    start(f, item, f.main); hookRelease.resolve(); await manualEntered.promise; await f.project.hookQueue;
    expect(f.project.commandHookRunning.has(f.main.id)).toBe(true);
    expect(() => start(f, item, f.main)).toThrow('already executing');
    manualRelease.resolve(); await drain(f);
    f.project.observeTaskHooks(); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'runs'), 'utf8')).toBe('xx');
  } finally { hookRelease.resolve(); manualRelease.resolve(); await f.close(); }
});
