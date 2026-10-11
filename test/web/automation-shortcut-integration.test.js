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
const drain = f => Promise.all([...f.project.shortcutCommandJobs ?? []]);
const commandView = (model, id) => model.commands.items.find(item => item.id === id);

// Real temporary HTTP -> RPC -> SQLite -> Git/Shell; never touches the user's daemon.
test('HTTP saves main default, preserves omitted config, revokes changes and keeps Hook execution at its mount', async () => {
  const f = await setup(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  try {
    await repo(f.root); const main = await f.project.bootstrapMain();
    const created = await action(f, 'order.submit', { content: 'directory fixture', branch: 'main', start: false });
    const worker = created.task;
    const definition = { name: 'directory fixture', command: 'printf proof > shortcut-proof', default_worker_id: main.id };
    let model = await action(f, 'hooks.command_save', { command: definition, expected_revision: (await catalogue(f)).commands.revision });
    const id = model.commands.items.at(-1).id;
    expect(commandView(model, id)).toMatchObject({ default_worker_id: main.id, version: 1, authorized: false });
    model = await action(f, 'hooks.command_authorize', { id, version: 1, authorized: true, expected_revision: model.commands.revision });
    const accepted = await action(f, 'hooks.command_start', { id, version: 1, worker_id: main.id, expected_revision: model.commands.revision });
    await drain(f);
    expect((await history(f, `?execution_id=${accepted.execution_id}`)).items[0]).toMatchObject({ worker_id: main.id, status: 'succeeded' });
    expect(fs.readFileSync(path.join(f.root, 'shortcut-proof'), 'utf8')).toBe('proof');
    model = await catalogue(f);
    model = await action(f, 'hooks.command_save', { command: { id, name: definition.name, command: definition.command }, expected_revision: model.commands.revision });
    expect(commandView(model, id)).toMatchObject({ default_worker_id: main.id, version: 2, authorized: false });
    model = await action(f, 'hooks.command_authorize', { id, version: 2, authorized: true, expected_revision: model.commands.revision });
    const hook = await action(f, 'worker.hook_attach', { id: worker.id, expected_revision: f.project.taskHooks(worker.id).revision,
      hook: { name: 'mount directory', trigger: 'worker.merge_received', mode: 'persistent', enabled: true,
        actions: [{ type: 'command', command_id: id, command_version: 2 }] } });
    f.project.emitTaskHook(worker.id, 'worker.merge_received', f.store.event(worker.id, 'test.merge', {}));
    await f.project.hookQueue;
    expect(fs.readFileSync(path.join(worker.workspace, 'shortcut-proof'), 'utf8')).toBe('proof');
    expect(f.project.taskHooks(worker.id).mounts.find(item => item.id === hook.mounts.at(-1).id).state).toBe('succeeded');
    model = await catalogue(f);
    model = await action(f, 'hooks.command_save', { command: { id, ...definition, default_worker_id: null }, expected_revision: model.commands.revision });
    expect(commandView(model, id)).toMatchObject({ default_worker_id: null, version: 3, authorized: false });
    expect((await post(f, 'hooks.command_start', { id, version: 1, worker_id: main.id, expected_revision: model.commands.revision })).status).toBe(400);
    expect((await post(f, 'hooks.command_save', { command: { id, ...definition, default_worker_id: 999999 }, expected_revision: model.commands.revision })).status).toBe(400);
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
    model = await action(f, 'hooks.command_authorize', { id: item.id, version: 1, authorized: true, expected_revision: model.commands.revision });
    const done = await action(f, 'hooks.command_start', { id: item.id, version: 1, worker_id: main.id, expected_revision: model.commands.revision });
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
    const pending = await action(f, 'hooks.command_start', { id: item.id, version: 1, worker_id: main.id, expected_revision: (await catalogue(f)).commands.revision });
    expect((await history(f)).has_more).toBe(true);
    for (const execution_id of [pending.execution_id, unknown])
      expect((await post(f, 'hooks.command_history_remove', { execution_id })).status).toBe(400);
    expect(await action(f, 'hooks.command_history_remove', { clear: true })).toEqual({ removed_count: 35 });
    expect(new Set((await history(f)).items.map(row => row.id))).toEqual(new Set([pending.execution_id, unknown]));
    expect(JSON.stringify(await history(f))).not.toContain('PRIVATE_OUTPUT');
    held.resolve(); await queued; await drain(f);
    expect((await history(f, `?execution_id=${pending.execution_id}`)).items[0].status).toBe('succeeded');
    expect(await action(f, 'hooks.command_history_remove', { clear: true })).toEqual({ removed_count: 1 });
    expect((await history(f)).items.map(row => row.id)).toEqual([unknown]);
  } finally { held.resolve(); await queued; await drain(f); await f.close(); }
});
