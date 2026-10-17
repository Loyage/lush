import { test, expect } from 'bun:test';
import { RUNNER_METHODS } from '../src/rpc/runner-methods.js';
import { PARAMS, USER_ONLY } from '../src/rpc/registry.js';
import { HANDLERS } from '../src/rpc/dispatcher.js';
import { CLI_COMMANDS } from '../src/cli/catalog.js';
import { managementFixture, nodeDefinition } from './runner-management-fixture.js';

test('user CLI registers/pairs a node, authenticates its independent Runner and explicitly pins the installation', async () => {
  for (const method of ['runner.nodes.get', 'runner.nodes.set', 'runner.nodes.check', 'runner.credentials.set', 'runner.project.set']) {
    expect(PARAMS[method]).toEqual(RUNNER_METHODS[method].params);
    expect(typeof HANDLERS[method]).toBe('function'); expect(USER_ONLY.has(method)).toBe(true);
    expect(CLI_COMMANDS.find(row => row.path === RUNNER_METHODS[method].cli).rpc).toEqual([method]);
  }
  const f = await managementFixture();
  const cli = async args => {
    const response = await f.cli(['runner', ...args]);
    expect(response).toMatchObject({ code: 0, err: '' });
    expect(response.out).not.toContain(f.secret); expect(response.out).not.toContain(f.machine);
    return JSON.parse(response.out);
  };
  try {
    const empty = await cli(['nodes', 'get']); expect(f.connections()).toBe(0);
    const saved = await cli(['nodes', 'set', '--file', f.file({ nodes: [nodeDefinition()], expected_revision: empty.revision })]);
    const node = saved.nodes[0];
    const policy = (await cli(['project', 'set', '--file', f.file({ allowed_node_ids: [node.id], default_node_id: node.id, expected_revision: 0 })])).policy;
    expect(await cli(['project', 'get'])).toEqual(policy);
    const credentials = await cli(['credentials', 'set', '--file', f.file({ node_id: node.id, project_id: policy.project_id,
      machine_token: f.machine, control_token: f.secret, expected_revision: 'absent' })]);
    expect(credentials.nodes[0]).toMatchObject({ machine_configured: true, projects: [{ project_id: policy.project_id, control_configured: true }] });
    expect(f.connections()).toBe(0); f.provision(node.id, policy.project_id);
    const diagnostic = await cli(['nodes', 'check', node.id]);
    expect(diagnostic.pinned).toBe(false); expect(diagnostic.runner_id).toBeTruthy();
    expect(diagnostic.capabilities).toContain('workspace.barrier'); expect(f.connections()).toBe(1);
    const pinned = await cli(['nodes', 'set', '--file', f.file({ nodes: [{ ...node, expected_runner_id: diagnostic.runner_id }], expected_revision: saved.revision })]);
    expect(pinned.nodes[0].expected_runner_id).toBe(diagnostic.runner_id);
    expect((await cli(['nodes', 'check', node.id])).pinned).toBe(true);
    const removed = await cli(['credentials', 'remove', '--file', f.file({ node_id: node.id, expected_revision: credentials.revision })]);
    expect(removed.nodes).toEqual([]);
  } finally { await f.close(); }
});
