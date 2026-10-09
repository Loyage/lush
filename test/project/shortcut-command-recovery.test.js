import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, until } from '../helpers.js';
import { Project } from '../../src/core/project.js';

setDefaultTimeout(15000);
async function setup() {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  const main = await f.project.bootstrapMain(); return { ...f, main };
}
function command(f, text) {
  const item = f.project.saveShortcutCommand({ name: 'test', command: text }, f.project.shortcutCommands().revision).commands.items.at(-1);
  f.project.authorizeShortcutCommand(item.id, 1, true, f.project.shortcutCommands().revision); return item;
}

test('revoke of an already-started single-action Hook preserves its known successful result while discarding future triggers', async () => {
  const f = await setup();
  try {
    const item = command(f, 'printf start > .lush/start; while [ ! -f .lush/release ]; do sleep 0.01; done; printf x >> .lush/runs');
    const hook = f.project.attachTaskHook(f.main.id, { name: 'once-running', trigger: 'worker.merge_received', mode: 'persistent', enabled: true,
      actions: [{ type: 'command', command_id: item.id, command_version: 1 }] }, f.project.taskHooks(f.main.id).revision).mounts.at(-1);
    f.project.emitTaskHook(f.main.id, 'worker.merge_received'); await until(() => fs.existsSync(path.join(f.config.home, 'start')));
    f.project.emitTaskHook(f.main.id, 'worker.merge_received');
    f.project.authorizeShortcutCommand(item.id, 1, false, f.project.shortcutCommands().revision);
    fs.writeFileSync(path.join(f.config.home, 'release'), 'go'); await f.project.hookQueue;
    expect(f.project.taskHooks(f.main.id).mounts.find(m => m.id === hook.id)).toMatchObject({ enabled: false, state: 'succeeded', pending_count: 0,
      last_execution: { status: 'succeeded', command_result: { status: 'succeeded' } } });
    expect(fs.readFileSync(path.join(f.config.home, 'runs'), 'utf8')).toBe('x');
  } finally { fs.writeFileSync(path.join(f.config.home, 'release'), 'go'); await f.close(); }
});

test('manual outcome and capability release are persisted before the project write gate drains', async () => {
  const f = await setup();
  try {
    const item = command(f, 'printf start > .lush/start; while [ ! -f .lush/release ]; do sleep 0.01; done');
    const original = f.project.finishShortcutExecution.bind(f.project); let recordedWithinWrite = false;
    f.project.finishShortcutExecution = (...args) => { recordedWithinWrite = f.project.writing > 0; return original(...args); };
    const run = f.project.runShortcutCommand(item.id, 1, f.main.id, f.project.shortcutCommands().revision);
    await until(() => fs.existsSync(path.join(f.config.home, 'start')));
    f.project.clearing = true;
    const drain = f.project.drainWrites().then(() => {
      expect(f.project.shortcutCommands().items.find(c => c.id === item.id).last_execution.status).toBe('succeeded');
      expect(f.project.commandHookRunning.has(f.main.id)).toBe(false);
    });
    fs.writeFileSync(path.join(f.config.home, 'release'), 'go'); await run; await drain;
    expect(recordedWithinWrite).toBe(true); expect(f.project.shortcutCommandJobs.size).toBe(0);
  } finally { f.project.clearing = false; fs.writeFileSync(path.join(f.config.home, 'release'), 'go'); await f.close(); }
});

test('legacy started effects become unknown on recovery and explicit import never rewrites or replays their receipts', async () => {
  const f = await setup(); let next;
  try {
    const data = JSON.parse(f.store.task(f.main.id).hooks), hook = data.mounts[0];
    const executionId = f.store.event(f.main.id, 'hook.command_submitted', { hook_id: hook.id, source_id: 123 });
    Object.assign(hook, { enabled: true, state: 'running', command_pending: 1, command_started_index: 0, receipts: [],
      actions: [{ type: 'command', command: 'printf BAD > .lush/legacy-unknown' }],
      last_execution: { id: executionId, trigger: hook.trigger, status: 'running', created_at: new Date().toISOString(), finished_at: null } });
    f.store.update(f.main.id, { hooks: JSON.stringify(data) });
    next = new Project(f.config, f.store); next.kick = () => {}; next.recoverTaskHooks(); await Promise.resolve(); await next.hookQueue;
    const before = next.taskHooks(f.main.id).mounts.find(m => m.id === hook.id);
    expect(before).toMatchObject({ enabled: false, state: 'unknown', pending_count: 0, last_execution: { status: 'unknown' } });
    const result = next.importLegacyHookCommands({ worker_id: f.main.id, hook_id: hook.id }, next.taskHooks(f.main.id).revision);
    expect(result.worker_hooks.mounts.find(m => m.id === hook.id).last_execution).toEqual(before.last_execution);
    expect(result.commands.items.at(-1).authorized).toBe(false);
    next.recoverTaskHooks(); await Promise.resolve(); await next.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'legacy-unknown'))).toBe(false);
    const record = JSON.parse(f.store.task(f.main.id).hooks).mounts.find(m => m.id === hook.id);
    expect(record.receipts).toEqual([]); expect(record.last_execution.status).toBe('unknown');
  } finally { await next?.shutdown(); await f.close(); }
});
