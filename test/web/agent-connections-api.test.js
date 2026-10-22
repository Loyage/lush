import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
import { install } from '../project/agent-connection-fixture.js';
import { ConnectionManager } from '../../src/agent/connections.js';
import { UIClient } from '../../src/ui/client.js';
import { PARAMS, USER_ONLY } from '../../src/rpc/registry.js';
import { managementPolicy } from '../../src/rpc/management-policy.js';

test('connection and named model HTTP/RPC lifecycle preserves concrete bindings and enforces user/Valet boundaries', async () => {
  const f = await setup(); let requests = 0;
  const manager = new ConnectionManager(f.config, { fetch: async () => {
    requests++; return Response.json({ balance_infos: [{ currency: 'USD', total_balance: 2 }] });
  } });
  install(f, { manager, now: Date.now });
  const client = new UIClient(f.config);
  const action = async (method, params) => {
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    expect(response.status).toBe(200); return response.json();
  };
  try {
    expect((await (await fetch(f.url + '/api/agent/connections')).json()).connections).toHaveLength(0);
    const source = await action('agent.connections.save', { connection: { label: 'Second', provider: 'deepseek', auth_type: 'api_key',
      models: ['deepseek-chat', 'vendor/physical-model'] }, credential: { api_key: 'fixture-key' } });
    const registered = await action('agent.registered_models.save', { model: { name: 'astra', connection_id: source.id, model: 'deepseek/vendor/physical-model' } });
    const resolved = await action('agent.registered_models.resolve', { selector: 'astra' });
    expect(resolved).toEqual({ id: registered.id, name: 'astra', connection_id: source.id, model: 'deepseek/vendor/physical-model' });
    const listing = await fetch(f.url + '/api/agent/registered-models?scope=device');
    expect(listing.headers.get('cache-control')).toContain('no-store');
    expect(await listing.json()).toMatchObject({ version: 1, storage_scope: 'device', models: [{ id: registered.id, selectable: true, reason: null }] });
    expect(requests).toBe(0);
    expect((await fetch(f.url + '/api/agent/registered-models?scope=project')).status).toBe(400);
    expect((await fetch(f.url + '/api/agent/registered-models?unexpected=yes')).status).toBe(400);
    const profile = { agent: 'pi', config_mode: 'lush', connection_id: resolved.connection_id, model: resolved.model, thinking: 'high' };
    await client.request('agent.configure', { config: { version: 1, default: profile, roles: {} } });
    const storedDefault = (await client.request('agent.config')).default;
    await repo(f.root); await f.project.ensureMainTask(); f.project.kick = () => {};
    const target = (await f.project.order('frozen model binding', 'main', [], null, false, undefined, profile)).task;
    const storedProfile = f.store.task(target.id).retry_profile;

    // Real invocation -> socket -> registered method -> current management permission/scope -> safe result.
    // The later CLI stage owns the Provider's lush_cli registration/parser chain, not this backend test.
    const replies = [];
    f.project.provider = { async run({ token }) {
      const call = (method, params = {}) => client.request('manager.call', { _token: token, method, params });
      for (const method of ['list', 'save', 'remove', 'resolve']) {
        const name = `agent.registered_models.${method}`;
        expect(PARAMS[name]).toBeTruthy(); expect(USER_ONLY.has(name)).toBe(true);
        await expect(client.request(name, { _token: token })).rejects.toThrow('user approval');
      }
      await expect(call('agent.registered_models.list')).rejects.toThrow();
      replies.push(await call('agent.registered_models.list', { scope: 'device' }));
      replies.push(await call('agent.registered_models.resolve', { selector: 'astra', scope: 'device' }));
      for (const method of ['save', 'remove']) {
        const name = `agent.registered_models.${method}`;
        expect(managementPolicy(name).access).toBe('unavailable');
        await expect(call(name, { scope: 'device', ...(method === 'save' ? { model: {} } : { id: registered.id }) })).rejects.toThrow();
      }
      return 'registry permission chain verified';
    } };
    const valet = await client.request('management.submit', { instruction: '读取设备登记模型 astra', profile: { agent: 'pi', config_mode: 'pi' } });
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(f.store.task(valet.task.id).result).toBe('registry permission chain verified');
    expect(replies[0]).toMatchObject({ status: 'succeeded', result: { version: 1, models: [{ id: registered.id }] } });
    expect(replies[1]).toMatchObject({ status: 'succeeded', result: resolved });
    expect(JSON.stringify(replies)).not.toContain('fixture-key');
    f.project.provider = { async run({ token, task }) {
      if (task.task_kind === 'management') {
        await expect(client.request('manager.call', { _token: token, method: 'agent.registered_models.list', params: { scope: 'device' } })).rejects.toThrow();
      } else {
        for (const method of ['list', 'save', 'remove', 'resolve'])
          await expect(client.request(`agent.registered_models.${method}`, { _token: token })).rejects.toThrow('user approval');
      }
      return 'scope and developer permission verified';
    } };
    const noDeviceGrant = await client.request('management.submit', { instruction: '查看 astra', profile: { agent: 'pi', config_mode: 'pi' } });
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(f.store.task(noDeviceGrant.task.id).result).toBe('scope and developer permission verified');
    await client.request('worker.resume', { id: target.id });
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(f.store.task(target.id).result).toBe('scope and developer permission verified');

    await action('agent.registered_models.save', { model: { id: registered.id, name: 'renamed', connection_id: source.id, model: 'deepseek/deepseek-chat' } });
    await action('agent.registered_models.remove', { id: registered.id });
    expect((await client.request('agent.config')).default).toEqual(storedDefault);
    expect(f.store.task(target.id).retry_profile).toBe(storedProfile);
    expect((await (await fetch(f.url + '/api/agent/registered-models')).json()).models).toEqual([]);
    await action('agent.connections.query', { id: source.id }); expect(requests).toBe(1);
    expect((await (await fetch(f.url + `/api/agent/connections/history?id=${source.id}&days=7`)).json()).series).toHaveLength(1);
    await action('agent.connections.remove', { id: source.id });
    expect((await (await fetch(f.url + '/api/agent/connections')).json()).connections).toEqual([]);
  } finally { await f.close(); }
});
