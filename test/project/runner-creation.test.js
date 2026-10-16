import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fixture, repo, git } from '../helpers.js';
import { runnerIdentity } from '../../src/core/runner-service.js';
import { StdioTransport } from '../../src/runner/index.js';
import { hash } from '../../src/runner/protocol.js';
import { command } from '../workspaces/remote-harness.js';

const profile = { agent: 'pi', config_mode: 'lush', model: '', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [] };
async function setup({ pinned = true } = {}) {
  const f = fixture({ resolve: () => profile, async run() { throw new Error('creation fixture must not start a Provider'); } });
  await repo(f.root);
  f.project.kick = () => {}; // Creation tests explicitly stop at the queued/paused boundary.
  const service = f.project.runners;
  const saved = await service.saveNodes({ nodes: ['A', 'B'].map(name => ({ name, ssh_alias: `fixture-${name}`, enabled: true,
    ...(pinned ? { expected_runner_id: randomUUID() } : {}), budgets: { max_commands: 1, timeout_ms: 1000, output_bytes: 4096 } })) }, service.readNodes().revision);
  const [a, b] = saved.nodes;
  const policy = (await service.savePolicy({ allowed_node_ids: [a.id, b.id], default_node_id: 'local' }, 0)).policy;
  for (const node of saved.nodes) await service.saveCredentials({ node_id: node.id, project_id: policy.project_id,
    machine_token: hash('machine'), control_token: hash('control') }, service.readCredentials().revision);
  const close = f.close;
  f.close = async () => { await service.close(); await close(); };
  return { ...f, a, b, service, policy };
}
const order = (f, node, content = 'work') => f.project.order(content, null, [], null, false, undefined, null, false, node);

test('new order freezes selected node with only central refs; existing local and local children do not migrate', async () => {
  const f = await setup();
  try {
    const local = (await order(f, undefined, 'original local')).task;
    await f.service.savePolicy({ allowed_node_ids: [f.a.id, f.b.id], default_node_id: f.a.id }, f.service.readPolicy().revision);
    const remote = await order(f, undefined, 'default remote');
    expect(remote.task.workspace).toBeNull(); expect(remote.anchor.workspace).toBeNull();
    expect(f.store.runnerBinding(remote.task.id)).toMatchObject({ node_id: f.a.id, runner_id: f.a.expected_runner_id, state: 'preparing' });
    expect(f.store.branch(remote.task.branch).worktree).toBeNull();
    expect(f.store.get('SELECT anchor_workspace FROM inputs WHERE id=?', remote.id).anchor_workspace).toBeNull();
    expect(await git(f.root, 'rev-parse', remote.task.branch)).toBe(remote.task.base_commit);
    const checkouts = await git(f.root, 'worktree', 'list', '--porcelain');
    expect(checkouts).not.toContain(`branch refs/heads/${remote.task.branch}\n`);
    expect(f.store.runnerBinding(local.id)).toBeNull(); expect(fs.existsSync(local.workspace)).toBe(true);
    const localChild = await f.project.spawn(local.id, 'inherits local');
    expect(f.store.runnerBinding(localChild.id)).toBeNull(); expect(localChild.workspace).toBeTruthy();
    const cross = await f.project.spawn(local.id, 'explicit remote', undefined, [], 'remote', null, f.b.id);
    expect(cross.workspace).toBeNull(); expect(f.store.runnerBinding(cross.id).node_id).toBe(f.b.id);
    const override = (await order(f, 'local', 'explicit local')).task;
    expect(override.workspace).toBeTruthy(); expect(f.store.runnerBinding(override.id)).toBeNull();
  } finally { await f.close(); }
});

test('unsupported remote profiles, denied node and revoked default reject before Input/Worker/ref admission', async () => {
  const f = await setup();
  try {
    await f.project.ensureMainTask();
    const before = { tasks: f.store.tasks().length, inputs: f.store.all('SELECT id FROM inputs').length, refs: await git(f.root, 'show-ref') };
    const reject = async (promise, message) => {
      await expect(promise).rejects.toThrow(message);
      expect({ tasks: f.store.tasks().length, inputs: f.store.all('SELECT id FROM inputs').length, refs: await git(f.root, 'show-ref') }).toEqual(before);
    };
    for (const bad of [{ ...profile, agent: 'codex' }, { ...profile, config_mode: 'pi' },
      { ...profile, extensions: ['/tmp/custom-extension.js'] }, { ...profile, skills: ['/tmp/custom-skill'] }]) {
      await reject(f.project.order('no', null, [], null, false, undefined, bad, false, f.a.id), /[Rr]emote/);
    }
    await reject(order(f, ''), 'runner_node_id');
    await reject(order(f, randomUUID()), 'registered');
    await reject(f.project.order('deferred', null, [], null, false, undefined, null, true, f.a.id), 'deferred');
    // Store intentionally retains a selected-but-revoked default rather than falling back locally.
    f.store.saveRunnerProject({ allowed_node_ids: [f.b.id], default_node_id: f.a.id }, f.service.readPolicy().revision);
    await reject(order(f, undefined), 'not authorized');
  } finally { await f.close(); }
});

test('remote parent captures real committed tip before same-node, cross-node and explicit-local children', async () => {
  const f = await setup({ pinned: false }); let connection;
  try {
    // Authenticated diagnostic obtains a real persistent installation identity; user explicitly saves it.
    const nodeRoot = path.join(f.root, '.lush', 'test-runner');
    const configFile = path.join(f.root, '.lush', 'runner-fixture.json');
    fs.writeFileSync(configFile, JSON.stringify({ version: 1, root: nodeRoot, node_id: f.a.id,
      machine_token_hash: hash(hash('machine')), projects: { [f.policy.project_id]: { control_token_hash: hash(hash('control')) } },
      cgroup_root: path.join(f.root, '.lush', 'test-cgroup'), memory_reserve_bytes: 0 }), { mode: 0o600 });
    f.service.transport_factory = () => new StdioTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../runner/fixtures/integration-node.js', import.meta.url)), configFile], env: { PATH: '/usr/bin:/bin', HOME: f.root } });
    const diagnostic = await f.service.checkNode(f.a.id);
    const current = f.service.readNodes();
    await f.service.saveNodes({ nodes: current.nodes.map(node => ({ ...node,
      expected_runner_id: node.id === f.a.id ? diagnostic.runner_id : randomUUID() })) }, current.revision);
    const parent = (await order(f, f.a.id, 'remote parent')).task;
    const binding = f.store.runnerBinding(parent.id), identity = runnerIdentity(binding, { operation_id: randomUUID() });
    connection = await f.service.connect(identity);
    const options = { client: connection.client, identity, guard: () => f.service.assertBinding(identity),
      request_id: randomUUID(), authorization_version: f.policy.authorization_version };
    await f.project.workspaces.prepareRemoteWorkspace(options);
    await connection.client.call('lease.grant', { run_id: 999, run_token: hash('fixture-commit') });
    const runClient = connection.client.forRun({ run_id: 999, run_token: hash('fixture-commit') });
    const tip = await command(runClient, 'printf remote > remote.txt; git add remote.txt; git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m remote >/dev/null; git rev-parse HEAD');
    expect(tip).not.toBe(binding.head_commit);
    expect((await runClient.call('lease.release')).stopped).toBe(true);
    const child = await f.project.spawn(parent.id, 'same node');
    expect(child.base_commit).toBe(tip); expect(child.workspace).toBeNull();
    expect(f.store.runnerBinding(child.id).node_id).toBe(f.a.id);
    expect(f.store.runnerBinding(parent.id).head_commit).toBe(tip);
    expect(await git(f.root, 'show', `${child.branch}:remote.txt`)).toBe('remote');
    const cross = await f.project.spawn(parent.id, 'cross node', undefined, [], null, null, f.b.id);
    expect(cross.base_commit).toBe(tip); expect(f.store.runnerBinding(cross.id).node_id).toBe(f.b.id);
    const local = await f.project.spawn(parent.id, 'local child', undefined, [], null, null, 'local');
    expect(f.store.runnerBinding(local.id)).toBeNull(); expect(local.base_commit).toBe(tip);
    expect(fs.readFileSync(path.join(local.workspace, 'remote.txt'), 'utf8')).toBe('remote');
  } finally { await connection?.close(); await f.close(); }
});
