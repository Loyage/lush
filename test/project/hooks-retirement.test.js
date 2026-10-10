import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { retiredHook } from '../hook-assertions.js';

const rule = (name, mode = 'once') => ({ name, trigger: 'agent.returned', mode, enabled: true,
  actions: [{ type: 'notify', title: name, body: 'done' }] });

test('successful one-shots free mount capacity and keep audit, templates and persistent rules', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const { task } = await f.project.order('job', 'main', [], null, false);
    const library = f.project.saveHookTemplate(rule('template'), f.project.hooksList().revision);
    const persistent = f.project.attachTaskHook(task.id, rule('persistent', 'persistent'), f.project.taskHooks(task.id).revision).mounts.at(-1);
    for (let index = 0; index < 35; index++) {
      const hook = f.project.attachTaskHook(task.id, { template_id: library.templates[0].id }, f.project.taskHooks(task.id).revision).mounts.at(-1);
      const revision = f.project.taskHooks(task.id).revision;
      const source = f.store.event(task.id, 'test.returned', {});
      f.project.emitTaskHook(task.id, 'agent.returned', source); await f.project.hookQueue;
      retiredHook(f.project, task.id, hook.id);
      expect(f.project.taskHooks(task.id).revision).not.toBe(revision);
      f.project.emitTaskHook(task.id, 'agent.returned', source); await f.project.hookQueue;
    }
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='template'").n).toBe(35);
    expect(f.project.taskHooks(task.id).mounts.filter(m => !m.builtin).map(m => m.id)).toEqual([persistent.id]);
    expect(f.project.hooksList().templates).toEqual(library.templates);
  } finally { await f.close(); }
});

test('command recovery removes a complete one-shot without a later unstarted sibling resurrecting it', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const { task } = await f.project.order('commands', 'main', [], null, false);
    const command = f.project.saveShortcutCommand({ name: 'test', command: 'true' }, f.project.shortcutCommands().revision).commands.items.at(-1);
    f.project.authorizeShortcutCommand(command.id, command.version, true, f.project.shortcutCommands().revision);
    const attach = name => f.project.attachTaskHook(task.id, { ...rule(name), actions: [{ type: 'command', command_id: command.id, command_version: command.version }] }, f.project.taskHooks(task.id).revision).mounts.at(-1);
    const completed = attach('completed'), waiting = attach('waiting');
    const data = JSON.parse(f.store.task(task.id).hooks);
    for (const [index, mount] of data.mounts.entries()) {
      mount.state = 'running'; mount.command_pending = 0;
      mount.last_execution = { id: 1000 + index, status: 'running', trigger: mount.trigger };
      mount.receipts = mount.id === completed.id ? [{ index: 0, command_result: { status: 'succeeded' } }] : [];
    }
    f.store.update(task.id, { hooks: JSON.stringify(data) });
    f.project.recoverTaskHooks(); await Promise.resolve(); await f.project.hookQueue;
    retiredHook(f.project, task.id, completed.id);
    expect(f.project.taskHooks(task.id).mounts.find(m => m.id === waiting.id).state).toBe('waiting');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='hook.command_started'", task.id).n).toBe(0);
  } finally { await f.close(); }
});

test('startup retires old successful one-shots, leaves other states untouched, and reads do not clean up', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const { task } = await f.project.order('job', 'main', [], null, false);
    const states = ['succeeded', 'failed', 'unknown', 'skipped', 'waiting'];
    const data = { version: 1, observed: {}, mounts: states.map(state => ({ ...rule(state), id: state, state,
      enabled: state === 'waiting', last_execution: { id: 123, status: state }, receipts: [] })) };
    data.mounts.push({ ...rule('persistent', 'persistent'), id: 'persistent', state: 'succeeded', last_execution: { id: 124, status: 'succeeded' } });
    const raw = JSON.stringify(data); f.store.update(task.id, { hooks: raw });
    f.project.taskHooks(task.id); f.project.inspect(task.id); f.project.hooksList();
    expect(f.store.task(task.id).hooks).toBe(raw);
    f.project.recoverTaskHooks(); f.project.recoverTaskHooks();
    expect(f.project.taskHooks(task.id).mounts.filter(m => !m.builtin).map(m => m.id)).toEqual(['failed', 'unknown', 'skipped', 'waiting', 'persistent']);
    expect(f.store.history(task.id).filter(e => e.type === 'hook.removed' && e.data.automatic)).toHaveLength(1);
    const legacyMain = await f.project.ensureMainTask();
    // Do not install the push example here: a sole completed mount releases the subscription slot.
    f.store.update(legacyMain.id, { hooks: JSON.stringify({ ...data, mounts: [data.mounts[0]] }) });
    f.project.recoverTaskHooks();
    expect(f.store.task(legacyMain.id).hooks).toBeNull();
  } finally { await f.close(); }
});
