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

test('authenticated HTTP -> RPC: pinned permanent and temporary definitions retain their independent lifecycle', async () => {
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

    // The same HTTP/RPC chain accepts controlled non-Shell temporary actions.
    // Creation is inert; a successful one-shot drops only its mount, not definition/audit.
    const create = { hook: { name: '临时完成提醒', trigger: 'agent.returned', enabled: true,
      actions: [{ type: 'notify', title: 'temporary-http', body: '完成本次使用' }] },
      expected_revisions: { registry: removed.registry.revision }, client_request_id: 'http-temporary' };
    const temporary = await successful(f, 'hooks.temporary_create', create);
    expect(temporary).toMatchObject({ created: true, temporary: true, template_version: 1 });
    expect(await successful(f, 'hooks.temporary_create', create)).toEqual(temporary);
    let list = await directory(f), entry = list.registry.items.find(item => item.id === temporary.template_id);
    expect(entry).toMatchObject({ temporary: true, lifecycle: 'active', mount_count: 0, readonly: true });
    const template = list.templates.find(item => item.id === temporary.template_id);
    expect(template.mode).toBe('once');
    for (const [method, params] of [['hooks.save', { template: { id: temporary.template_id, mode: 'once', ...create.hook }, expected_revision: list.registry.revision }],
      ['hooks.remove', { id: temporary.template_id, expected_revision: list.registry.revision }]])
      expect((await action(f, method, params)).status).toBe(400);
    const tempAttached = await successful(f, 'worker.hook_attach', { id: main.id,
      hook: { template_id: temporary.template_id, template_version: 1, enabled: false }, expected_revision: (await hooks(f, main.id)).revision });
    const tempMount = tempAttached.mounts.at(-1);
    const reclaim = () => ({ id: temporary.template_id, expected_revision: list.registry.revision, client_request_id: 'http-reclaim' });
    expect((await action(f, 'hooks.temporary_reclaim', reclaim())).status).toBe(400); // disabled is still a reference
    await successful(f, 'worker.hook_update', { id: main.id, hook_id: tempMount.id, enabled: true,
      expected_revision: (await hooks(f, main.id)).revision });
    f.project.emitTaskHook(main.id, 'agent.returned'); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='temporary-http'").n).toBe(1);
    expect((await hooks(f, main.id)).mounts.some(item => item.id === tempMount.id)).toBe(false);
    list = await directory(f);
    expect(list.registry.items.find(item => item.id === temporary.template_id).usage).toMatchObject({
      attached_total: 1, succeeded_total: 1, mount_count: 0, reclaimable: true });
    const reclaimed = await successful(f, 'hooks.temporary_reclaim', reclaim());
    expect(reclaimed).toMatchObject({ reclaimed: true, history_preserved: true });
    expect(await successful(f, 'hooks.temporary_reclaim', reclaim())).toEqual(reclaimed);
    expect((await directory(f)).registry.items.some(item => item.id === temporary.template_id)).toBe(false);
    const archived = await (await fetch(f.url + '/api/hooks?include_reclaimed=true&limit=100')).json();
    expect(archived.registry.items.find(item => item.id === temporary.template_id)).toMatchObject({ lifecycle: 'reclaimed', mountable: false });
    const history = await (await fetch(f.url + `/api/hooks/temporary/history?id=${temporary.template_id}&limit=2`)).json();
    expect(history).toMatchObject({ lifecycle: 'reclaimed', readonly: true, template_version: 1 });
    expect(history.definition.actions).toEqual(create.hook.actions);
    expect(history.audit).toMatchObject({ has_more: true, truncated: false, history_complete: false });
    const older = await (await fetch(f.url + `/api/hooks/temporary/history?id=${temporary.template_id}&before=${history.audit.next_before}&limit=100`)).json();
    expect(older.audit.items.every(item => item.seq < history.audit.next_before)).toBe(true);
    expect(older.audit.items.some(item => item.type === 'hook.execution_succeeded')).toBe(true);
    expect((await action(f, 'worker.hook_attach', { id: main.id, hook: { template_id: temporary.template_id, template_version: 1 },
      expected_revision: (await hooks(f, main.id)).revision })).status).toBe(400);
    expect((await fetch(f.url + '/api/hooks?include_reclaimed=true&include_reclaimed=false')).status).toBe(400);
  } finally { await f.close(); }
});
