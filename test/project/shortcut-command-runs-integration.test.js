import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo } from '../helpers.js';
import { setup, fetch } from '../web/harness.js';

// Real HTTP -> RPC -> SQLite -> Git/Shell in a temporary project.
test('retired manual HTTP calls cannot execute; Hook history stays safe, immutable and removable after deletion', async () => {
  const f = await setup(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  const post = async (method, params, status = 200) => {
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    expect(response.status).toBe(status); return response.json();
  };
  const read = async query => {
    const response = await fetch(f.url + '/api/hooks/commands/executions' + query);
    expect(response.status).toBe(200); return response.json();
  };
  const revision = () => f.project.shortcutCommands().revision;
  try {
    await repo(f.root); const main = await f.project.bootstrapMain();
    const saved = await post('hooks.command_save', { command: { name: 'submitted snapshot', command: 'printf PRIVATE_OUTPUT; printf done > .lush/integration-proof' }, expected_revision: revision() });
    const command = saved.commands.items.at(-1);
    await post('hooks.command_authorize', { id: command.id, version: 1, authorized: true, expected_revision: revision() });
    const params = { id: command.id, version: 1, worker_id: main.id, expected_revision: revision() };
    const before = f.store.get('SELECT count(*) AS n FROM events').n;
    for (const method of ['hooks.command_start', 'hooks.command_run']) {
      const rejected = await post(method, params, 400); expect(rejected.error).toContain('method not allowed');
    }
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(before);
    expect(fs.existsSync(path.join(f.config.home, 'integration-proof'))).toBe(false); expect((await read('')).items).toEqual([]);
    await post('worker.hook_attach', { id: main.id, expected_revision: f.project.taskHooks(main.id).revision,
      hook: { name: 'HTTP Shell Hook', trigger: 'worker.merge_received', mode: 'once', enabled: true,
        actions: [{ type: 'command', command_id: command.id, command_version: 1 }] } });
    f.project.emitTaskHook(main.id, 'worker.merge_received'); await f.project.hookQueue;
    const succeeded = (await read('')).items[0];
    expect(succeeded).toMatchObject({ source: 'hook', command_name: command.name, command_version: 1, worker_id: main.id, status: 'succeeded', command_result: { exit_code: 0 } });
    expect(fs.readFileSync(path.join(f.config.home, 'integration-proof'), 'utf8')).toBe('done'); expect(JSON.stringify(succeeded)).not.toContain('PRIVATE_OUTPUT');
    const count = f.store.get('SELECT count(*) AS n FROM events').n;
    expect((await read(`?execution_id=${succeeded.id}`)).items).toEqual([succeeded]);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(count);
    await post('hooks.command_remove', { id: command.id, expected_revision: revision() });
    expect((await read(`?execution_id=${succeeded.id}`)).items).toEqual([succeeded]);
    const audit = f.store.all("SELECT * FROM events WHERE json_extract(data,'$.execution_id')=?", succeeded.id);
    expect(await post('hooks.command_history_remove', { execution_id: succeeded.id })).toEqual({ removed_count: 1 });
    expect((await read(`?execution_id=${succeeded.id}`)).items).toEqual([]);
    for (const row of audit) expect(f.store.get('SELECT * FROM events WHERE id=?', row.id)).toEqual(row);
  } finally { await f.close(); }
});
