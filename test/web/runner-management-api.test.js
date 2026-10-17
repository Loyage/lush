import { test, expect } from 'bun:test';
import { startTestWeb, fetch } from './auth-fixture.js';
import { managementFixture, nodeDefinition } from '../runner-management-fixture.js';

test('Runner HTTP settings persist a node and project default through the real service', async () => {
  const f = await managementFixture(), web = startTestWeb(f.config), url = `http://127.0.0.1:${web.port}`;
  const action = async (method, params) => {
    const response = await fetch(`${url}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    expect(response.status).toBe(200); return response.json();
  };
  try {
    const empty = await (await fetch(`${url}/api/runner/nodes`)).json();
    const saved = await action('runner.nodes.set', { nodes: [nodeDefinition()], expected_revision: empty.revision });
    const node = saved.nodes[0];
    const { policy } = await action('runner.project.set', { allowed_node_ids: [node.id], default_node_id: node.id, expected_revision: 0 });
    expect(await (await fetch(`${url}/api/runner/project`)).json()).toEqual(policy);
    expect(policy.default_node_id).toBe(node.id); expect(f.connections()).toBe(0);
  } finally { await web.stop(true); await f.close(); }
});
