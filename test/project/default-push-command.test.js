import { test, expect, setDefaultTimeout } from 'bun:test';
import { fixture, repo } from '../helpers.js';

setDefaultTimeout(20000);
async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); const main = await f.project.bootstrapMain();
  const example = f.project.hooksList().command_example;
  return { ...f, main, example };
}
function previousVersion(f) {
  const record = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='command_hook_example'").value);
  f.store.run("UPDATE meta SET value=? WHERE key='command_hook_example'", JSON.stringify({ ...record, version: 1 }));
}
const push = f => f.project.shortcutCommands().items.find(c => c.name === 'git push');
const mount = f => f.project.taskHooks(f.main.id).mounts.find(m => m.id === f.example.hook_id);
function legacy(f, { running = false, custom = false } = {}) {
  previousVersion(f);
  f.store.run("DELETE FROM meta WHERE key='shortcut_commands'");
  const hooks = JSON.parse(f.store.task(f.main.id).hooks), rule = hooks.mounts[0];
  const executionId = f.store.event(f.main.id, 'hook.command_submitted', { hook_id: rule.id, source_id: 12 });
  Object.assign(rule, { enabled: true, state: running ? 'running' : 'waiting', command_pending: 1,
    actions: [{ type: 'command', command: 'git push' }], receipts: [],
    last_execution: { id: executionId, trigger: rule.trigger, status: running ? 'running' : 'failed', created_at: new Date().toISOString(), finished_at: null } });
  if (running) rule.command_started_index = 0;
  if (custom) hooks.mounts.push({ ...structuredClone(rule), id: 'custom-inline', name: 'user copy', state: 'idle', command_pending: 0 });
  f.store.update(f.main.id, { hooks: JSON.stringify(hooks) });
  const templates = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='hook_templates'").value);
  templates.templates[0].definition.actions = [{ type: 'command', command: 'git push' }];
  f.store.run("UPDATE meta SET value=? WHERE key='hook_templates'", JSON.stringify(templates));
  return rule.last_execution;
}

test('built-in git push has no authorization; edits follow latest definitions but never enable an off Hook', async () => {
  const f = await setup();
  try {
    const item = push(f);
    expect(item).toMatchObject({ command: 'git push', version: 1 });
    expect(item).not.toHaveProperty('authorized'); expect(mount(f).enabled).toBe(false);
    f.project.saveShortcutCommand({ id: item.id, name: item.name, command: 'git push origin main' }, f.project.shortcutCommands().revision);
    await f.project.bootstrapMain(); expect(mount(f).enabled).toBe(false);
    await f.project.updateTaskHook(f.main.id, f.example.hook_id, true, f.project.taskHooks(f.main.id).revision);
    f.project.saveShortcutCommand({ id: item.id, name: item.name, command: 'git push' }, f.project.shortcutCommands().revision);
    await f.project.bootstrapMain(); expect(mount(f).enabled).toBe(true);
    expect(f.project.resolveShortcutCommand(mount(f).actions[0])).toMatchObject({ version: 3, command: 'git push' });
  } finally { await f.close(); }
});

test('legacy ungranted and revoked default booleans are inert; reads and bootstrap preserve storage and Hook off state', async () => {
  for (const revoked of [false, true]) {
    const f = await setup();
    try {
      previousVersion(f);
      const commands = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value);
      commands.items[0].authorized = false;
      const raw = JSON.stringify(commands);
      f.store.run("UPDATE meta SET value=? WHERE key='shortcut_commands'", raw);
      if (revoked) f.store.event(null, 'shortcut.command_authorized', { command_id: push(f).id, version: 1, authorized: false });
      f.project.hooksList(); expect(push(f)).not.toHaveProperty('authorized');
      await f.project.bootstrapMain(); expect(mount(f).enabled).toBe(false);
      expect(f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value).toBe(raw);
      expect(f.project.resolveShortcutCommand(mount(f).actions[0]).command).toBe('git push');
      const revision = f.project.shortcutCommands().revision;
      await f.project.bootstrapMain(); expect(f.project.shortcutCommands().revision).toBe(revision);
    } finally { await f.close(); }
  }
});

test('legacy built-in mount and template import into one command, discard pending triggers and preserve history', async () => {
  const f = await setup();
  try {
    const history = legacy(f, { custom: true });
    f.project.hooksList(); expect(f.project.shortcutCommands().items).toEqual([]);
    await f.project.bootstrapMain();
    const command = push(f), catalogue = f.project.hooksList();
    expect(catalogue.commands.items).toHaveLength(1); expect(command).not.toHaveProperty('authorized');
    const action = { type: 'command', command_id: command.id };
    expect(mount(f)).toMatchObject({ enabled: false, pending_count: 0, actions: [action], last_execution: history });
    expect(catalogue.templates.find(t => t.id === f.example.template_id).actions).toEqual([action]);
    const custom = JSON.parse(f.store.task(f.main.id).hooks).mounts.find(m => m.id === 'custom-inline');
    expect(custom.actions).toEqual([{ type: 'command', command: 'git push' }]);
    expect(f.project.taskHooks(f.main.id).mounts.find(m => m.id === custom.id).enabled).toBe(false);
    await f.project.updateTaskHook(f.main.id, f.example.hook_id, true, f.project.taskHooks(f.main.id).revision);
    f.project.observeTaskHooks(); await f.project.hookQueue;
    expect(f.store.history(f.main.id).filter(e => e.type === 'shortcut.command_started')).toHaveLength(0);
  } finally { await f.close(); }
});

test('deleted built-in identities and edited commands are not restored or granted', async () => {
  for (const change of ['delete', 'edit']) {
    const f = await setup();
    try {
      previousVersion(f); const item = push(f);
      if (change === 'delete') {
        f.project.removeShortcutCommand(item.id, f.project.shortcutCommands().revision);
        f.project.removeHookTemplate(f.example.template_id, f.project.hooksList().revision);
        f.project.removeTaskHook(f.main.id, f.example.hook_id, f.project.taskHooks(f.main.id).revision);
      } else f.project.saveShortcutCommand({ id: item.id, name: 'custom push', command: 'git push origin main' }, f.project.shortcutCommands().revision);
      await f.project.bootstrapMain();
      if (change === 'delete') { expect(f.project.shortcutCommands().items).toEqual([]); expect(mount(f)).toBeUndefined(); }
      else expect(f.project.shortcutCommands().items[0]).toMatchObject({ version: 2, command: 'git push origin main' });
    } finally { await f.close(); }
  }
});

test('a legacy started effect must settle as unknown before automatic default import; it is never replayed', async () => {
  const f = await setup();
  try {
    legacy(f, { running: true });
    await f.project.bootstrapMain(); expect(f.project.shortcutCommands().items).toEqual([]);
    f.project.recoverTaskHooks(); await f.project.hookQueue;
    expect(push(f)).not.toHaveProperty('authorized'); // Recovery finishes the deferred upgrade without replay.
    expect(mount(f)).toMatchObject({ state: 'unknown', last_execution: { status: 'unknown' } });
    const history = mount(f).last_execution;
    await f.project.bootstrapMain();
    expect(push(f)).not.toHaveProperty('authorized');
    expect(mount(f)).toMatchObject({ enabled: false, pending_count: 0, state: 'unknown', last_execution: history });
    expect(f.store.history(f.main.id).filter(e => e.type === 'shortcut.command_started')).toHaveLength(0);
  } finally { await f.close(); }
});
