import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { HOOK_LIMITS } from '../../src/core/hooks.js';

async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); f.main = await f.project.bootstrapMain(); return f;
}
const options = (f, patch = {}) => ({ id: f.main.id, command: { name: 'new command', command: 'printf x >> .lush/install-proof' },
  hook: { name: 'merge command', trigger: 'worker.merge_received', mode: 'persistent', enabled: true },
  expected_revisions: { commands: f.project.shortcutCommands().revision, worker_hooks: f.project.taskHooks(f.main.id).revision },
  client_request_id: 'runtime-install', ...patch });
const snapshot = f => ({ commands: f.project.shortcutCommands(), hooks: f.store.task(f.main.id).hooks,
  events: f.store.all('SELECT * FROM events ORDER BY id') });

test('atomic install subscribes only to future merges; exact replay is durable and never recreates removed configuration', async () => {
  const f = await setup(); let restored;
  try {
    const oldEvent = f.store.event(f.main.id, 'worker.merge_received', {});
    const input = options(f), result = f.project.installCommandHook(input);
    expect(result).toMatchObject({ installed: true, worker_id: f.main.id });
    const mount = f.project.taskHooks(f.main.id).mounts.find(item => item.id === result.hook_id);
    expect(mount).toMatchObject({ mode: 'persistent', enabled: true, actions: [{ type: 'command', command_id: result.command_id }] });
    await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'install-proof'))).toBe(false);
    // Read/observe and an old event cannot execute a newly mounted subscription.
    f.project.emitTaskHook(f.main.id, 'worker.merge_received', oldEvent); await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'install-proof'))).toBe(false);
    const event = f.store.event(f.main.id, 'worker.merge_received', {});
    f.project.emitTaskHook(f.main.id, 'worker.merge_received', event); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'install-proof'), 'utf8')).toBe('x');
    f.project.emitTaskHook(f.main.id, 'worker.merge_received', event); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'install-proof'), 'utf8')).toBe('x');
    const before = snapshot(f);
    expect(f.project.installCommandHook(input)).toEqual(result);
    expect(snapshot(f)).toEqual(before);
    expect(() => f.project.installCommandHook({ ...input, command: { ...input.command, command: 'false' } })).toThrow('different Hook installation');
    f.project.removeTaskHook(f.main.id, result.hook_id, f.project.taskHooks(f.main.id).revision);
    f.project.removeShortcutCommand(result.command_id, f.project.shortcutCommands().revision);
    // A new Project has no in-memory dedupe state and still returns the original receipt.
    await f.project.shutdown();
    restored = new Project(f.config, f.store); restored.kick = () => {};
    expect(restored.installCommandHook(input)).toEqual(result);
    expect(restored.shortcutCommands().items.some(item => item.id === result.command_id)).toBe(false);
    expect(restored.taskHooks(f.main.id).mounts.some(item => item.id === result.hook_id)).toBe(false);
    const receipt = f.store.get("SELECT data FROM events WHERE type='hook.installed'").data;
    expect(receipt).not.toContain('printf'); expect(receipt).not.toContain(input.client_request_id);
  } finally { await restored?.shutdown(); await f.close(); }
});

for (const failure of ['commands_revision', 'worker_revision', 'closed_owner', 'hook_capacity', 'receipt_write'])
  test(`install ${failure} rolls back command, mount and audit together`, async () => {
    const f = await setup();
    try {
      const input = options(f);
      if (failure === 'commands_revision') input.expected_revisions.commands = 'stale';
      if (failure === 'worker_revision') input.expected_revisions.worker_hooks = 'stale';
      if (failure === 'closed_owner') f.store.update(f.main.id, { status: 'cancelled' });
      if (failure === 'hook_capacity') {
        const data = JSON.parse(f.store.task(f.main.id).hooks);
        while (data.mounts.length < HOOK_LIMITS.mounts) data.mounts.push({ ...data.mounts[0], id: `filled-${data.mounts.length}` });
        f.store.update(f.main.id, { hooks: JSON.stringify(data) });
        input.expected_revisions.worker_hooks = f.project.taskHooks(f.main.id).revision;
      }
      const before = snapshot(f), event = f.store.event.bind(f.store);
      if (failure === 'receipt_write') f.store.event = (...args) => {
        if (args[1] === 'hook.installed') throw new Error('simulated receipt disk failure');
        return event(...args);
      };
      expect(() => f.project.installCommandHook(input)).toThrow();
      expect(snapshot(f)).toEqual(before);
    } finally { await f.close(); }
  });

test('disabled and one-shot installs preserve normal Hook semantics; stale concurrent writers cannot create orphan commands', async () => {
  const f = await setup();
  try {
    const input = options(f, { hook: { name: 'disabled once', trigger: 'worker.merge_received', mode: 'once', enabled: false } });
    const result = f.project.installCommandHook(input);
    expect(() => f.project.installCommandHook({ ...input, client_request_id: 'other-writer' })).toThrow('revision changed');
    f.project.emitTaskHook(f.main.id, 'worker.merge_received', f.store.event(f.main.id, 'worker.merge_received', {})); await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'install-proof'))).toBe(false);
    await f.project.updateTaskHook(f.main.id, result.hook_id, true, f.project.taskHooks(f.main.id).revision);
    f.project.emitTaskHook(f.main.id, 'worker.merge_received', f.store.event(f.main.id, 'worker.merge_received', {})); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'install-proof'), 'utf8')).toBe('x');
    expect(f.project.taskHooks(f.main.id).mounts.some(item => item.id === result.hook_id)).toBe(false);
    expect(f.project.shortcutCommands().items.filter(item => item.name === input.command.name)).toHaveLength(1);
  } finally { await f.close(); }
});
