import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';
import { Project } from '../../src/core/project.js';

setDefaultTimeout(20000);
async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); f.main = await f.project.bootstrapMain(); return f;
}
async function runningHook(f, worker) {
  const item = f.project.saveShortcutCommand({ name: 'gate command', command: 'mkdir -p .lush; printf start > .lush/hook-start; while [ ! -f .lush/hook-release ]; do sleep 0.01; done' }, f.project.shortcutCommands().revision).commands.items.at(-1);
  f.project.attachTaskHook(worker.id, { name: 'gate Hook', trigger: 'worker.merge_received', mode: 'once', enabled: true,
    actions: [{ type: 'command', command_id: item.id, command_version: 1 }] }, f.project.taskHooks(worker.id).revision);
  f.project.emitTaskHook(worker.id, 'worker.merge_received');
  const cwd = worker.workspace ?? f.root;
  await until(() => fs.existsSync(path.join(cwd, '.lush/hook-start')));
  return async () => { fs.writeFileSync(path.join(cwd, '.lush/hook-release'), 'go'); await f.project.hookQueue; };
}
async function changed(f) {
  const { task } = await f.project.order('merge source', 'main', [], null, false);
  fs.writeFileSync(path.join(task.workspace, 'delivery.txt'), 'delivered\n');
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'source change');
  await f.project.workspaces.finish(task); f.store.update(task.id, { status: 'waiting', result: 'done' });
  return f.store.task(task.id);
}

test('running parent Hook delays merge baseline fixation and settlement resumes its queue', async () => {
  const f = await setup(); let release;
  try {
    const source = await changed(f); await f.project.requestTaskMerge(source.id); release = await runningHook(f, f.main);
    await f.project.driveTaskMerge(f.main.id);
    expect(JSON.parse(f.store.task(source.id).reservation)).toMatchObject({ status: 'requested' });
    expect(JSON.parse(f.store.task(source.id).reservation).attempt_id).toBeUndefined();
    expect(f.store.all("SELECT id FROM events WHERE type='merge.baseline_fixed'")).toEqual([]);
    f.project.scheduleTaskMerge = Project.prototype.scheduleTaskMerge.bind(f.project);
    await release(); await until(() => f.store.task(source.id).integration === 'merged', 10000);
    expect(fs.readFileSync(path.join(f.root, 'delivery.txt'), 'utf8')).toBe('delivered\n');
  } finally { await release?.(); await f.close(); }
});

test('running source Hook delays automatic reservation until its real settlement', async () => {
  const f = await setup(); let release;
  try {
    const source = await changed(f); release = await runningHook(f, source);
    f.store.update(source.id, { auto_merge: JSON.stringify({ version: 1, enabled: true, locked: false }),
      reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'pending', auto_merge: true }) });
    expect(await f.project.settleQueuedMerge(source.id)).toBe(false);
    expect(JSON.parse(f.store.task(source.id).reservation).status).toBe('pending');
    f.project.scheduleTaskMerge = Project.prototype.scheduleTaskMerge.bind(f.project);
    await release(); await until(() => f.store.task(source.id).integration === 'merged', 10000);
    expect(f.store.all("SELECT id FROM events WHERE type='merge.queue_failed'")).toEqual([]);
  } finally { await release?.(); await f.close(); }
});

test('automatic acceptance waits for running Hook settlement before resource reclamation', async () => {
  const f = await setup(); let release;
  try {
    const { task } = await f.project.order('accept after Hook', 'main', [], null, false);
    await f.project.workspaces.finish(task); release = await runningHook(f, task);
    f.store.update(task.id, { status: 'awaiting_acceptance', integration: 'none', auto_merge: JSON.stringify({ version: 1, enabled: true, locked: false, level: 'accept',
      completion: { authorization: 'explicit-fixture', round: 0, executions: {}, notices: {} } }) });
    await f.project.runTaskCompletion(task.id);
    expect(f.store.all("SELECT id FROM events WHERE type='completion.execution_started'")).toEqual([]);
    await expect(f.project.acceptTask(task.id)).rejects.toThrow('shortcut command'); expect(fs.existsSync(task.workspace)).toBe(true);
    await release(); await f.project.completionQueue; await until(() => f.store.task(task.id).status === 'completed');
    release = null; expect(f.store.branch(task.branch).status).toBe('archived');
    expect(f.store.all("SELECT id FROM events WHERE type='completion.execution_failed'")).toEqual([]);
  } finally { await release?.(); await f.close(); }
});

test('ancestor acceptance waits for a cancelled descendant whose started Hook is still settling', async () => {
  const f = await setup(); let release;
  try {
    const { task: parent } = await f.project.order('ancestor', 'main', [], null, false);
    const { task: child } = await f.project.order('descendant', parent.branch, [], null, false);
    await f.project.workspaces.finish(parent); await f.project.workspaces.finish(child);
    release = await runningHook(f, child); f.project.cancel(child.id);
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', parent.id);
    f.store.update(parent.id, { status: 'awaiting_acceptance', integration: 'none', auto_merge: JSON.stringify({ version: 1, enabled: true, locked: false, level: 'accept',
      completion: { authorization: 'ancestor-fixture', round: 0, executions: {}, notices: {} } }) });
    await f.project.runTaskCompletion(parent.id);
    expect(f.store.all("SELECT id FROM events WHERE type='completion.execution_started'")).toEqual([]);
    await expect(f.project.acceptTask(parent.id)).rejects.toThrow('shortcut command');
    await release(); release = null; await f.project.completionQueue; await until(() => f.store.task(parent.id).status === 'completed');
    expect(f.store.branch(parent.branch).status).toBe('archived'); expect(f.store.branch(child.branch).status).toBe('archived');
    expect(f.store.all("SELECT id FROM events WHERE type='completion.execution_failed'")).toEqual([]);
  } finally { await release?.(); await f.close(); }
});

test('running Hooks block parent/source sync, cleanup, deletion, archive and clear without deleting safety facts', async () => {
  const f = await setup(); let release;
  try {
    const { task } = await f.project.order('cleanup target', 'main', [], null, false);
    release = await runningHook(f, f.main);
    await expect(f.project.syncTaskParent(task.id)).rejects.toThrow('parent Worker must be idle');
    expect(f.project.taskSyncBusy?.size ?? 0).toBe(0); await release(); release = null;
    release = await runningHook(f, task);
    await expect(f.project.syncTaskParent(task.id)).rejects.toThrow('shortcut command');
    await expect(f.project.resolveTaskSync(task.id)).rejects.toThrow('shortcut command');
    f.project.cancel(task.id);
    await expect(f.project.workspaces.cleanup(task.id)).rejects.toThrow('shortcut command');
    await expect(f.project.deleteTaskPreview(task.id)).rejects.toThrow('shortcut command');
    await expect(f.project.deleteTask(task.id, { revision: 'a'.repeat(64), confirm: true })).rejects.toThrow('shortcut command');
    await expect(f.project.archiveBranch(task.branch)).rejects.toThrow('shortcut command');
    expect(() => f.project.clear()).toThrow('shortcut commands');
    expect(fs.existsSync(task.workspace)).toBe(true); expect(f.store.branch(task.branch).status).toBe('active');
    await release(); expect(f.project.shortcutCommandHistory().items[0].status).toBe('succeeded');
    expect(f.project.commandHookRunning.size).toBe(0);
  } finally { await release?.(); await f.close(); }
});
