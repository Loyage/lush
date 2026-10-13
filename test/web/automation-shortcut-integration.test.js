import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gate, repo } from '../helpers.js';
import { setup, fetch } from './harness.js';

const post = (f, method, params) => fetch(f.url + '/api/action', { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
async function action(f, method, params) {
  const response = await post(f, method, params), value = await response.json();
  expect(response.status).toBe(200); return value;
}
const catalogue = async f => (await fetch(f.url + '/api/hooks')).json();
const history = async (f, query = '') => (await fetch(f.url + '/api/hooks/commands/executions' + query)).json();
const drain = async f => { await f.project.hookQueue; };
// Existing pre-retirement manual runs are audit fixtures, not execution calls.
function historical(f, item, worker, status) {
  const execution_id = randomUUID();
  f.project.claimShortcutExecution(item.id, 1, worker.id, execution_id, 'manual');
  if (status !== 'pending') f.project.finishShortcutExecution(item.id, execution_id, worker.id, status);
  return { execution_id };
}
const commandView = (model, id) => model.commands.items.find(item => item.id === id);

// Real temporary HTTP -> RPC -> SQLite -> Git/Shell; never touches the user's daemon.
test('HTTP saves main default, preserves omitted config, follows edits and keeps Hook execution at its mount', async () => {
  const f = await setup(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  try {
    await repo(f.root); const main = await f.project.bootstrapMain();
    const created = await action(f, 'order.submit', { content: 'directory fixture', branch: 'main', start: false });
    const worker = created.task;
    const definition = { name: 'directory fixture', command: 'printf proof > shortcut-proof', default_worker_id: main.id };
    let model = await action(f, 'hooks.command_save', { command: definition, expected_revision: (await catalogue(f)).commands.revision });
    const id = model.commands.items.at(-1).id;
    expect(commandView(model, id)).toMatchObject({ default_worker_id: main.id, version: 1 });
    expect(commandView(model, id)).not.toHaveProperty('authorized');
    for (const method of ['hooks.command_start', 'hooks.command_run'])
      expect((await post(f, method, { id, version: 1, worker_id: main.id, expected_revision: model.commands.revision })).status).toBe(400);
    expect((await history(f)).items).toEqual([]);
    expect(fs.existsSync(path.join(f.root, 'shortcut-proof'))).toBe(false);
    model = await catalogue(f);
    model = await action(f, 'hooks.command_save', { command: { id, name: definition.name, command: definition.command }, expected_revision: model.commands.revision });
    expect(commandView(model, id)).toMatchObject({ default_worker_id: main.id, version: 2 });
    const hook = await action(f, 'worker.hook_attach', { id: worker.id, expected_revision: f.project.taskHooks(worker.id).revision,
      hook: { name: 'mount directory', trigger: 'worker.merge_received', mode: 'persistent', enabled: true,
        actions: [{ type: 'command', command_id: id, command_version: 2 }] } });
    f.project.emitTaskHook(worker.id, 'worker.merge_received', f.store.event(worker.id, 'test.merge', {}));
    await f.project.hookQueue;
    expect(fs.readFileSync(path.join(worker.workspace, 'shortcut-proof'), 'utf8')).toBe('proof');
    expect(f.project.taskHooks(worker.id).mounts.find(item => item.id === hook.mounts.at(-1).id).state).toBe('succeeded');
    model = await catalogue(f);
    model = await action(f, 'hooks.command_save', { command: { id, ...definition, default_worker_id: null }, expected_revision: model.commands.revision });
    expect(commandView(model, id)).toMatchObject({ default_worker_id: null, version: 3 });
    expect((await post(f, 'hooks.command_start', { id, version: 1, worker_id: main.id, expected_revision: model.commands.revision })).status).toBe(400);
    expect((await post(f, 'hooks.command_save', { command: { id, ...definition, default_worker_id: 999999 }, expected_revision: model.commands.revision })).status).toBe(400);
  } finally { await drain(f); await f.close(); }
});

for (const state of ['cancelled', 'child']) test(`HTTP omitted ${state} historical default survives edits/type conversion without routing either Hook to it`, async () => {
  const f = await setup(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  try {
    await repo(f.root); const main = await f.project.bootstrapMain();
    const old = (await action(f, 'order.submit', { content: 'historical default', branch: 'main', start: false })).task;
    let model = await action(f, 'hooks.command_save', { command: { name: 'old default', command: 'pwd > .lush/http-default-proof', default_worker_id: old.id },
      expected_revision: (await catalogue(f)).commands.revision });
    const id = model.commands.items.at(-1).id;
    if (state === 'cancelled') f.project.cancel(old.id);
    else f.store.run("UPDATE tasks SET task_kind='child' WHERE id=?", old.id);
    model = await action(f, 'hooks.command_save', { command: { id, name: 'metadata edit', command: 'pwd > .lush/http-default-proof', description: 'edited' },
      expected_revision: model.commands.revision });
    expect(commandView(model, id)).toMatchObject({ version: 2, default_worker_id: old.id, description: 'edited' });
    await action(f, 'worker.hook_attach', { id: main.id, expected_revision: f.project.taskHooks(main.id).revision,
      hook: { name: 'real Shell mount', trigger: 'worker.merge_received', mode: 'once', enabled: true,
        actions: [{ type: 'command', command_id: id, command_version: 2 }] } });
    f.project.emitTaskHook(main.id, 'worker.merge_received'); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'http-default-proof'), 'utf8').trim()).toBe(f.root);
    expect(fs.existsSync(path.join(old.workspace, '.lush/http-default-proof'))).toBe(false);
    model = await catalogue(f);
    const convert = { id, name: 'converted prompt', kind: 'prompt', prompt: 'HTTP default compatibility' };
    const revision = model.commands.revision, events = f.store.get('SELECT count(*) AS n FROM events').n;
    expect((await post(f, 'hooks.command_save', { command: { ...convert, default_worker_id: old.id }, expected_revision: revision })).status).toBe(400);
    expect((await catalogue(f)).commands.revision).toBe(revision); expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(events);
    model = await action(f, 'hooks.command_save', { command: convert, expected_revision: revision });
    expect(commandView(model, id)).toMatchObject({ kind: 'prompt', version: 3, default_worker_id: old.id, description: 'edited' });
    expect(commandView(model, id).command).toBeUndefined();
    expect(JSON.parse(f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value).items.find(item => item.id === id).default_worker_id).toBe(old.id);
    await action(f, 'worker.hook_attach', { id: main.id, expected_revision: f.project.taskHooks(main.id).revision,
      hook: { name: 'real prompt parent', trigger: 'worker.parent_ready', mode: 'once', enabled: true,
        actions: [{ type: 'prompt_command', command_id: id, command_version: 3 }] } });
    await Promise.resolve(); await f.project.hookQueue;
    const created = (await history(f)).items.find(item => item.kind === 'prompt');
    expect(created).toMatchObject({ source: 'hook', status: 'succeeded', worker_id: main.id });
    expect(f.store.task(created.created_worker_id).parent_id).toBe(main.id);
    expect(commandView(await catalogue(f), id).default_worker_id).toBe(old.id);
  } finally { await drain(f); await f.close(); }
});

test('HTTP history deletes only settled records, clears beyond loaded pages, retains audit and protects pending/unknown', async () => {
  const f = await setup(), held = gate(); let queued;
  f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  try {
    await repo(f.root); const main = await f.project.bootstrapMain();
    let model = await action(f, 'hooks.command_save', { command: { name: 'safe history', command: 'printf PRIVATE_OUTPUT', default_worker_id: main.id },
      expected_revision: (await catalogue(f)).commands.revision });
    const item = model.commands.items.at(-1);
    const done = historical(f, item, main, 'succeeded');
    await drain(f);
    expect((await history(f, `?execution_id=${done.execution_id}`)).items[0].status).toBe('succeeded');
    const audit = f.store.all("SELECT * FROM events WHERE json_extract(data,'$.execution_id')=?", done.execution_id);
    expect(await action(f, 'hooks.command_history_remove', { execution_id: done.execution_id })).toEqual({ removed_count: 1 });
    expect(await action(f, 'hooks.command_history_remove', { execution_id: done.execution_id })).toEqual({ removed_count: 0 });
    expect((await history(f, `?execution_id=${done.execution_id}`)).items).toEqual([]);
    expect(commandView(await catalogue(f), item.id).last_execution).toBeNull();
    for (const row of audit) expect(f.store.get('SELECT * FROM events WHERE id=?', row.id)).toEqual(row);

    const unknown = randomUUID();
    f.store.event(main.id, 'shortcut.command_started', { execution_id: unknown, command_id: item.id, version: 1 });
    f.store.event(main.id, 'shortcut.command_unknown', { execution_id: unknown, command_id: item.id, finished_at: new Date().toISOString() });
    for (let n = 0; n < 35; n++) {
      const execution_id = randomUUID();
      f.store.event(main.id, 'shortcut.command_started', { execution_id, command_id: item.id, version: 1 });
      f.store.event(main.id, n % 2 ? 'shortcut.command_failed' : 'shortcut.command_succeeded', { execution_id, command_id: item.id, finished_at: new Date().toISOString() });
    }
    queued = f.project.workspaces.exclusive(() => held.promise);
    const pending = historical(f, item, main, 'pending');
    expect((await history(f)).has_more).toBe(true);
    for (const execution_id of [pending.execution_id, unknown])
      expect((await post(f, 'hooks.command_history_remove', { execution_id })).status).toBe(400);
    expect(await action(f, 'hooks.command_history_remove', { clear: true })).toEqual({ removed_count: 35 });
    expect(new Set((await history(f)).items.map(row => row.id))).toEqual(new Set([pending.execution_id, unknown]));
    expect(JSON.stringify(await history(f))).not.toContain('PRIVATE_OUTPUT');
    held.resolve(); await queued;
    f.project.finishShortcutExecution(item.id, pending.execution_id, main.id, 'succeeded');
    expect((await history(f, `?execution_id=${pending.execution_id}`)).items[0].status).toBe('succeeded');
    expect(await action(f, 'hooks.command_history_remove', { clear: true })).toEqual({ removed_count: 1 });
    expect((await history(f)).items.map(row => row.id)).toEqual([unknown]);
  } finally { held.resolve(); await queued; await drain(f); await f.close(); }
});
