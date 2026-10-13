import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, until } from '../helpers.js';

async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); f.main = await f.project.bootstrapMain(); return f;
}
const save = (f, value) => f.project.saveShortcutCommand(value, f.project.shortcutCommands().revision).commands.items.at(-1);
const shellRule = (item, enabled = true) => ({ name: 'latest Shell', trigger: 'worker.merge_received', mode: 'persistent', enabled,
  actions: [{ type: 'command', command_id: item.id }] });
const emit = f => f.project.emitTaskHook(f.main.id, 'worker.merge_received', f.store.event(f.main.id, 'test.merge', {}));

for (const authorized of [false, true]) test(`legacy authorization=${authorized} is inert; enabled Shell follows edits and records actual versions`, async () => {
  const f = await setup();
  try {
    const item = save(f, { name: 'latest', command: 'printf old >> .lush/latest' });
    const commands = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value);
    commands.items.at(-1).authorized = authorized;
    f.store.run("UPDATE meta SET value=? WHERE key='shortcut_commands'", JSON.stringify(commands));
    f.store.event(null, 'shortcut.command_authorized', { command_id: item.id, version: 1, authorized: false });
    const hook = f.project.attachTaskHook(f.main.id, shellRule(item), f.project.taskHooks(f.main.id).revision).mounts.at(-1);
    // Seed a genuine legacy reference; reading and editing definitions must not migrate it.
    const state = JSON.parse(f.store.task(f.main.id).hooks);
    state.mounts.find(m => m.id === hook.id).actions[0].command_version = 1;
    f.store.update(f.main.id, { hooks: JSON.stringify(state) });
    emit(f); await f.project.hookQueue;
    const old = f.project.shortcutCommandHistory().items[0], oldEvent = f.store.get("SELECT * FROM events WHERE type='shortcut.command_started' AND json_extract(data,'$.execution_id')=?", old.id);
    save(f, { id: item.id, name: 'latest v2', command: 'printf new >> .lush/latest' });
    expect(f.project.taskHooks(f.main.id).mounts.find(m => m.id === hook.id)).toMatchObject({ enabled: true });
    expect(JSON.parse(f.store.task(f.main.id).hooks).mounts.find(m => m.id === hook.id).actions[0].command_version).toBe(1);
    emit(f); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'latest'), 'utf8')).toBe('oldnew');
    expect(f.project.shortcutCommandHistory().items.map(row => row.command_version)).toEqual([2, 1]);
    expect(f.store.get('SELECT * FROM events WHERE id=?', oldEvent.id)).toEqual(oldEvent);
    expect(f.project.shortcutCommandHistory({ execution_id: old.id }).items[0]).toEqual(old);
    const active = JSON.parse(f.store.task(f.main.id).hooks).mounts.find(m => m.id === hook.id);
    expect(active.receipts[0]).toMatchObject({ command_id: item.id, command_version: 2 });
    expect(f.project.exportShortcutCommand(item.id, 2).markdown).toContain('command_version: 2');
    const disabled = f.project.attachTaskHook(f.main.id, shellRule(item, false), f.project.taskHooks(f.main.id).revision).mounts.at(-1);
    save(f, { id: item.id, name: 'metadata only', command: 'printf newer >> .lush/latest' });
    expect(f.project.taskHooks(f.main.id).mounts.find(m => m.id === disabled.id).enabled).toBe(false);
  } finally { await f.close(); }
});

for (const mutation of ['delete', 'type_switch']) test(`Shell ${mutation} after asynchronous ref read prevents body/receipt mixing and never replays`, async () => {
  const f = await setup();
  try {
    const item = save(f, { name: 'original', command: 'printf BAD > .lush/mixed' });
    const hook = f.project.attachTaskHook(f.main.id, shellRule(item), f.project.taskHooks(f.main.id).revision).mounts.at(-1);
    const original = f.project.workspaces.readGuardRef.bind(f.project.workspaces); let changed = false;
    f.project.workspaces.readGuardRef = async ref => {
      const value = await original(ref);
      if (!changed) {
        changed = true;
        if (mutation === 'delete') f.project.removeShortcutCommand(item.id, f.project.shortcutCommands().revision);
        else save(f, { id: item.id, name: item.name, kind: 'prompt', prompt: 'not Shell' });
      }
      return value;
    };
    emit(f); await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'mixed'))).toBe(false);
    expect(f.project.shortcutCommandHistory().items).toHaveLength(0);
    expect(f.project.taskHooks(f.main.id).mounts.find(m => m.id === hook.id)).toMatchObject({ enabled: false,
      state: mutation === 'delete' ? 'idle' : 'failed' });
    f.project.workspaces.readGuardRef = original;
    f.project.recoverTaskHooks(); await Promise.resolve(); await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'mixed'))).toBe(false);
  } finally { await f.close(); }
});

test('an edit after Shell spawn preserves the actual old version and pending future triggers claim the latest version', async () => {
  const f = await setup();
  try {
    const item = save(f, { name: 'old body', command: 'printf start > .lush/started; while [ ! -f .lush/release ]; do sleep 0.01; done; printf old >> .lush/after-start' });
    const hook = f.project.attachTaskHook(f.main.id, shellRule(item), f.project.taskHooks(f.main.id).revision).mounts.at(-1);
    emit(f); await until(() => fs.existsSync(path.join(f.config.home, 'started')));
    emit(f);
    save(f, { id: item.id, name: 'new body', command: 'printf new >> .lush/after-start' });
    fs.writeFileSync(path.join(f.config.home, 'release'), 'go'); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'after-start'), 'utf8')).toBe('oldnew');
    expect(f.project.shortcutCommandHistory().items.map(row => ({ version: row.command_version, status: row.status }))).toEqual([
      { version: 2, status: 'succeeded' }, { version: 1, status: 'succeeded' }]);
    expect(f.project.taskHooks(f.main.id).mounts.find(m => m.id === hook.id)).toMatchObject({ enabled: true, pending_count: 0 });
  } finally { fs.writeFileSync(path.join(f.config.home, 'release'), 'go'); await f.close(); }
});

test('disabled prompt reference follows edits at future claim; legacy ungranted definition and version do not block real creation', async () => {
  const f = await setup();
  try {
    const item = save(f, { name: 'old prompt', kind: 'prompt', prompt: 'old goal' });
    const hook = f.project.attachTaskHook(f.main.id, { name: 'latest prompt', trigger: 'worker.parent_ready', mode: 'once', enabled: false,
      actions: [{ type: 'prompt_command', command_id: item.id, command_version: 1 }] }, f.project.taskHooks(f.main.id).revision).mounts.at(-1);
    save(f, { id: item.id, name: 'new prompt', prompt: 'new goal' });
    expect(f.project.taskHooks(f.main.id).mounts.find(m => m.id === hook.id).enabled).toBe(false);
    const commands = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value);
    commands.items.at(-1).authorized = false;
    f.store.run("UPDATE meta SET value=? WHERE key='shortcut_commands'", JSON.stringify(commands));
    await f.project.updateTaskHook(f.main.id, hook.id, true, f.project.taskHooks(f.main.id).revision);
    await Promise.resolve(); await f.project.hookQueue;
    const execution = f.project.shortcutCommandHistory().items[0];
    expect(execution).toMatchObject({ kind: 'prompt', command_version: 2, status: 'succeeded' });
    expect(f.store.task(execution.created_worker_id)).toMatchObject({ goal: 'new goal', parent_id: f.main.id });
    const completed = f.store.get("SELECT data FROM events WHERE type='hook.action_completed' AND json_extract(data,'$.hook_id')=?", hook.id);
    expect(JSON.parse(completed.data)).toMatchObject({ command_id: item.id, command_version: 2 });
  } finally { await f.close(); }
});
