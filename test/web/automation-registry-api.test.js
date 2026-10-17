import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { createSignal } from '../../src/signal.js';
import { tokenHash } from '../../src/core/project/internal.js';

const notice = { name: 'legacy HTTP feature', trigger: 'agent.returned', mode: 'persistent', enabled: false,
  conditions: {}, actions: [{ type: 'notify', title: 'not executed', body: 'future only' }] };
const action = (f, method, params, options = {}) => fetch(f.url + '/api/action', { ...options, method: 'POST',
  headers: { 'Content-Type': 'application/json', ...options.headers }, body: JSON.stringify({ method, params }) });
async function successful(f, method, params) {
  const response = await action(f, method, params), body = await response.json();
  expect({ status: response.status, error: body.error }).toEqual({ status: 200, error: undefined });
  return body;
}
const directory = async f => (await fetch(f.url + '/api/hooks')).json();
const hooks = async (f, id) => (await fetch(f.url + `/api/worker/${id}/hooks`)).json();

test('authenticated HTTP -> RPC: register only, separate pinned mount, save/version update, removal and retired install rejection', async () => {
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
    const raw = await action(f, 'worker.hook_attach', { id: main.id, hook: notice, expected_revision: updated.revision });
    expect(raw.status).toBe(400); expect((await raw.json()).error).toContain('registered mount');
    const bypass = await action(f, 'worker.hook_update', { id: main.id, hook_id: mount.id, hook: notice, expected_revision: (await hooks(f, main.id)).revision });
    expect(bypass.status).toBe(400); expect((await bypass.json()).error).toContain('registered mount');
    const retired = await action(f, 'hooks.install', {});
    expect(retired.status).toBe(400);
    const retirement = (await retired.json()).error;
    for (const text of ['retired','hooks.register','worker.hook_attach']) expect(retirement).toContain(text);
    await successful(f, 'worker.hook_remove', { id: main.id, hook_id: mount.id, expected_revision: (await hooks(f, main.id)).revision });
    const removed = await successful(f, 'hooks.remove', { id: registered.template_id, expected_revision: (await directory(f)).registry.revision });
    expect(removed.registry.items.some(item => item.id === registered.template_id)).toBe(false);
    expect(f.project.shortcutCommandHistory().items).toEqual([]);
  } finally { await f.close(); }
});

test('HTTP legacy upgrade is explicit and preserves identity/state; anonymous, cross-origin and Agent callers cannot authorize either new method', async () => {
  const f = await setup(); f.project.kick = () => {}; await repo(f.root);
  let actor;
  try {
    const main = await f.project.bootstrapMain(), state = JSON.parse(f.store.task(main.id).hooks);
    const legacy = { ...notice, id: 'legacy-http-mount', state: 'idle', last_source: 'agent.returned:17', receipts: [{ index: 0, notice_id: 18 }] };
    state.mounts.push(legacy); f.store.update(main.id, { hooks: JSON.stringify(state) });
    const stored = f.store.task(main.id).hooks, before = await directory(f);
    expect(before.registry.legacy_mount_count).toBe(1); expect(f.store.task(main.id).hooks).toBe(stored);
    actor = f.store.create({ role: 'agent', task_kind: 'order', goal: 'authenticated permission probe' });
    const token = 'fixture-automation-agent-token';
    f.store.update(actor.id, { status: 'running' }); f.store.armAgent(actor.id, tokenHash(token));
    f.project.running.set(actor.id, { token, controller: new AbortController() });
    const dispatcher = new Dispatcher(f.project, createSignal(), {});
    for (const method of ['hooks.register','hooks.upgrade']) {
      const params = method === 'hooks.upgrade' ? { expected_revision: before.registry.upgrade_revision } : {};
      const anonymous = await action(f, method, params, { anonymous: true, headers: { Authorization: `Bearer ${token}` } });
      expect(anonymous.status).toBe(401);
      const crossOrigin = await action(f, method, params, { headers: { Origin: 'https://untrusted.invalid' } });
      expect(crossOrigin.status).toBe(403);
      const injected = await action(f, method, { ...params, _token: token });
      expect(injected.status).toBe(400); expect((await injected.json()).error).toContain('agent tokens are not accepted');
      await expect(dispatcher.dispatch(method, { ...params, _token: token })).rejects.toThrow('requires user approval');
    }
    expect(f.store.task(main.id).hooks).toBe(stored);
    f.project.running.delete(actor.id); f.store.update(actor.id, { status: 'paused' });
    const upgraded = await successful(f, 'hooks.upgrade', { expected_revision: before.registry.upgrade_revision });
    expect(upgraded.registry.legacy_mount_count).toBe(0);
    const mount = JSON.parse(f.store.task(main.id).hooks).mounts.find(item => item.id === legacy.id);
    expect(mount).toMatchObject(legacy); expect(mount.registry_version).toBe(1);
    expect(upgraded.registry.items.find(item => item.id === mount.registry_id)).toMatchObject({ mount_count: 1 });
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='not executed'").n).toBe(0);
  } finally { if (actor) f.project.running.delete(actor.id); await f.close(); }
});
