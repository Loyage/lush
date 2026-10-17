import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo } from '../helpers.js';
import { registerHook } from '../hook-registry.js';
import { randomUUID } from 'node:crypto';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { createSignal } from '../../src/signal.js';

const rule = (name = 'registered notice') => ({ name, trigger: 'agent.returned', mode: 'persistent', enabled: true,
  actions: [{ type: 'notify', title: name, body: 'ok' }] });
const setup = async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root); f.main = await f.project.bootstrapMain();
  return f;
};

test('only registered explicit versions attach/update; registration and reads have no execution effects', async () => {
  const f = await setup();
  try {
    const p = f.project, dispatcher = new Dispatcher(p, createSignal(), {}), main = f.main;
    expect(() => p.attachTaskHook(main.id, rule(), p.taskHooks(main.id).revision)).toThrow('registered mount');
    await expect(dispatcher.dispatch('worker.hook_attach', { id: main.id, hook: rule(), expected_revision: p.taskHooks(main.id).revision })).rejects.toThrow('registered mount');
    const before = p.hooksList(), reference = registerHook(p, rule());
    expect(() => p.attachTaskHook(main.id, { template_id: reference.template_id }, p.taskHooks(main.id).revision)).toThrow('explicit');
    const attached = p.attachTaskHook(main.id, reference, p.taskHooks(main.id).revision), mount = attached.mounts.at(-1);
    expect(mount).toMatchObject({ registry_id: reference.template_id, registry_version: 1, legacy: false });
    expect(p.hooksList().registry.items.find(item => item.id === reference.template_id)).toMatchObject({ origin: 'custom', version: 1,
      mount_count: 1, targets_complete: true, mountable: true, targets: [{ worker_id: main.id, hook_id: mount.id, version: 1 }] });
    await expect(p.updateTaskHook(main.id, mount.id, undefined, attached.revision, rule('bypass'))).rejects.toThrow('registered mount');
    expect(() => p.removeHookTemplate(reference.template_id, p.hooksList().revision)).toThrow('still mounted');
    expect(() => p.saveHookTemplate(rule(), before.registry.revision)).toThrow('revision changed');
    expect(() => p.removeHookTemplate('system:input-signal', p.hooksList().revision)).toThrow('read-only');
    expect(() => p.saveHookTemplate({ id: 'system:input-signal', ...rule() }, p.hooksList().revision)).toThrow('read-only');
    expect(() => p.attachTaskHook(main.id, { template_id: 'system:input-signal', template_version: 1 }, p.taskHooks(main.id).revision)).toThrow('read-only');
    const snapshot = f.store.all('SELECT * FROM meta ORDER BY key'), events = f.store.get('SELECT count(*) AS n FROM events').n;
    for (let i = 0; i < 3; i++) { p.hooksList(); p.taskHooks(main.id); }
    expect(f.store.all('SELECT * FROM meta ORDER BY key')).toEqual(snapshot);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(events);
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='registered notice'").n).toBe(0);
    expect(p.hooksList().registry.complete).toBe(true);
    expect(p.hooksList().registry.items.some(item => item.id === 'system:input-signal' && item.readonly)).toBe(true);
  } finally { await f.close(); }
});

test('definition and command edits do not mutate mounted execution; explicit version selection upgrades it', async () => {
  const f = await setup();
  try {
    const p = f.project, main = f.main, output = path.join(f.root, '.lush', 'pinned-result');
    const command = p.saveShortcutCommand({ name: 'pin shell', command: `printf old >> '${output}'` }, p.shortcutCommands().revision).commands.items.at(-1);
    const definition = { name: 'pin shell feature', trigger: 'worker.merge_received', mode: 'persistent', enabled: true,
      actions: [{ type: 'command', command_id: command.id }] };
    const reference = registerHook(p, definition), attached = p.attachTaskHook(main.id, reference, p.taskHooks(main.id).revision), mount = attached.mounts.at(-1);
    p.saveShortcutCommand({ id: command.id, name: 'pin shell', command: `printf new >> '${output}'` }, p.shortcutCommands().revision);
    p.saveHookTemplate({ ...definition, id: reference.template_id, name: 'new feature definition' }, p.hooksList().revision);
    expect(p.taskHooks(main.id).mounts.find(item => item.id === mount.id)).toMatchObject({ registry_version: 1, name: 'pin shell feature', actions: [{ command_version: 1 }] });
    p.emitTaskHook(main.id, 'worker.merge_received', f.store.event(main.id, 'test.merge', {})); await p.hookQueue;
    expect(fs.readFileSync(output, 'utf8')).toBe('old');
    expect(p.shortcutCommandHistory().items[0]).toMatchObject({ command_version: 1, status: 'succeeded' });
    await p.updateTaskHook(main.id, mount.id, undefined, p.taskHooks(main.id).revision, { template_id: reference.template_id, template_version: 2 });
    p.emitTaskHook(main.id, 'worker.merge_received', f.store.event(main.id, 'test.merge', {})); await p.hookQueue;
    expect(fs.readFileSync(output, 'utf8')).toBe('oldnew');
    expect(p.taskHooks(main.id).mounts.find(item => item.id === mount.id)).toMatchObject({ registry_version: 2, name: 'new feature definition' });
    expect(p.hooksList().registry.items.find(item => item.id === reference.template_id).versions).toEqual([1, 2]);
  } finally { await f.close(); }
});

test('explicit legacy upgrade preserves identity, enabled state, receipts and dedupe without replay', async () => {
  const f = await setup();
  try {
    const p = f.project, existing = JSON.parse(f.store.task(f.main.id).hooks), legacy = { ...rule('legacy'), id: 'legacy-mount',
      enabled: false, state: 'succeeded', last_source: 'agent.returned:123', receipts: [{ index: 0, notice_id: 999 }],
      last_execution: { id: 123, status: 'succeeded', trigger: 'agent.returned' } };
    existing.mounts.push(legacy); f.store.update(f.main.id, { hooks: JSON.stringify(existing) });
    const original = f.store.task(f.main.id).hooks, registry = p.hooksList().registry;
    expect(registry.legacy_mount_count).toBe(1);
    expect(f.store.task(f.main.id).hooks).toBe(original);
    const before = f.store.get('SELECT count(*) AS n FROM notices').n;
    p.upgradeHookRegistry(registry.upgrade_revision);
    const upgraded = JSON.parse(f.store.task(f.main.id).hooks).mounts.find(item => item.id === legacy.id);
    expect(upgraded).toMatchObject(legacy);
    expect(upgraded.registry_version).toBe(1); expect(typeof upgraded.registry_id).toBe('string');
    expect(p.hooksList().registry.legacy_mount_count).toBe(0);
    expect(f.store.get('SELECT count(*) AS n FROM notices').n).toBe(before);
    expect(() => p.upgradeHookRegistry(registry.upgrade_revision)).toThrow('revision changed');
  } finally { await f.close(); }
});

test('legacy command mounts retain latest compatibility until explicit upgrade, then execute the fixed version and keep template identity', async () => {
  const f = await setup();
  try {
    const p = f.project, output = path.join(f.config.home, 'legacy-shell-result');
    const command = p.saveShortcutCommand({ name: 'legacy command', command: `printf old >> '${output}'` }, p.shortcutCommands().revision).commands.items.at(-1);
    p.saveShortcutCommand({ id: command.id, name: 'legacy command', command: `printf current >> '${output}'` }, p.shortcutCommands().revision);
    const definition = { name: 'legacy command feature', trigger: 'worker.merge_received', mode: 'persistent', enabled: true,
      conditions: {}, actions: [{ type: 'command', command_id: command.id, command_version: 999 }] };
    const templateId = randomUUID(), library = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='hook_templates'").value);
    library.templates.push({ id: templateId, definition });
    f.store.run("UPDATE meta SET value=? WHERE key='hook_templates'", JSON.stringify(library));
    const state = JSON.parse(f.store.task(f.main.id).hooks);
    state.mounts.push({ ...definition, id: 'legacy-command-mount', state: 'idle', last_execution: null });
    f.store.update(f.main.id, { hooks: JSON.stringify(state) });
    expect(p.hooksList().registry.items.find(item => item.id === templateId).mountable).toBe(false);
    expect(() => p.attachTaskHook(f.main.id, { template_id: templateId, template_version: 1 }, p.taskHooks(f.main.id).revision)).toThrow('explicit hooks.upgrade');
    const projected = p.taskHooks(f.main.id).mounts.find(item => item.id === 'legacy-command-mount');
    expect(projected).toMatchObject({ legacy: true, enabled: true, reason: null });
    expect(projected.actions[0]).not.toHaveProperty('command_version');
    p.emitTaskHook(f.main.id, 'worker.merge_received', f.store.event(f.main.id, 'test.merge', {})); await p.hookQueue;
    expect(fs.readFileSync(output, 'utf8')).toBe('current');
    const before = JSON.parse(f.store.task(f.main.id).hooks).mounts.find(item => item.id === 'legacy-command-mount');
    p.upgradeHookRegistry(p.hooksList().registry.upgrade_revision);
    const upgraded = JSON.parse(f.store.task(f.main.id).hooks).mounts.find(item => item.id === before.id);
    expect(upgraded).toMatchObject({ ...before, registry_id: templateId, registry_version: 2,
      actions: [{ type: 'command', command_id: command.id, command_version: 2 }] });
    p.saveShortcutCommand({ id: command.id, name: 'legacy command', command: `printf later >> '${output}'` }, p.shortcutCommands().revision);
    p.emitTaskHook(f.main.id, 'worker.merge_received', f.store.event(f.main.id, 'test.merge', {})); await p.hookQueue;
    expect(fs.readFileSync(output, 'utf8')).toBe('currentcurrent');
    expect(p.shortcutCommandHistory().items[0].command_version).toBe(2);
  } finally { await f.close(); }
});

test('legacy Prompt mount claims latest rather than an ignored stale version', async () => {
  const f = await setup();
  try {
    const p = f.project, command = p.saveShortcutCommand({ name: 'legacy prompt', kind: 'prompt', prompt: 'old prompt' }, p.shortcutCommands().revision).commands.items.at(-1);
    p.saveShortcutCommand({ id: command.id, name: 'legacy prompt', kind: 'prompt', prompt: 'current prompt' }, p.shortcutCommands().revision);
    const state = JSON.parse(f.store.task(f.main.id).hooks);
    state.mounts.push({ name: 'legacy prompt feature', id: 'legacy-prompt-mount', trigger: 'worker.parent_ready', mode: 'once', enabled: true,
      conditions: {}, actions: [{ type: 'prompt_command', command_id: command.id, command_version: 999 }], state: 'idle', last_execution: null });
    f.store.update(f.main.id, { hooks: JSON.stringify(state) });
    p.emitTaskHook(f.main.id, 'worker.parent_ready'); await p.hookQueue;
    const history = p.shortcutCommandHistory().items[0];
    expect(history).toMatchObject({ command_version: 2, status: 'succeeded' });
    expect(f.store.task(history.created_worker_id).goal).toBe('current prompt');
  } finally { await f.close(); }
});

test('legacy upgrade rejects in-flight state atomically without changing registrations or receipts', async () => {
  const f = await setup();
  try {
    const state = JSON.parse(f.store.task(f.main.id).hooks);
    state.mounts.push({ ...rule('in-flight legacy'), id: 'in-flight-legacy', state: 'running', last_execution: { id: 123, status: 'running' } });
    f.store.update(f.main.id, { hooks: JSON.stringify(state) });
    const before = f.store.all('SELECT * FROM meta ORDER BY key'), hooks = f.store.task(f.main.id).hooks;
    expect(() => f.project.upgradeHookRegistry(f.project.hooksList().registry.upgrade_revision)).toThrow('in-flight');
    expect(f.store.all('SELECT * FROM meta ORDER BY key')).toEqual(before); expect(f.store.task(f.main.id).hooks).toBe(hooks);
    // Do not let fixture shutdown interpret this deliberately manufactured started claim as a real action.
    state.mounts.pop(); f.store.update(f.main.id, { hooks: JSON.stringify(state) });
  } finally { await f.close(); }
});

test('registered Shell restart unknown never replays; explicit enable resumes only future triggers', async () => {
  const f = await setup();
  try {
    const p = f.project, output = path.join(f.config.home, 'restart-unknown');
    const command = p.saveShortcutCommand({ name: 'unknown shell', command: `printf future >> '${output}'` }, p.shortcutCommands().revision).commands.items.at(-1);
    const reference = registerHook(p, { name: 'unknown shell feature', trigger: 'worker.merge_received', mode: 'persistent', enabled: true,
      actions: [{ type: 'command', command_id: command.id }] });
    const attached = p.attachTaskHook(f.main.id, reference, p.taskHooks(f.main.id).revision).mounts.at(-1);
    const executionId = f.store.event(f.main.id, 'hook.command_submitted', { hook_id: attached.id, trigger: 'worker.merge_received', source_id: 1 });
    const state = JSON.parse(f.store.task(f.main.id).hooks), mount = state.mounts.find(item => item.id === attached.id);
    Object.assign(mount, { state: 'running', command_pending: 1, command_started_index: 0, receipts: [],
      last_execution: { id: executionId, status: 'running', trigger: mount.trigger, created_at: new Date().toISOString() } });
    f.store.update(f.main.id, { hooks: JSON.stringify(state) });
    p.recoverCommandTaskHooks();
    expect(p.taskHooks(f.main.id).mounts.find(item => item.id === mount.id)).toMatchObject({ enabled: false, state: 'unknown' });
    expect(fs.existsSync(output)).toBe(false);
    await p.updateTaskHook(f.main.id, mount.id, true, p.taskHooks(f.main.id).revision);
    await p.hookQueue; expect(fs.existsSync(output)).toBe(false);
    p.emitTaskHook(f.main.id, 'worker.merge_received', f.store.event(f.main.id, 'test.future_merge', {})); await p.hookQueue;
    expect(fs.readFileSync(output, 'utf8')).toBe('future');
    expect(p.shortcutCommandHistory().items).toHaveLength(1);
  } finally { await f.close(); }
});

test('registration revisions and durable keys fail atomically, and legacy upgrade includes command revision', async () => {
  const f = await setup();
  try {
    const p = f.project, before = p.hooksList();
    const params = { command: { name: 'register transaction', command: 'true' },
      hook: { name: 'register transaction feature', trigger: 'worker.merge_received', mode: 'persistent', enabled: false },
      expected_revisions: { commands: before.commands.revision, registry: before.registry.revision }, client_request_id: 'transaction-key' };
    const receipt = p.registerCommandHook(params), after = p.hooksList();
    expect(p.registerCommandHook(params)).toEqual(receipt);
    expect(() => p.registerCommandHook({ ...params, command: { ...params.command, command: 'false' } })).toThrow('different automation registration');
    expect(() => p.registerCommandHook({ ...params, client_request_id: 'stale-key' })).toThrow('revision changed');
    expect(p.hooksList()).toEqual(after);
    p.saveShortcutCommand({ id: receipt.command_id, name: 'register transaction', command: 'false' }, p.shortcutCommands().revision);
    expect(() => p.upgradeHookRegistry(after.registry.upgrade_revision)).toThrow('revision changed');
  } finally { await f.close(); }
});

test('trusted input condition and maintenance paths associate protected registrations without exposing raw public mounts', async () => {
  const f = await setup();
  try {
    const p = f.project, source = (await p.order('condition source', 'main', [], null, false)).task;
    const emitted = await p.emitBufferedInput({ content: 'after settled', branch: 'main', conditions: [{ kind: 'worker_settled', worker_id: source.id }] });
    const signal = p.taskHooks(source.id).mounts.find(mount => mount.kind === 'input_signal');
    expect(signal).toMatchObject({ registry_id: 'system:input-signal', registry_version: 1, locked: true, removable: false });
    expect(p.hooksList().registry.items.find(item => item.id === 'system:input-signal').mount_count).toBe(1);
    expect(() => p.removeTaskHook(source.id, signal.id, p.taskHooks(source.id).revision)).toThrow('input condition');
    p.cancelInputEmission(emitted.draft_id, f.store.draft(emitted.draft_id).revision);
    expect(p.hooksList().registry.items.find(item => item.id === 'system:input-signal').mount_count).toBe(0);
    p.mountInterruptionNotice(f.store.task(source.id), { run_id: 1, invocation_id: 'controlled-invocation' }, 'controlled-batch');
    expect(p.taskHooks(source.id).mounts.at(-1)).toMatchObject({ registry_id: 'system:interruption-notice', registry_version: 1, locked: true });
    expect(p.hooksList().registry.items.find(item => item.id === 'system:interruption-notice').mount_count).toBe(1);
    f.store.update(source.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested', commit: source.base_commit }) });
    const deferred = p.deferOrderHook(f.store.task(f.main.id), 'deferred input', [], null, false);
    expect(deferred.hooks.mounts.find(mount => mount.id === deferred.hook_id)).toMatchObject({ registry_id: 'system:deferred-order', registry_version: 1 });
    expect(p.hooksList().registry.items.find(item => item.id === 'system:deferred-order').mount_count).toBe(1);
  } finally { await f.close(); }
});

test('real child creation keeps registered built-in completion locked across all legacy and new setters', async () => {
  const f = await setup();
  try {
    const p = f.project, parent = (await p.order('parent', 'main', [], null, false)).task;
    const child = await p.spawn(parent.id, 'locked child');
    const hooks = p.taskHooks(child.id);
    expect(hooks.completion).toMatchObject({ locked: true, editable: false, min_level: 'merge' });
    expect(hooks.mounts.filter(mount => ['auto-merge','auto-accept'].includes(mount.id)).every(mount => mount.registry_id === 'builtin:completion' && mount.registry_version === 1 && mount.locked)).toBe(true);
    await expect(p.setTaskCompletion(child.id, 'off', hooks.revision)).rejects.toThrow();
    await expect(p.setTaskAutoMerge(child.id, false)).rejects.toThrow();
    await expect(p.updateTaskHook(child.id, 'auto-merge', false, hooks.revision)).rejects.toThrow();
    expect(p.hooksList().registry.items.find(item => item.id === 'builtin:completion').targets.some(target => target.worker_id === child.id)).toBe(true);
  } finally { await f.close(); }
});

test('registry target summaries are bounded but counts are complete, private runtime configuration is absent', async () => {
  const f = await setup();
  try {
    const reference = registerHook(f.project, rule('bounded'));
    for (let i = 0; i < 105; i++) {
      const task = f.store.create({ role: 'agent', goal: 'PRIVATE_GOAL', task_kind: 'order' });
      f.store.update(task.id, { hooks: JSON.stringify({ version: 1, observed: {}, mounts: [{ ...rule('bounded'), id: `mount-${i}`,
        registry_id: reference.template_id, registry_version: 1, state: 'idle', private_profile: { env: { SECRET: 'PRIVATE_SECRET' } } }] }) });
    }
    const registry = f.project.hooksList().registry, item = registry.items.find(item => item.id === reference.template_id);
    expect(item).toMatchObject({ mount_count: 105, targets_complete: false }); expect(item.targets).toHaveLength(100);
    expect(JSON.stringify(registry)).not.toContain('PRIVATE_');
  } finally { await f.close(); }
});

test('retired atomic install rejects at Project/RPC without a registration or mount', async () => {
  const f = await setup();
  try {
    const p = f.project, before = p.hooksList(), dispatcher = new Dispatcher(p, createSignal(), {});
    expect(() => p.installCommandHook({})).toThrow('retired');
    await expect(dispatcher.dispatch('hooks.install', {})).rejects.toThrow('retired');
    expect(p.hooksList()).toEqual(before);
  } finally { await f.close(); }
});
