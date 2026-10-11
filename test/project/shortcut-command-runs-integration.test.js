import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { gate, repo } from '../helpers.js';
import { setup, fetch } from '../web/harness.js';

setDefaultTimeout(20000);

// The parent API/CLI and UI consume this exact DTO; exercise real HTTP -> RPC -> Runtime,
// rather than a mocked Project, while keeping all Shell/Git effects in a temporary project.
test('real HTTP async execution returns before Git, exposes durable safe results and retains snapshots after revocation/deletion', async () => {
  const f = await setup(), held = gate(), heldAgain = gate(); let queued, queuedAgain;
  f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  const post = async (method, params) => {
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }) });
    expect(response.status).toBe(200); return response.json();
  };
  const read = async query => {
    const response = await fetch(f.url + '/api/hooks/commands/executions' + query);
    expect(response.status).toBe(200); return response.json();
  };
  const revision = () => f.project.shortcutCommands().revision;
  const drain = () => Promise.all([...f.project.shortcutCommandJobs ?? []]);
  try {
    await repo(f.root); const main = await f.project.bootstrapMain();
    const saved = await post('hooks.command_save', { command: { name: 'submitted snapshot', command: 'printf PRIVATE_OUTPUT; printf done > .lush/integration-proof' }, expected_revision: revision() });
    const command = saved.commands.items.at(-1);
    await post('hooks.command_authorize', { id: command.id, version: 1, authorized: true, expected_revision: revision() });
    queued = f.project.workspaces.exclusive(() => held.promise);
    const params = () => ({ id: command.id, version: 1, worker_id: main.id, expected_revision: revision() });
    const accepted = await post('hooks.command_start', params());
    expect(accepted).toMatchObject({ execution: { id: accepted.execution_id, command_id: command.id,
      command_name: 'submitted snapshot', command_version: 1, worker_id: main.id, source: 'manual', status: 'pending', finished_at: null } });
    const pending = await read(`?execution_id=${accepted.execution_id}`);
    expect(pending.items).toEqual([accepted.execution]);
    expect(fs.existsSync(path.join(f.config.home, 'integration-proof'))).toBe(false);
    const count = f.store.get('SELECT count(*) AS n FROM events').n;
    await read(`?execution_id=${accepted.execution_id}`);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(count);
    held.resolve(); await queued; await drain();
    const succeeded = await read(`?execution_id=${accepted.execution_id}`);
    expect(succeeded.items[0]).toMatchObject({ event_id: accepted.execution.event_id, status: 'succeeded', command_result: { exit_code: 0 } });
    expect(fs.readFileSync(path.join(f.config.home, 'integration-proof'), 'utf8')).toBe('done');
    expect(JSON.stringify(succeeded)).not.toContain('PRIVATE_OUTPUT');

    queuedAgain = f.project.workspaces.exclusive(() => heldAgain.promise);
    const rejected = await post('hooks.command_start', params());
    await post('hooks.command_authorize', { id: command.id, version: 1, authorized: false, expected_revision: revision() });
    await post('hooks.command_remove', { id: command.id, expected_revision: revision() });
    heldAgain.resolve(); await queuedAgain; await drain();
    const newest = await read('?limit=1');
    expect(newest.items[0]).toMatchObject({ id: rejected.execution_id, command_name: 'submitted snapshot', status: 'failed', command_result: { reason: 'admission' } });
    expect(newest.has_more).toBe(true);
    const older = await read(`?before=${newest.next_before}&limit=1`);
    expect(older.items[0]).toMatchObject({ id: accepted.execution_id, command_name: 'submitted snapshot', command_version: 1, status: 'succeeded' });
    expect(older.has_more).toBe(false);
    expect((await read(`?execution_id=${rejected.execution_id}`)).items[0]).toEqual(newest.items[0]);
    expect(f.store.all("SELECT id FROM events WHERE type='shortcut.command_started' AND json_extract(data,'$.execution_id')=?", rejected.execution_id)).toEqual([]);
  } finally { held.resolve(); heldAgain.resolve(); await queued; await queuedAgain; await drain(); await f.close(); }
});
