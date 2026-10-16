import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { RUNNER_METHODS, validateRunnerParams } from '../src/rpc/runner-methods.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../src/rpc/registry.js';
import { HANDLERS, Dispatcher } from '../src/rpc/dispatcher.js';
import { managementPolicy } from '../src/rpc/management-policy.js';
import { CLI_COMMANDS, LUSHC_METHODS } from '../src/cli/catalog.js';
import { publicResult } from '../src/rpc/public-result.js';
import { run } from '../src/cli/commands/runner.js';
import { managementFixture, nodeDefinition } from './runner-management-fixture.js';

const uuid = '11111111-1111-4111-8111-111111111111';
test('Runner registration, CLI and user-only/Valet denial use the same method source', async () => {
  for (const [method, spec] of Object.entries(RUNNER_METHODS)) {
    expect(PARAMS[method]).toEqual(spec.params); expect(typeof HANDLERS[method]).toBe('function');
    expect(USER_ONLY.has(method)).toBe(true); expect(LUSHC_METHODS.has(method)).toBe(false);
    expect(managementPolicy(method).access).toBe('unavailable');
    expect(CLI_COMMANDS.find(row => row.path === spec.cli).rpc).toEqual([method]);
    expect(() => assertAllowed(method, {}, 7)).toThrow('user approval');
    const manager = new Dispatcher({ actor: () => 7, store: { task: () => ({ role: 'manager', task_kind: 'management' }) } });
    await expect(manager.dispatch(method, { _token: 'test' })).rejects.toThrow('user approval');
    await expect(manager.project.managementDispatch(method, {}, 7)).rejects.toThrow();
  }
});

test('real lush CLI → Unix RPC → user permissions → RunnerService → independent Runner hello, explicit pin and no secret reads', async () => {
  const f = await managementFixture();
  const cli = async args => {
    const result = await f.cli(['runner', ...args]);
    expect(result.err).toBe(''); expect(result.code).toBe(0);
    expect(result.out).not.toContain(f.secret); expect(result.out).not.toContain(f.machine);
    return JSON.parse(result.out);
  };
  try {
    const empty = await cli(['nodes', 'get']);
    expect(f.connections()).toBe(0);
    const nodes = await cli(['nodes', 'set', '--file', f.file({ nodes: [nodeDefinition()], expected_revision: empty.revision })]);
    const node = nodes.nodes[0];
    const policy = (await cli(['project', 'set', '--file', f.file({ allowed_node_ids: [node.id], default_node_id: node.id, expected_revision: 0 })])).policy;
    expect(await cli(['project', 'get'])).toEqual(policy);
    const credentials = await cli(['credentials', 'set', '--file', f.file({ node_id: node.id, project_id: policy.project_id,
      machine_token: f.machine, control_token: f.secret, expected_revision: 'absent' })]);
    expect(await cli(['credentials', 'get'])).toEqual(credentials);
    expect(credentials.nodes[0]).toMatchObject({ machine_configured: true, projects: [{ project_id: policy.project_id, control_configured: true }] });
    expect(f.connections()).toBe(0);
    f.provision(node.id, policy.project_id);
    const diagnostic = await cli(['nodes', 'check', node.id]);
    expect(diagnostic.pinned).toBe(false); expect(diagnostic.runner_id).toBeTruthy();
    expect(diagnostic.capabilities).toContain('workspace.barrier'); expect(diagnostic.limits.max_pending).toBeGreaterThan(0);
    expect(f.connections()).toBe(1);
    expect((await cli(['nodes', 'get'])).nodes[0].expected_runner_id).toBeNull();
    const pinned = await cli(['nodes', 'set', '--file', f.file({ nodes: [{ ...node, expected_runner_id: diagnostic.runner_id }], expected_revision: nodes.revision })]);
    expect(pinned.nodes[0].expected_runner_id).toBe(diagnostic.runner_id);
    expect((await cli(['nodes', 'check', node.id])).pinned).toBe(true);
    const stale = await f.cli(['runner', 'nodes', 'set', '--file', f.file({ nodes: [], expected_revision: nodes.revision })]);
    expect(stale.code).toBe(1); expect(stale.err).toContain('revision');
    const removed = await cli(['credentials', 'remove', '--file', f.file({ node_id: node.id, expected_revision: credentials.revision })]);
    expect(removed.nodes).toEqual([]);
    expect(JSON.stringify(f.store.all('SELECT * FROM events'))).not.toContain(f.secret);
  } finally { await f.close(); }
});

test('device CLI needs no project/daemon; management aliases, unsafe files and secret argv fail before requests', async () => {
  const f = await managementFixture();
  try {
    const result = await f.cli(['runner', 'nodes', 'get', '--scope', 'device'], { extra: { LUSH_PROJECT: '/missing', LUSH_HOME: '/missing' } });
    expect(result.code).toBe(0); expect(JSON.parse(result.out).nodes).toEqual([]); expect(f.connections()).toBe(0);
    for (const options of [{ executable: 'lushc' }, { extra: { LUSH_AGENT_TOKEN: 'active' } }]) {
      const denied = await f.cli(['runner', 'nodes', 'get', '--scope', 'device'], options);
      expect(denied.code).toBe(1); expect(denied.out).toBe('');
    }
    let calls = 0;
    const invoke = args => run('runner', args, { client: { token: null, request() { calls++; } } });
    const file = f.file({ node_id: uuid, machine_token: f.machine, expected_revision: 'absent' });
    for (const args of [['credentials', 'set', '--machine-token', f.machine], ['credentials', 'set', '--file', file, '--file', file],
      ['credentials', 'set', '--file', file, '--token', f.secret], ['credentials', 'set', '--file', '-']]) await expect(invoke(args)).rejects.toThrow();
    fs.chmodSync(file, 0o644);
    await expect(invoke(['credentials', 'set', '--file', file])).rejects.toThrow('owner-only');
    fs.chmodSync(file, 0o600);
    const link = path.join(f.root, 'link.json'); fs.symlinkSync(file, link);
    await expect(invoke(['credentials', 'set', '--file', link])).rejects.toThrow('owner-only');
    fs.writeFileSync(file, '{"private":"' + f.secret);
    try { await invoke(['credentials', 'set', '--file', file]); throw new Error('not rejected'); }
    catch (error) { expect(error.message).not.toContain(f.secret); }
    expect(calls).toBe(0);
  } finally { await f.close(); }
});

test('Runner request schema is bounded and typed; result projection drops secrets and private transport fields', async () => {
  const bad = [
    ['runner.nodes.set', { nodes: [], expected_revision: 0 }],
    ['runner.nodes.set', { nodes: Array(65).fill(nodeDefinition()), expected_revision: 'a'.repeat(64) }],
    ['runner.nodes.set', { nodes: [{ ...nodeDefinition(), transport: 'local' }], expected_revision: 'a'.repeat(64) }],
    ['runner.nodes.check', { node_id: uuid, project_id: 'x'.repeat(129) }],
    ['runner.credentials.set', { node_id: uuid, machine_token: 'short', expected_revision: 'absent' }],
    ['runner.credentials.set', { node_id: uuid, project_id: uuid, expected_revision: 'absent' }],
    ['runner.credentials.remove', { node_id: uuid, expected_revision: 0 }],
    ['runner.project.set', { allowed_node_ids: [], default_node_id: 'local', expected_revision: '0' }],
    ['runner.project.set', { allowed_node_ids: [uuid, uuid], default_node_id: uuid, expected_revision: 0 }],
    ['runner.project.get', { _token: null }], ['runner.nodes.get', { scope: 'project' }],
  ];
  for (const [method, params] of bad) expect(() => validateRunnerParams(method, params)).toThrow();
  expect(publicResult({ version: 1, revision: 'absent', token: 'secret', nodes: [{ node_id: uuid, machine_token: 'secret', machine_configured: true,
    projects: [{ project_id: uuid, control_configured: true, control_token: 'secret' }] }] }, 'runner.credentials.get')).toEqual({
    version: 1, revision: 'absent', nodes: [{ node_id: uuid, machine_configured: true, projects: [{ project_id: uuid, control_configured: true }] }],
  });
  const rpc = new Dispatcher({ actor: () => null, write: (_action, fn) => fn(), runners: { saveCredentials() { throw new Error('transport-private-secret'); } } });
  try { await rpc.dispatch('runner.credentials.set', { node_id: uuid, machine_token: 'a'.repeat(64), expected_revision: 'absent' }); throw new Error('not rejected'); }
  catch (error) { expect(error.message).not.toContain('transport-private-secret'); expect(error.message).toContain('not confirmed'); }
  let calls = 0;
  const acknowledged = await run('runner', ['nodes', 'get'], { client: { request() { calls++; return { version: 1, nodes: [] }; } } });
  expect(acknowledged.nodes).toEqual([]); expect(calls).toBe(1);
});
