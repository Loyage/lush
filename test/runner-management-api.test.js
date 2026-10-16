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

test('deployment receipts: actual user CLI/RPC and device CLI reads are inert, registered and user-only', async () => {
  const f = await managementFixture();
  try {
    const entries = () => fs.existsSync(f.config.deviceHome) ? fs.readdirSync(f.config.deviceHome).sort() : null;
    const before = entries();
    for (const args of [[], ['--scope', 'device']]) {
      const response = await f.cli(['runner', 'deployments', 'get', ...args]);
      expect(response).toMatchObject({ code: 0, err: '' });
      expect(JSON.parse(response.out)).toEqual({ version: 1, items: [], truncated: false });
    }
    expect(entries()).toEqual(before); expect(f.connections()).toBe(0);
    for (const options of [{ executable: 'lushc' }, { extra: { LUSH_AGENT_TOKEN: 'active' } }]) {
      const response = await f.cli(['runner', 'deployments', 'get', '--scope', 'device'], options);
      expect(response.code).toBe(1); expect(response.out).toBe('');
    }
    expect(() => validateRunnerParams('runner.deployments.get', { path: '/private' })).toThrow();
    expect(() => validateRunnerParams('runner.deployments.get', { id: uuid })).toThrow();
    expect(f.project.writing).toBe(0); expect(f.store.runnerProject().project_id).toBeNull();
  } finally { await f.close(); }
});

test('deployment receipts: crash-abandoned running derives unknown; live lease, nested public preview and disk remain untouched', async () => {
  const f = await managementFixture(); let lease;
  try {
    const base = f.deployment({ status: 'running', stages: [{ id: 'install_runtime', status: 'running' }] });
    const row = f.deployments.change(base.id, base.revision, value => { value.private_data.recovery = { version: 1, current: null, pending: null, gate: uuid, generations: [], items: [
      { id: uuid, status: 'running', applied: true, created_at: '2026-01-01T00:00:00.000Z', frozen: { from_generation: 0, managed: { cgroup_root: '/sys/fs/cgroup/previous/runner', remote: { boot_id: 'private-receipt-proof' } } },
        plan: { supported: false, boot_id: 'private-receipt-proof', blockers: ['old_commands_unconfirmed'], commands: { supported: true, total: 1, executions: ['private-receipt-proof'] },
          actions: [{ id: 'bind_runtime_generation', privileged: false, effect: 'Bind original runtime generation' }] }, stages: [{ id: 'bind_runtime_generation', status: 'running', request_id: 'private-receipt-proof' }] },
    ] }; });
    const file = path.join(f.config.deviceHome, 'runner-deployments.json'), disk = fs.readFileSync(file, 'utf8');
    const names = fs.readdirSync(f.config.deviceHome).sort();
    const response = await f.cli(['runner', 'deployments', 'get']);
    expect(response).toMatchObject({ code: 0, err: '' });
    const { items: [item] } = JSON.parse(response.out);
    expect(item).toMatchObject({ id: row.id, revision: row.revision, status: 'unknown', stages: [{ id: 'install_runtime', status: 'unknown' }] });
    expect(item.plan.target).toEqual({ os: 'linux', arch: 'x64', user: 'fixture', uid: 1000, home: '/home/fixture' });
    expect(item.plan.runtime).toEqual({ version: Bun.version, source: 'official-bun', sha256: 'b'.repeat(64), size: 79500640 });
    expect(item.recoveries[0]).toMatchObject({ id: uuid, status: 'unknown', plan: { from_generation: 0, to_generation: 1, supported: false,
      blockers: [{ code: 'old_commands_unconfirmed' }], old_commands: { status: 'unconfirmed' } }, stages: [{ id: 'bind_runtime_generation', status: 'unknown' }] });
    expect(item.runtime_generation).toBe(0); expect(publicResult({ items: [item] }, 'runner.deployments.get').items[0]).toEqual(item);
    expect(item.plan.files).toEqual(row.plan.files); expect(item.plan.dependencies).toEqual(row.plan.dependencies); expect(item.plan.cgroup).toEqual(row.plan.cgroup);
    const git = item.plan.actions.find(action => action.id === 'git_install');
    expect(git).toMatchObject({ unit_path: '/etc/systemd/system/lush-runner-git_install-fixture.service', unit_sha256: 'a'.repeat(64),
      unit_summary: 'Fixed git_install unit', effect: 'Start the reviewed git_install unit', packages_truncated: false,
      packages: [{ name: 'git', version: '1:2.39.5-0+deb12u1', previous_version: null, operation: 'install' }] });
    for (const secret of [f.secret, f.machine, 'private-receipt-proof', 'unit_text', 'private_data']) expect(response.out).not.toContain(secret);
    expect(fs.readFileSync(file, 'utf8')).toBe(disk); expect(fs.readdirSync(f.config.deviceHome).sort()).toEqual(names);
    expect(f.deployments.read(row.id).status).toBe('running'); // No read-time reconciliation or durable status rewrite.
    lease = f.deployments.lease(row.id);
    const live = await f.cli(['runner', 'deployments', 'get']);
    expect(live.code).toBe(0); expect(JSON.parse(live.out).items[0].status).toBe('running');
    expect(fs.readFileSync(file, 'utf8')).toBe(disk); expect(f.connections()).toBe(0);
  } finally { lease?.release(); await f.close(); }
});

test('deployment receipts: bounded history exposes truncation and prioritizes unresolved records without mutation', async () => {
  const f = await managementFixture();
  try {
    for (let i = 0; i < 64; i++) f.deployment();
    const unresolved = f.deployment({ status: 'unknown' });
    const before = f.deployments.list();
    const response = await f.cli(['runner', 'deployments', 'get']); expect(response.code).toBe(0);
    const history = JSON.parse(response.out);
    expect(history.version).toBe(1); expect(history.truncated).toBe(true); expect(history.items).toHaveLength(64);
    expect(history.items[0]).toMatchObject({ id: unresolved.id, status: 'unknown' });
    expect(f.deployments.list()).toEqual(before); expect(f.connections()).toBe(0);
  } finally { await f.close(); }
});

test('deployment receipts: unsafe private storage fails closed without repairing files or leaking bodies', async () => {
  const f = await managementFixture();
  try {
    f.deployment();
    const file = path.join(f.config.deviceHome, 'runner-deployments.json'), before = fs.readFileSync(file, 'utf8');
    fs.chmodSync(file, 0o644);
    const response = await f.cli(['runner', 'deployments', 'get']);
    expect(response.code).toBe(1); expect(response.out).toBe('');
    for (const secret of [f.machine, f.secret, 'private-receipt-proof', file]) expect(response.err).not.toContain(secret);
    expect(response.err).toContain('not confirmed'); expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(file, 'utf8')).toBe(before); expect(f.connections()).toBe(0);
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
