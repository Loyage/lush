import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
import { install } from '../project/agent-connection-fixture.js';

test('connection HTTP actions save, query and remove a source through the real service', async () => {
  const f = await setup(), { manager } = install(f);
  const action = async (method, params) => {
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    expect(response.status).toBe(200); return response.json();
  };
  try {
    expect((await (await fetch(f.url + '/api/agent/connections')).json()).connections).toHaveLength(1);
    expect(manager.calls).toBe(0);
    await action('agent.connections.save', { connection: { id: 'conn-one', label: 'Second', provider: 'deepseek', auth_type: 'api_key', enabled: true }, credential: { api_key: 'fixture-key' } });
    expect(manager.keys.get('conn-one')).toBe('fixture-key');
    await action('agent.connections.query', { id: 'conn-one' }); expect(manager.calls).toBe(1);
    expect((await (await fetch(f.url + '/api/agent/connections/history?id=conn-one&days=7')).json()).series).toHaveLength(1);
    await action('agent.connections.remove', { id: 'conn-one' });
    expect((await (await fetch(f.url + '/api/agent/connections')).json()).connections).toEqual([]);
  } finally { await f.close(); }
});
