import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, repo, gate, until } from '../helpers.js';
import { Project } from '../../src/core/project.js';

setDefaultTimeout(20000);
async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); const main = await f.project.bootstrapMain(); return { ...f, main };
}
function register(f, command = 'true') {
  const item = f.project.saveShortcutCommand({ name: 'history', command }, f.project.shortcutCommands().revision).commands.items.at(-1);
  f.project.authorizeShortcutCommand(item.id, 1, true, f.project.shortcutCommands().revision); return item;
}
const start = (f, item) => f.project.startShortcutCommand(item.id, 1, f.main.id, f.project.shortcutCommands().revision);
const drain = f => Promise.all([...f.project.shortcutCommandJobs ?? []]);
const lookup = (project, execution) => project.shortcutCommandHistory({ execution_id: execution.execution_id ?? execution }).items;
const remove = (project, execution) => project.removeShortcutCommandHistory({ execution_id: execution.execution_id ?? execution });
function audit(f, item, status, source = 'manual') {
  const execution_id = randomUUID();
  const event_id = f.store.event(f.main.id, 'shortcut.command_pending', { execution_id, command_id: item.id,
    command_name: item.name, command_version: 1, source });
  if (status !== 'pending') f.store.event(f.main.id, `shortcut.command_${status === 'running' ? 'started' : status}`, { execution_id, command_id: item.id });
  return { execution_id, event_id };
}

test('single history removal hides exact, paged and last_execution projections, keeps audit and authorization, and is idempotent', async () => {
  const f = await setup();
  try {
    const item = register(f), execution = start(f, item); await drain(f);
    const events = f.store.all('SELECT * FROM events'), revision = f.project.shortcutCommands().revision;
    expect(remove(f.project, execution)).toEqual({ removed_count: 1 });
    expect(remove(f.project, execution)).toEqual({ removed_count: 0 });
    expect(remove(f.project, randomUUID())).toEqual({ removed_count: 0 });
    expect(lookup(f.project, execution)).toEqual([]); expect(f.project.shortcutCommandHistory().items).toEqual([]);
    expect(f.project.shortcutCommands()).toMatchObject({ revision, items: expect.any(Array) });
    expect(f.project.shortcutCommands().items.at(-1)).toMatchObject({ authorized: true, version: 1, last_execution: null });
    for (const event of events) expect(f.store.get('SELECT * FROM events WHERE id=?', event.id)).toEqual(event);
    expect(JSON.parse(f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value).items.at(-1).last_execution.id).toBe(execution.execution_id);
    expect(f.store.all("SELECT key,value FROM meta WHERE key LIKE 'shortcut_command_history_removed:%'")).toHaveLength(1);
    expect(f.store.all("SELECT data FROM events WHERE type='shortcut.command_history_removed'")).toHaveLength(1);
    const next = start(f, item); await drain(f);
    expect(lookup(f.project, next)[0].status).toBe('succeeded');
    expect(f.project.shortcutCommands().items.at(-1).last_execution.id).toBe(next.execution_id);
  } finally { await f.close(); }
});

test('clear skips protected states, removes succeeded/failed in bounded pages, and filters before cursor/has_more calculation', async () => {
  const f = await setup();
  try {
    const item = register(f), entries = [];
    f.store.transaction(() => {
      for (let n = 0; n < 207; n++) entries.push(audit(f, item, n % 2 ? 'succeeded' : 'failed', n % 3 ? 'manual' : 'hook'));
    });
    const pending = audit(f, item, 'pending'), running = audit(f, item, 'running'), unknown = audit(f, item, 'unknown');
    expect(remove(f.project, entries.at(-1))).toEqual({ removed_count: 1 });
    const first = f.project.shortcutCommandHistory({ limit: 2 });
    expect(first.items.map(e => e.id)).toEqual([unknown.execution_id, running.execution_id]);
    expect(first.has_more).toBe(true);
    const second = f.project.shortcutCommandHistory({ limit: 2, before: first.next_before });
    expect(second.items.map(e => e.id)).toEqual([pending.execution_id, entries.at(-2).execution_id]);
    expect(f.project.removeShortcutCommandHistory({ clear: true })).toEqual({ removed_count: 206 });
    expect(f.project.removeShortcutCommandHistory({ clear: true })).toEqual({ removed_count: 0 });
    const survivors = f.project.shortcutCommandHistory({ limit: 2 });
    expect(survivors.items.map(e => e.id)).toEqual([unknown.execution_id, running.execution_id]);
    const last = f.project.shortcutCommandHistory({ limit: 2, before: survivors.next_before });
    expect(last.items.map(e => e.id)).toEqual([pending.execution_id]);
    expect(last.has_more).toBe(false); expect(last.next_before).toBeNull();
    for (const entry of entries) expect(lookup(f.project, entry)).toEqual([]);
    expect(f.store.all("SELECT key FROM meta WHERE key LIKE 'shortcut_command_history_removed:%'")).toHaveLength(207);
    expect(f.store.all("SELECT id FROM events WHERE type IN ('shortcut.command_succeeded','shortcut.command_failed')")).toHaveLength(207);
  } finally { await f.close(); }
});

test('strict remove options and protected execution states are rejected without writes', async () => {
  const f = await setup();
  try {
    const item = register(f), protectedEntries = ['pending','running','unknown'].map(status => audit(f, item, status));
    const before = f.store.get('SELECT count(*) AS n FROM events').n;
    for (const options of [{}, null, [], { clear: false }, { clear: 1 }, { execution_id: 'bad' },
      { clear: true, execution_id: randomUUID() }, { execution_id: randomUUID(), env: 'bad' }, { clear: true, before: 1 }])
      expect(() => f.project.removeShortcutCommandHistory(options)).toThrow();
    for (const entry of protectedEntries) expect(() => remove(f.project, entry)).toThrow('cannot be removed');
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(before);
    expect(f.store.all("SELECT key FROM meta WHERE key LIKE 'shortcut_command_history_removed:%'")).toEqual([]);
  } finally { await f.close(); }
});

test('real pending and running commands cannot be removed, clear does not interfere with settlement or claims', async () => {
  const f = await setup(), held = gate(); let release;
  try {
    const item = register(f, 'printf start > .lush/started; while [ ! -f .lush/release ]; do sleep 0.01; done');
    release = f.project.workspaces.exclusive(() => held.promise);
    const execution = start(f, item);
    expect(() => remove(f.project, execution)).toThrow('cannot be removed');
    expect(f.project.removeShortcutCommandHistory({ clear: true })).toEqual({ removed_count: 0 });
    expect(f.project.shortcutCommandClaims.get(f.main.id)).toBe(execution.execution_id);
    held.resolve(); await release; await until(() => fs.existsSync(path.join(f.config.home, 'started')));
    expect(lookup(f.project, execution)[0].status).toBe('running');
    expect(() => remove(f.project, execution)).toThrow('cannot be removed');
    expect(f.project.removeShortcutCommandHistory({ clear: true })).toEqual({ removed_count: 0 });
    fs.writeFileSync(path.join(f.config.home, 'release'), 'go'); await drain(f);
    expect(remove(f.project, execution)).toEqual({ removed_count: 1 });
    expect(f.project.shortcutCommandClaims.size).toBe(0);
    expect(f.project.commandHookRunning.size).toBe(0);
  } finally { held.resolve(); fs.writeFileSync(path.join(f.config.home, 'release'), 'go'); await release; await f.close(); }
});

test('removed history stays hidden across restart and recovery still settles all outstanding roots without replay', async () => {
  const f = await setup(); let next;
  try {
    const item = register(f, 'printf BAD > .lush/replay'), execution = start(f, item); await drain(f);
    expect(remove(f.project, execution)).toEqual({ removed_count: 1 });
    fs.unlinkSync(path.join(f.config.home, 'replay'));
    const unfinished = [];
    f.store.transaction(() => {
      for (let n = 0; n < 105; n++) unfinished.push(audit(f, item, n % 2 ? 'pending' : 'running', n % 2 ? 'manual' : 'hook'));
    });
    next = new Project(f.config, f.store); next.kick = () => {}; next.recoverTaskHooks(); await next.hookQueue;
    expect(lookup(next, execution)).toEqual([]); expect(next.shortcutCommands().items.at(-1).last_execution).toBeNull();
    for (const entry of unfinished) expect(lookup(next, entry)[0].status).toBe('unknown');
    expect(fs.existsSync(path.join(f.config.home, 'replay'))).toBe(false);
    expect(next.removeShortcutCommandHistory({ clear: true })).toEqual({ removed_count: 0 });
    const count = f.store.get('SELECT count(*) AS n FROM events').n; next.recoverTaskHooks();
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(count);
    expect(remove(next, execution)).toEqual({ removed_count: 0 });
  } finally { await next?.shutdown(); await f.close(); }
});

test('Hook command history can be removed without touching mount receipts, dedup cursor, state or authorization', async () => {
  const f = await setup();
  try {
    const item = register(f, 'exit 7');
    f.project.attachTaskHook(f.main.id, { name: 'failed hook', trigger: 'worker.merge_received', mode: 'persistent', enabled: true,
      actions: [{ type: 'command', command_id: item.id, command_version: 1 }] }, f.project.taskHooks(f.main.id).revision);
    f.project.emitTaskHook(f.main.id, 'worker.merge_received'); await f.project.hookQueue;
    const execution = f.project.shortcutCommandHistory().items[0]; expect(execution).toMatchObject({ source: 'hook', status: 'failed' });
    const hooks = f.store.task(f.main.id).hooks, revision = f.project.shortcutCommands().revision;
    expect(remove(f.project, execution.id)).toEqual({ removed_count: 1 });
    expect(lookup(f.project, execution.id)).toEqual([]); expect(f.project.shortcutCommands().items.at(-1).last_execution).toBeNull();
    expect(f.store.task(f.main.id).hooks).toBe(hooks);
    expect(f.project.shortcutCommands().revision).toBe(revision);
    expect(f.project.shortcutCommands().items.at(-1).authorized).toBe(true);
    f.project.emitTaskHook(f.main.id, 'worker.merge_received'); await f.project.hookQueue;
    expect(f.store.all("SELECT id FROM events WHERE type='shortcut.command_started'")).toHaveLength(1);
  } finally { await f.close(); }
});

test('completed history survives directory deletion and can still be hidden by execution identity', async () => {
  const f = await setup();
  try {
    const item = register(f), execution = start(f, item); await drain(f);
    f.project.removeShortcutCommand(item.id, f.project.shortcutCommands().revision);
    expect(lookup(f.project, execution)[0].command_name).toBe(item.name);
    expect(remove(f.project, execution)).toEqual({ removed_count: 1 });
    expect(lookup(f.project, execution)).toEqual([]);
  } finally { await f.close(); }
});
