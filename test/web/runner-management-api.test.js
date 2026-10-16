import { test, expect } from 'bun:test';
import { startTestWeb, fetch } from './auth-fixture.js';
import { DeviceSettingsService } from '../../src/host/device-settings.js';
import { managementFixture, nodeDefinition } from '../runner-management-fixture.js';

const post = (url, method, params, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ method, params }) });

test('project Web Runner API forwards authenticated strict reads/mutations to real service without implicit SSH', async () => {
  const f = await managementFixture(), web = startTestWeb(f.config), url = `http://127.0.0.1:${web.port}`;
  try {
    const response = await fetch(`${url}/api/runner/nodes`);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const empty = await response.json();
    const saved = await post(`${url}/api/action`, 'runner.nodes.set', { nodes: [nodeDefinition()], expected_revision: empty.revision });
    expect(saved.status).toBe(200); const node = (await saved.json()).nodes[0];
    const policyResponse = await post(`${url}/api/action`, 'runner.project.set', { allowed_node_ids: [node.id], default_node_id: node.id, expected_revision: 0 });
    expect(policyResponse.status).toBe(200); const policy = (await policyResponse.json()).policy;
    expect(await (await fetch(`${url}/api/runner/project`)).json()).toEqual(policy);
    expect((await fetch(`${url}/api/runner/credentials`)).status).toBe(200);
    expect(f.connections()).toBe(0);
    for (const query of ['?scope=device', '?_token=x', '?project_id=x', '?path=/']) expect((await fetch(`${url}/api/runner/nodes${query}`)).status).toBe(400);
    for (const params of [{ nodes: [], expected_revision: empty.revision, _token: null }, { nodes: [], expected_revision: 0 },
      { nodes: [{ ...node, transport_factory: 'local' }], expected_revision: empty.revision }])
      expect((await post(`${url}/api/action`, 'runner.nodes.set', params)).status).toBe(400);
    expect((await post(`${url}/api/action?q=x`, 'runner.nodes.set', { nodes: [], expected_revision: empty.revision })).status).toBe(400);
    expect((await post(`${url}/api/action`, 'runner.nodes.set', { nodes: [], expected_revision: empty.revision }, { Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await fetch(`${url}/api/runner/credentials`, { anonymous: true })).status).toBe(401);
    expect((await fetch(`${url}/api/runner/nodes/check`)).status).toBe(404);
    expect(f.connections()).toBe(0);
    expect(f.project.writing).toBe(0);
    f.project.clearing = true;
    expect((await post(`${url}/api/action`, 'runner.project.set', { allowed_node_ids: [], default_node_id: 'local', expected_revision: policy.revision })).status).toBe(400);
    f.project.clearing = false;
  } finally { f.project.clearing = false; await web.stop(true); await f.close(); }
});

test('unselected Host manages device Runner config and explicitly checks paired independent node without attaching a project', async () => {
  const f = await managementFixture(); let opened = 0;
  const device = new DeviceSettingsService(f.config.env, { runner: f.runnerOptions });
  const web = startTestWeb(null, 0, { env: f.config.env, deviceSettingsService: device,
    openProject: async () => { opened++; throw new Error('unexpected project startup'); } });
  const url = `http://127.0.0.1:${web.port}`, action = `${url}/api/host/settings/action`;
  try {
    const response = await fetch(`${url}/api/host/settings/runner/nodes`);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const empty = await response.json();
    const saved = await post(action, 'runner.nodes.set', { nodes: [nodeDefinition()], expected_revision: empty.revision });
    expect(saved.status).toBe(200); const nodes = await saved.json(), node = nodes.nodes[0];
    const project_id = 'manually-paired-project';
    const credentials = await post(action, 'runner.credentials.set', { node_id: node.id, project_id,
      machine_token: f.machine, control_token: f.secret, expected_revision: 'absent' });
    expect(credentials.status).toBe(200); expect(await credentials.text()).not.toContain(f.secret);
    expect((await fetch(`${url}/api/host/settings/runner/credentials?scope=device`)).status).toBe(200);
    expect(f.connections()).toBe(0); expect(opened).toBe(0);
    f.provision(node.id, project_id);
    const checked = await post(action, 'runner.nodes.check', { node_id: node.id, project_id });
    expect(checked.status).toBe(200); expect((await checked.json()).pinned).toBe(false);
    expect(f.connections()).toBe(1); expect(opened).toBe(0);
    expect((await device.request('runner.nodes.get')).nodes[0].expected_runner_id).toBeNull();
    expect((await post(action, 'runner.nodes.check', { node_id: node.id })).status).toBe(400);
    expect((await post(action, 'runner.project.set', { allowed_node_ids: [], default_node_id: 'local', expected_revision: 0 })).status).toBe(400);
    expect((await fetch(`${url}/api/host/settings/runner/project`)).status).toBe(404);
    expect((await post(action, 'runner.credentials.remove', { node_id: node.id, expected_revision: 'absent', _token: null })).status).toBe(400);
    expect((await post(action, 'runner.nodes.check', { node_id: node.id, project_id, scope: 'project' })).status).toBe(400);
    expect((await post(action, 'runner.nodes.check', { node_id: node.id, project_id }, { Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await fetch(`${url}/api/host/settings/runner/credentials`, { anonymous: true })).status).toBe(401);
    expect(f.connections()).toBe(1); expect(opened).toBe(0);
    expect(f.store.runnerProject().project_id).toBeNull(); // Host did not create project policy or authorize anything.
  } finally { await web.stop(true); await f.close(); }
});
