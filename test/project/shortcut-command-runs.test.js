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
