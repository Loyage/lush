import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
import { RPCClient } from '../../src/rpc/client.js';

const get = async (f, route) => {
  const response = await fetch(f.url + route);
  expect(response.status).toBe(200); return response.json();
};
const facts = f => ['tasks','meta','events','notices'].map(table => f.store.all(`SELECT * FROM ${table} ORDER BY rowid`));

test('real HTTP/RPC Worker reads return safe same-source push identity; missing main, deletion and mismatch never write or recurse', async () => {
  const f = await setup(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  try {
    const unrelated = f.store.create({ role: 'agent', task_kind: 'order', goal: 'not main despite its ID' });
    const rpc = new RPCClient(f.config.socket);
    const noMain = facts(f);
    expect((await get(f, `/api/worker/${unrelated.id}/hooks`)).push).toBeNull();
    expect((await rpc.request('worker.hooks', { id: unrelated.id })).push).toBeNull();
    expect((await get(f, '/api/hooks')).command_example).toBeNull();
    expect(facts(f)).toEqual(noMain);
    await repo(f.root); const main = await f.project.bootstrapMain();
    const worker = (await f.project.order('HTTP other Worker', 'main', [], null, false)).task;
    const identity = f.project.commandHookExampleIdentity();
    const expected = { worker_id: main.id, hook_id: identity.hook_id };
    const record = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='command_hook_example'").value);
    f.store.run("UPDATE meta SET value=? WHERE key='command_hook_example'", JSON.stringify({ ...record, private_secret: 'PRIVATE_PUSH_IDENTITY' }));
    const before = facts(f);
    for (const task of [main, worker]) {
      const hooks = await get(f, `/api/worker/${task.id}/hooks`);
      expect(hooks.push).toEqual(expected);
      expect(Object.keys(hooks.push).sort()).toEqual(['hook_id','worker_id']);
      expect((await get(f, `/api/worker/${task.id}`)).hooks.push).toEqual(expected);
      expect((await rpc.request('worker.hooks', { id: task.id })).push).toEqual(expected);
      expect(JSON.stringify(hooks)).not.toContain('PRIVATE_PUSH_IDENTITY');
      expect(JSON.stringify(hooks)).not.toContain('authorization');
    }
    const catalog = await get(f, '/api/hooks');
    expect(catalog.command_example.hooks.push).toEqual(expected);
    expect(catalog.command_example.hook_id).toBe(expected.hook_id);
    expect(JSON.stringify(catalog)).not.toContain('PRIVATE_PUSH_IDENTITY');
    expect(facts(f)).toEqual(before);
    f.project.removeTaskHook(main.id, expected.hook_id, f.project.taskHooks(main.id).revision);
    const removed = facts(f), tombstone = await get(f, `/api/worker/${main.id}/hooks`);
    expect(tombstone.push).toEqual(expected); expect(tombstone.mounts.some(m => m.id === expected.hook_id)).toBe(false);
    expect((await get(f, `/api/worker/${worker.id}/hooks`)).push).toEqual(expected);
    expect(facts(f)).toEqual(removed);
    f.store.run("UPDATE meta SET value=? WHERE key='command_hook_example'", JSON.stringify({ ...record, worker_id: worker.id }));
    const mismatch = facts(f);
    expect((await get(f, `/api/worker/${main.id}/hooks`)).push).toEqual({ worker_id: main.id, hook_id: null });
    expect((await get(f, '/api/hooks')).command_example).toMatchObject({ worker_id: main.id, hook_id: null, template_id: null });
    expect((await rpc.request('worker.hooks', { id: worker.id })).push).toEqual({ worker_id: main.id, hook_id: null });
    expect(facts(f)).toEqual(mismatch);
  } finally { await f.close(); }
});
