import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, repo, until, gate } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { commandAdmission } from '../../src/core/project/command-hooks.js';

setDefaultTimeout(20000);
async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); const main = await f.project.bootstrapMain(); return { ...f, main };
}
function register(f, command = 'true', name = 'original name') {
  const item = f.project.saveShortcutCommand({ name, command }, f.project.shortcutCommands().revision).commands.items.at(-1);
  f.project.authorizeShortcutCommand(item.id, 1, true, f.project.shortcutCommands().revision); return item;
}
const start = (f, item, worker = f.main) => f.project.startShortcutCommand(item.id, item.version, worker.id, f.project.shortcutCommands().revision);
const lookup = (f, execution) => f.project.shortcutCommandHistory({ execution_id: execution.execution_id ?? execution }).items[0];
const drain = f => Promise.all([...f.project.shortcutCommandJobs ?? []]);

test('async acceptance returns durable pending before the Git queue drains and blocks invocation, duplicate and Hook claims', async () => {
  const f = await setup(), held = gate(); let release;
  try {
    const { task } = await f.project.order('async target', 'main', [], null, false);
    const item = register(f, 'printf PRIVATE_STDOUT; printf x > async-proof');
    release = f.project.workspaces.exclusive(() => held.promise);
    const execution = start(f, item, task);
    expect(execution instanceof Promise).toBe(false);
    expect(execution).toMatchObject({ execution: { status: 'pending', command_name: item.name, command_version: 1,
      worker_id: task.id, worker_number: task.worker_number, source: 'manual' } });
    expect(lookup(f, execution)).toMatchObject({ id: execution.execution_id, status: 'pending' });
    expect(fs.existsSync(path.join(task.workspace, 'async-proof'))).toBe(false);
    expect(commandAdmission(f.project, f.store.task(task.id)).wait).toContain('领取');
    expect(() => start(f, item, task)).toThrow('already executing');
    f.project.resumeTask(task.id); f.project.pump(); await Promise.resolve();
    expect(f.project.running.has(task.id)).toBe(false);
    expect(f.project.writing).toBeGreaterThan(0);
    let drained = false; const draining = f.project.drainWrites().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    held.resolve(); await release; await drain(f); await draining;
    expect(lookup(f, execution)).toMatchObject({ status: 'succeeded', command_result: { exit_code: 0 } });
    expect(f.project.commandHookRunning.has(task.id)).toBe(false); expect(f.project.shortcutCommandClaims.size).toBe(0);
    expect(f.project.shortcutCommandJobs.size).toBe(0);
    expect(JSON.stringify(f.project.shortcutCommandHistory())).not.toContain('PRIVATE_STDOUT');
  } finally { held.resolve(); await release; await f.close(); }
});

test('async rejects unsafe admission before recording or queuing any execution', async () => {
  const f = await setup();
  try {
    const item = register(f), before = f.project.shortcutCommandHistory().items.length;
    f.project.running.set(f.main.id, {}); expect(() => start(f, item)).toThrow('Agent'); f.project.running.clear();
    f.project.taskSyncBusy = new Set([f.main.id]); expect(() => start(f, item)).toThrow('同步'); f.project.taskSyncBusy.clear();
    f.project.stopping = true; expect(() => start(f, item)).toThrow('停止'); f.project.stopping = false;
    f.project.clearing = true; expect(() => start(f, item)).toThrow('clear'); f.project.clearing = false;
    const blocker = await f.project.order('frozen', 'main', [], null, false);
    f.store.update(blocker.task.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested' }) });
    expect(() => start(f, item)).toThrow('冻结'); f.store.update(blocker.task.id, { reservation: null });
    f.project.authorizeShortcutCommand(item.id, 1, false, f.project.shortcutCommands().revision);
    expect(() => start(f, item)).toThrow('授权');
    expect(f.project.shortcutCommandHistory().items.length).toBe(before);
    expect(f.project.shortcutCommandJobs?.size ?? 0).toBe(0);
  } finally { f.project.running.clear(); f.project.stopping = f.project.clearing = false; await f.close(); }
});

for (const mutation of ['revoke', 'revoke-reauthorize', 'edit', 'delete', 'invocation', 'sync', 'freeze']) test(`async ${mutation} during Git inspection rejects before spawn, persists failed without arbitrary exceptions or replay`, async () => {
  const f = await setup();
  try {
    const item = register(f, 'printf BAD > .lush/forbidden'), held = gate(), entered = gate();
    const original = f.project.workspaces.readGuardRef.bind(f.project.workspaces);
    f.project.workspaces.readGuardRef = async ref => { const head = await original(ref); entered.resolve(); await held.promise; return head; };
    const execution = start(f, item); await entered.promise;
    if (mutation.startsWith('revoke')) {
      f.project.authorizeShortcutCommand(item.id, 1, false, f.project.shortcutCommands().revision);
      if (mutation === 'revoke-reauthorize') f.project.authorizeShortcutCommand(item.id, 1, true, f.project.shortcutCommands().revision);
    } else if (mutation === 'edit') f.project.saveShortcutCommand({ id: item.id, name: 'new', command: 'true' }, f.project.shortcutCommands().revision);
    else if (mutation === 'delete') f.project.removeShortcutCommand(item.id, f.project.shortcutCommands().revision);
    else if (mutation === 'invocation') f.project.running.set(f.main.id, {});
    else if (mutation === 'sync') f.project.taskSyncBusy = new Set([f.main.id]);
    else f.project.branchFreeze = () => ({ reason: 'PRIVATE_FREEZE_REASON' });
    held.resolve(); await drain(f);
    expect(lookup(f, execution)).toMatchObject({ command_name: 'original name', command_version: 1, status: 'failed', command_result: { reason: 'admission' } });
    expect(fs.existsSync(path.join(f.config.home, 'forbidden'))).toBe(false);
    expect(JSON.stringify(f.project.shortcutCommandHistory())).not.toContain('PRIVATE_FREEZE_REASON');
    expect(f.store.all("SELECT id FROM events WHERE type='shortcut.command_started' AND json_extract(data,'$.execution_id')=?", execution.execution_id)).toHaveLength(0);
    expect(f.project.commandHookRunning.has(f.main.id)).toBe(false);
  } finally { f.project.running.clear(); f.project.taskSyncBusy?.clear(); await f.close(); }
});

test('independent accepted executions do not invalidate each other through library revision and retain immutable names after deletion', async () => {
  const f = await setup(), held = gate(); let release;
  try {
    const { task } = await f.project.order('parallel target', 'main', [], null, false);
    const item = register(f); release = f.project.workspaces.exclusive(() => held.promise);
    const one = start(f, item), two = start(f, item, task);
    expect(one.execution_id).not.toBe(two.execution_id);
    register(f, 'true', 'unrelated edit'); // Directory revision changes; neither target authorization did.
    held.resolve(); await release; await drain(f);
    expect(lookup(f, one).status).toBe('succeeded'); expect(lookup(f, two).status).toBe('succeeded');
    f.project.saveShortcutCommand({ id: item.id, name: 'renamed now', command: 'false' }, f.project.shortcutCommands().revision);
    f.project.removeShortcutCommand(item.id, f.project.shortcutCommands().revision);
    expect(lookup(f, one)).toMatchObject({ command_id: item.id, command_name: 'original name', command_version: 1, status: 'succeeded' });
    expect(lookup(f, two).worker_number).toBe(task.worker_number);
  } finally { held.resolve(); await release; await f.close(); }
});

test('history contains manual and Hook failures/timeouts, pages by first claim and never exposes output', async () => {
  const f = await setup();
  try {
    const item = register(f, 'echo PRIVATE_OUTPUT >&2; exit 7');
    const one = start(f, item); await drain(f);
    const sync = await f.project.runShortcutCommand(item.id, 1, f.main.id, f.project.shortcutCommands().revision);
    const hook = f.project.attachTaskHook(f.main.id, { name: 'history hook', trigger: 'worker.merge_received', mode: 'once', enabled: true,
      actions: [{ type: 'command', command_id: item.id, command_version: 1 }] }, f.project.taskHooks(f.main.id).revision).mounts.at(-1);
    f.project.emitTaskHook(f.main.id, 'worker.merge_received'); await f.project.hookQueue;
    const first = f.project.shortcutCommandHistory({ limit: 2 });
    expect(first.items).toHaveLength(2); expect(first.has_more).toBe(true);
    expect(first.items.map(e => e.source)).toEqual(['hook', 'manual']);
    expect(first.items[0]).toMatchObject({ status: 'failed', command_result: { exit_code: 7 }, command_name: item.name });
    expect(first.items[1].id).toBe(sync.execution_id);
    const last = f.project.shortcutCommandHistory({ before: first.next_before, limit: 2 });
    expect(last.items.map(e => e.id)).toEqual([one.execution_id]); expect(last.has_more).toBe(false); expect(last.next_before).toBeNull();
    expect(JSON.stringify([first, last, f.store.all("SELECT data FROM events WHERE type LIKE 'shortcut.command_%'")])).not.toContain('PRIVATE_OUTPUT');
    expect(f.project.taskHooks(f.main.id).mounts.find(m => m.id === hook.id).state).toBe('failed');
    const slow = register(f, 'sleep 1'); f.project.commandHookOptions.timeout_ms = 10;
    const timeout = start(f, slow); await drain(f);
    expect(lookup(f, timeout)).toMatchObject({ status: 'failed', command_result: { reason: 'timeout' } });
  } finally { await f.close(); }
});

test('completion updates an already-paged row without moving its stable event cursor', async () => {
  const f = await setup(), held = gate(); let release;
  try {
    const item = register(f); release = f.project.workspaces.exclusive(() => held.promise);
    const one = start(f, item), cursor = lookup(f, one).event_id;
    held.resolve(); await release; await drain(f);
    expect(lookup(f, one).event_id).toBe(cursor); expect(lookup(f, one).status).toBe('succeeded');
    const two = start(f, item); await drain(f);
    const page = f.project.shortcutCommandHistory({ limit: 1 });
    expect(page.items[0].id).toBe(two.execution_id);
    expect(f.project.shortcutCommandHistory({ before: page.next_before, limit: 1 }).items[0]).toMatchObject({ id: one.execution_id, event_id: cursor });
  } finally { held.resolve(); await release; await f.close(); }
});

test('legacy events remain read-only queryable without inventing historical names or leaking arbitrary fields', async () => {
  const f = await setup();
  try {
    const item = register(f), executionId = randomUUID();
    f.store.event(f.main.id, 'shortcut.command_started', { command_id: item.id, version: 1, execution_id: executionId, command: 'PRIVATE_COMMAND', env: 'PRIVATE_ENV' });
    f.store.event(f.main.id, 'shortcut.command_succeeded', { command_id: item.id, execution_id: executionId, command_result: { status: 'succeeded', exit_code: 0,
      signal: 'PRIVATE_SIGNAL', reason: 'PRIVATE_REASON', stdout: 'PRIVATE_OUTPUT', stderr: 'PRIVATE_STDERR', env: 'PRIVATE_ENV' } });
    const count = f.store.get('SELECT count(*) AS n FROM events').n;
    expect(lookup(f, executionId)).toMatchObject({ command_name: null, source: 'unknown', command_version: 1, status: 'succeeded', command_result: { signal: null, reason: null } });
    expect(JSON.stringify(f.project.shortcutCommandHistory())).not.toContain('PRIVATE');
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(count);
    for (const options of [{ limit: 0 }, { limit: 101 }, { limit: '30' }, { before: -1 }, { execution_id: 'not-a-uuid' }, { execution_id: executionId, before: 1 }, { env: true }])
      expect(() => f.project.shortcutCommandHistory(options)).toThrow();
    expect(f.project.shortcutCommandHistory({ execution_id: randomUUID() }).items).toEqual([]);
  } finally { await f.close(); }
});

test('restart marks all pending/running history unknown including overwritten and deleted commands, without replay or duplicate settlement', async () => {
  const f = await setup(); let next;
  try {
    const item = register(f, 'printf BAD > .lush/replay');
    const ids = [];
    for (let n = 0; n < 105; n++) {
      const executionId = randomUUID(); ids.push(executionId);
      f.store.event(f.main.id, n % 2 ? 'shortcut.command_started' : 'shortcut.command_pending', {
        command_id: item.id, command_version: 1, command_name: item.name, execution_id: executionId, worker_number: 'W900-1', source: n % 2 ? 'hook' : 'manual' });
    }
    f.project.removeShortcutCommand(item.id, f.project.shortcutCommands().revision);
    next = new Project(f.config, f.store); next.kick = () => {}; next.recoverTaskHooks(); await next.hookQueue;
    for (const executionId of ids) expect(next.shortcutCommandHistory({ execution_id: executionId }).items[0]).toMatchObject({ status: 'unknown', worker_number: 'W900-1', command_result: { reason: 'interrupted' } });
    expect(fs.existsSync(path.join(f.config.home, 'replay'))).toBe(false);
    expect(f.store.all("SELECT id FROM events WHERE type='shortcut.command_unknown'")).toHaveLength(105);
    const count = f.store.get('SELECT count(*) AS n FROM events').n; next.recoverTaskHooks();
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(count);
  } finally { await next?.shutdown(); await f.close(); }
});

test('shutdown waits for started async commands and publishes known completion while releasing the write barrier', async () => {
  const f = await setup();
  try {
    const item = register(f, 'printf start > .lush/start; while [ ! -f .lush/release ]; do sleep 0.01; done');
    const execution = start(f, item); await until(() => fs.existsSync(path.join(f.config.home, 'start')));
    expect(lookup(f, execution).status).toBe('running');
    let stopped = false; const stopping = f.project.shutdown().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    fs.writeFileSync(path.join(f.config.home, 'release'), 'go'); await stopping;
    expect(lookup(f, execution).status).toBe('succeeded'); expect(f.project.writing).toBe(0);
    expect(f.project.shortcutCommandJobs.size).toBe(0); expect(f.project.commandHookRunning.size).toBe(0);
  } finally { fs.writeFileSync(path.join(f.config.home, 'release'), 'go'); await f.close(); }
});
