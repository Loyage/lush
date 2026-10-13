import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, repo, until } from '../helpers.js';
import { Project } from '../../src/core/project.js';

setDefaultTimeout(20000);
async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); f.main = await f.project.bootstrapMain(); return f;
}
function register(f, command = 'true', name = 'original name') {
  const item = f.project.saveShortcutCommand({ name, command }, f.project.shortcutCommands().revision).commands.items.at(-1);
  return item;
}
function trigger(f, item, worker = f.main) {
  const hook = f.project.attachTaskHook(worker.id, { name: 'history Hook', trigger: 'worker.merge_received', mode: 'once', enabled: true,
    actions: [{ type: 'command', command_id: item.id, command_version: 1 }] }, f.project.taskHooks(worker.id).revision).mounts.at(-1);
  f.project.emitTaskHook(worker.id, 'worker.merge_received'); return hook;
}
const lookup = (f, id) => f.project.shortcutCommandHistory({ execution_id: id }).items[0];
function legacy(f, item, status = 'succeeded') {
  const execution_id = randomUUID();
  f.store.event(f.main.id, 'shortcut.command_pending', { command_id: item.id, command_name: item.name,
    command_version: 1, execution_id, source: 'manual' });
  if (status !== 'pending') f.store.event(f.main.id, `shortcut.command_${status}`, { command_id: item.id, execution_id });
  return execution_id;
}

test('manual Project executors are absent; definition management cannot execute or create Workers', async () => {
  const f = await setup();
  try {
    for (const name of ['runShortcutCommand', 'startShortcutCommand', 'startPromptShortcutCommand']) expect(f.project[name]).toBeUndefined();
    const item = register(f, 'printf BAD > .lush/manual-proof');
    const prompt = f.project.saveShortcutCommand({ name: 'prompt', kind: 'prompt', prompt: 'do not create' }, f.project.shortcutCommands().revision).commands.items.at(-1);
    const claim = f.project.acceptPromptShortcutExecution({ type: 'prompt_command', command_id: prompt.id, command_version: 1 }, f.main.id);
    await expect(f.project.executePromptShortcutCommand(claim, f.main.id)).rejects.toThrow('requires a Hook receipt');
    await expect(f.project.executePromptShortcutCommand(claim, f.main.id, { task_id: f.main.id, hook_id: 'forged', execution_id: 1, action_index: 0 })).rejects.toThrow('创建未完成');
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
    expect(fs.existsSync(path.join(f.config.home, 'manual-proof'))).toBe(false);
    expect(f.project.shortcutCommands().items.find(c => c.id === item.id).last_execution).toBeNull();
  } finally { await f.close(); }
});

test('history contains historical manual and live Hook failures/timeouts, pages stably and never exposes output', async () => {
  const f = await setup();
  try {
    const item = register(f, 'echo PRIVATE_OUTPUT >&2; exit 7'), old = legacy(f, item), older = legacy(f, item, 'failed');
    const hook = trigger(f, item); await f.project.hookQueue;
    const first = f.project.shortcutCommandHistory({ limit: 2 });
    expect(first.items.map(e => e.source)).toEqual(['hook', 'manual']); expect(first.has_more).toBe(true);
    expect(first.items[0]).toMatchObject({ status: 'failed', command_result: { exit_code: 7 }, command_name: item.name });
    expect(first.items[1].id).toBe(older);
    const last = f.project.shortcutCommandHistory({ before: first.next_before, limit: 2 });
    expect(last.items.map(e => e.id)).toEqual([old]); expect(last.has_more).toBe(false);
    expect(JSON.stringify([first, last, f.store.all("SELECT data FROM events WHERE type LIKE 'shortcut.command_%'")])).not.toContain('PRIVATE_OUTPUT');
    expect(f.project.taskHooks(f.main.id).mounts.find(m => m.id === hook.id).state).toBe('failed');
    const slow = register(f, 'sleep 1'); f.project.commandHookOptions.timeout_ms = 10;
    trigger(f, slow); await f.project.hookQueue;
    expect(f.project.shortcutCommandHistory().items[0]).toMatchObject({ status: 'failed', command_result: { reason: 'timeout' } });
    f.project.removeShortcutCommand(item.id, f.project.shortcutCommands().revision);
    expect(lookup(f, old)).toMatchObject({ command_name: 'original name', command_version: 1, status: 'succeeded' });
  } finally { await f.close(); }
});

test('completion updates an already-paged Hook row without moving its stable event cursor', async () => {
  const f = await setup();
  try {
    const item = register(f, 'printf start > .lush/start; while [ ! -f .lush/release ]; do sleep 0.01; done');
    trigger(f, item); await until(() => fs.existsSync(path.join(f.config.home, 'start')));
    const running = f.project.shortcutCommandHistory().items[0]; expect(running.status).toBe('running');
    fs.writeFileSync(path.join(f.config.home, 'release'), 'go'); await f.project.hookQueue;
    expect(lookup(f, running.id)).toMatchObject({ event_id: running.event_id, status: 'succeeded' });
    trigger(f, item); await f.project.hookQueue;
    const page = f.project.shortcutCommandHistory({ limit: 1 });
    expect(page.items[0].id).not.toBe(running.id);
    expect(f.project.shortcutCommandHistory({ before: page.next_before, limit: 1 }).items[0]).toMatchObject({ id: running.id, event_id: running.event_id });
  } finally { fs.writeFileSync(path.join(f.config.home, 'release'), 'go'); await f.close(); }
});

test('legacy events remain read-only queryable without inventing names or leaking arbitrary fields', async () => {
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

test('restart marks pending/running history unknown including overwritten/deleted commands without replay or duplicate settlement', async () => {
  const f = await setup(); let next;
  try {
    const item = register(f, 'printf BAD > .lush/replay'), ids = [];
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

test('shutdown waits for started Hook commands and publishes known completion before releasing writes', async () => {
  const f = await setup();
  try {
    const item = register(f, 'printf start > .lush/start; while [ ! -f .lush/release ]; do sleep 0.01; done');
    trigger(f, item); await until(() => fs.existsSync(path.join(f.config.home, 'start')));
    const execution = f.project.shortcutCommandHistory().items[0];
    let stopped = false; const stopping = f.project.shutdown().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    fs.writeFileSync(path.join(f.config.home, 'release'), 'go'); await stopping;
    expect(lookup(f, execution.id).status).toBe('succeeded'); expect(f.project.writing).toBe(0); expect(f.project.commandHookRunning.size).toBe(0);
  } finally { fs.writeFileSync(path.join(f.config.home, 'release'), 'go'); await f.close(); }
});
