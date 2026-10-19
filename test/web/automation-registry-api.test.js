import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { setup, fetch } from './harness.js';
const action = (f, method, params, options = {}) => fetch(f.url + '/api/action', { ...options, method: 'POST',
  headers: { 'Content-Type': 'application/json', ...options.headers }, body: JSON.stringify({ method, params }) });
async function successful(f, method, params) {
  const response = await action(f, method, params), body = await response.json();
  expect({ status: response.status, error: body.error }).toEqual({ status: 200, error: undefined });
  return body;
}
const directory = async f => (await fetch(f.url + '/api/hooks')).json();
const hooks = async (f, id) => (await fetch(f.url + `/api/worker/${id}/hooks`)).json();

test('authenticated HTTP -> RPC: register, mount, update and remove a pinned automation definition', async () => {
  const f = await setup(); f.project.kick = () => {}; await repo(f.root);
  try {
    const main = await f.project.bootstrapMain(), before = await directory(f);
    const params = { command: { name: 'HTTP Shell definition', command: 'true' },
      hook: { name: 'HTTP registered function', trigger: 'worker.merge_received', mode: 'persistent', enabled: false },
      expected_revisions: { commands: before.commands.revision, registry: before.registry.revision }, client_request_id: 'http-register-only' };
    const registered = await successful(f, 'hooks.register', params);
    expect(registered).toMatchObject({ registered: true, template_version: 1 });
    expect((await directory(f)).registry.items.find(item => item.id === registered.template_id)).toMatchObject({ mount_count: 0 });
    expect((await hooks(f, main.id)).mounts.some(mount => mount.registry_id === registered.template_id)).toBe(false);
    expect(f.project.shortcutCommandHistory().items).toEqual([]);
    expect(await successful(f, 'hooks.register', params)).toEqual(registered);
    const attached = await successful(f, 'worker.hook_attach', { id: main.id,
      hook: { template_id: registered.template_id, template_version: 1 }, expected_revision: (await hooks(f, main.id)).revision });
    const mount = attached.mounts.at(-1);
    expect(mount).toMatchObject({ registry_id: registered.template_id, registry_version: 1, enabled: false });
    const saved = await successful(f, 'hooks.save', { template: { ...params.hook, id: registered.template_id, purpose: 'revised HTTP purpose',
      actions: [{ type: 'command', command_id: registered.command_id, command_version: 1 }] }, expected_revision: (await directory(f)).registry.revision });
    expect(saved.registry.items.find(item => item.id === registered.template_id)).toMatchObject({ version: 2, mount_count: 1 });
    expect((await hooks(f, main.id)).mounts.find(item => item.id === mount.id).registry_version).toBe(1);
    const updated = await successful(f, 'worker.hook_update', { id: main.id, hook_id: mount.id,
      hook: { template_id: registered.template_id, template_version: 2, enabled: false }, expected_revision: (await hooks(f, main.id)).revision });
    expect(updated.mounts.find(item => item.id === mount.id)).toMatchObject({ registry_id: registered.template_id, registry_version: 2 });
    await successful(f, 'worker.hook_remove', { id: main.id, hook_id: mount.id, expected_revision: (await hooks(f, main.id)).revision });
    const removed = await successful(f, 'hooks.remove', { id: registered.template_id, expected_revision: (await directory(f)).registry.revision });
    expect(removed.registry.items.some(item => item.id === registered.template_id)).toBe(false);
    expect(f.project.shortcutCommandHistory().items).toEqual([]);
  } finally { await f.close(); }
});
