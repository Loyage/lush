import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunnerService, runnerIdentity } from '../../src/core/runner-service.js';
import { Store } from '../../src/persistence/store.js';
import { StdioTransport } from '../../src/runner/index.js';
import { hash } from '../../src/runner/protocol.js';

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-runner-service-'));
  const store = new Store(path.join(root, 'central.db'), root);
  let connects = 0;
  const service = new RunnerService({ home: path.join(root, 'device') }, store, {
    transport_factory() {
      connects++;
      return new StdioTransport({ command: process.execPath,
        args: [fileURLToPath(new URL('../runner/fixtures/integration-node.js', import.meta.url)), path.join(root, 'node.json')],
        env: { PATH: '/usr/bin:/bin', HOME: root } });
    },
  });
  const saved = await service.saveNodes({ nodes: [{ name: 'Fixture', ssh_alias: 'fixture', enabled: true,
    budgets: { max_commands: 1, timeout_ms: 1000, output_bytes: 4096 } }] }, service.readNodes().revision);
  const node = saved.nodes[0];
  const policy = (await service.savePolicy({ allowed_node_ids: [node.id], default_node_id: node.id }, 0)).policy;
  const machine_token = hash('machine'), control_token = hash('control');
  await service.saveCredentials({ node_id: node.id, project_id: policy.project_id, machine_token, control_token }, service.readCredentials().revision);
  fs.writeFileSync(path.join(root, 'node.json'), JSON.stringify({ version: 1, root: path.join(root, 'node'), node_id: node.id,
    machine_token_hash: hash(machine_token), projects: { [policy.project_id]: { control_token_hash: hash(control_token) } },
    memory_reserve_bytes: 0, cgroup_root: path.join(root, 'test-only-cgroup') }), { mode: 0o600 });
  return { root, service, store, node, policy, machine_token, control_token, connects: () => connects,
    async pin() {
      const diagnostic = await service.checkNode(node.id);
      const current = service.readNodes();
      await service.saveNodes({ nodes: [{ ...current.nodes[0], expected_runner_id: diagnostic.runner_id }] }, current.revision);
      return diagnostic;
    },
    async close() { await service.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
async function active(f) {
  const diagnostic = await f.pin();
  const task = f.store.create({ role: 'agent', goal: 'fixture', task_kind: 'order' });
  const identity = { project_id: f.policy.project_id, node_id: f.node.id, runner_id: diagnostic.runner_id,
    worker_id: task.id, workspace_id: 'owned', generation: 1 };
  const binding = f.store.bindRunnerWorkspace({ ...identity, base_commit: 'a'.repeat(40) });
  const connection = await f.service.connect({ ...identity, operation_id: 'prepare' });
  await connection.client.call('workspace.register');
  f.store.confirmRunnerWorkspace(identity, binding.head_commit, binding.revision);
  const run = f.store.startRun(f.store.update(task.id, { status: 'running' }), { agent: 'mock' });
  const runIdentity = { ...identity, run_id: run.id };
  f.store.authorizeRunnerRun(runIdentity, f.policy.authorization_version);
  await connection.client.call('lease.grant', { run_id: run.id, run_token: hash('run') });
  return { connection, identity: runIdentity, task, run };
}

test('Runner management reads are inert, explicit check authenticates and never silently pins', async () => {
  const f = await fixture();
  try {
    expect(f.service.readNodes().nodes).toHaveLength(1);
    expect(f.service.readCredentials().nodes[0].machine_configured).toBe(true);
    expect(f.connects()).toBe(0);
    expect(() => f.service.selectNode()).toThrow('pinned');
    const diagnostic = await f.service.checkNode(f.node.id);
    expect(diagnostic.runner_id).toBeTruthy(); expect(diagnostic.pinned).toBe(false);
    expect(f.service.readNodes().nodes[0].expected_runner_id).toBeNull();
    await f.pin();
    expect(f.service.selectNode().id).toBe(f.node.id);
    expect(f.service.selectNode(undefined, 100)).toBeNull(); // child of an unbound local Worker stays local
    expect(JSON.stringify([diagnostic, f.service.readNodes(), f.service.readCredentials()])).not.toContain(f.control_token);
    expect(JSON.stringify(f.service)).not.toContain(f.machine_token);
    const current = f.service.readNodes();
    await expect(f.service.saveNodes({ nodes: [{ ...current.nodes[0], expected_runner_id: 'changed' }] }, current.revision)).rejects.toThrow('pinned');
  } finally { await f.close(); }
});

test('current device disable revokes only the active Run, retains grants and uses fixed stop authority', async () => {
  const f = await fixture();
  try {
    const a = await active(f); let stops = 0;
    const unwatch = f.service.watchRun(a.identity, async () => {
      stops++;
      const result = await a.connection.client.call('lease.revoke');
      expect(result.stopped).toBe(true);
      return result;
    });
    let view = f.service.readNodes();
    await f.service.saveNodes({ nodes: [{ ...view.nodes[0], name: 'Renamed' }] }, view.revision);
    expect(stops).toBe(0);
    f.service.assertBinding(a.identity);
    view = f.service.readNodes();
    await f.service.saveNodes({ nodes: [{ ...view.nodes[0], enabled: false }] }, view.revision);
    expect(stops).toBe(1);
    expect(f.store.runnerRun(a.run.id).state).toBe('revoked');
    expect(f.service.readPolicy().allowed_node_ids).toContain(f.node.id);
    expect(() => f.service.assertBinding(a.identity)).toThrow('disabled');
    view = f.service.readNodes();
    await f.service.saveNodes({ nodes: [{ ...view.nodes[0], enabled: true }] }, view.revision);
    expect(() => f.service.assertBinding(a.identity)).toThrow('revoked');
    expect(stops).toBe(1);
    unwatch(); await a.connection.close();
    // A retained revoked Run is a durable barrier, not magically released by close or a signal.
    expect(f.store.runnerBarriers(a.task.id).runs).toHaveLength(1);
  } finally { await f.close(); }
});

test('credential rotation invalidates current writes and unconfirmed stop persists unknown', async () => {
  const f = await fixture();
  try {
    const a = await active(f); let stops = 0;
    f.service.watchRun(a.identity, async () => { stops++; return { stopped: false, unknown: true }; });
    await f.service.saveCredentials({ node_id: f.node.id, project_id: f.policy.project_id,
      control_token: hash('rotated') }, f.service.readCredentials().revision);
    expect(stops).toBe(1);
    expect(f.store.runnerBinding(a.task.id).state).toBe('unknown');
    expect(f.store.runnerBarriers(a.task.id).bindings).toHaveLength(1);
    expect(() => f.service.assertBinding(a.identity)).toThrow('blocked');
    expect(() => f.service.assertBinding({ ...a.identity, generation: 2 }, { observation: true })).toThrow('identity');
    await a.connection.close();
  } finally { await f.close(); }
});

test('stopRun retains registered stop proof after credential rotation without reconnecting or repeating the callback', async () => {
  const f = await fixture();
  try {
    const a = await active(f); let stops = 0;
    f.service.watchRun(a.identity, async () => { stops++; return a.connection.client.call('lease.revoke'); });
    const connections = f.connects();
    await f.service.saveCredentials({ node_id: f.node.id, project_id: f.policy.project_id,
      control_token: hash('rotated-control') }, f.service.readCredentials().revision);
    expect(stops).toBe(1);
    expect(await f.service.stopRun(a.run.id)).toEqual({ stopped: true, unknown: false });
    expect(stops).toBe(1); expect(f.connects()).toBe(connections);
    expect(f.store.runnerRun(a.run.id).state).toBe('released');
  } finally { await f.close(); }
});

test('connection assertCurrent rejects handshake races but ignores a display-only rename', async () => {
  for (const change of ['credentials', 'disable', 'budgets', 'name']) {
    const f = await fixture();
    try {
      const hello = await f.pin();
      const task = f.store.create({ role: 'agent', goal: 'handshake admission', task_kind: 'order' });
      const binding = f.store.bindRunnerWorkspace({ project_id: f.policy.project_id, node_id: f.node.id,
        runner_id: hello.runner_id, worker_id: task.id, workspace_id: 'first-admission', generation: 1, base_commit: 'a'.repeat(40) });
      const original = f.service.transport_factory;
      const methods = [];
      f.service.transport_factory = node => {
        const transport = original(node), request = transport.request.bind(transport);
        transport.request = async (frame, options) => {
          methods.push(frame.method);
          const result = await request(frame, options);
          if (frame.method === 'hello') {
            if (change === 'credentials') await f.service.saveCredentials({ node_id: f.node.id, project_id: f.policy.project_id,
              control_token: hash('handshake-rotation') }, f.service.readCredentials().revision);
            else {
              const current = f.service.readNodes();
              await f.service.saveNodes({ nodes: current.nodes.map(item => ({ ...item,
                ...(change === 'disable' ? { enabled: false } : change === 'name' ? { name: 'renamed' }
                  : { budgets: { ...item.budgets, output_bytes: 2048 } }) })) }, current.revision);
            }
          }
          return result;
        };
        return transport;
      };
      const opening = f.service.connect(runnerIdentity(binding, { operation_id: 'first-connect' }));
      if (change === 'name') {
        const connection = await opening;
        expect(() => connection.assertCurrent()).not.toThrow(); await connection.close();
      } else await expect(opening).rejects.toThrow('connection');
      expect(methods).toEqual(['hello']); // no lease or ordinary write was admitted
    } finally { await f.close(); }
  }
});

test('connection version is rechecked after handshake without revoking its retained stop authority', async () => {
  const f = await fixture();
  try {
    const a = await active(f);
    a.connection.assertCurrent();
    const current = f.service.readNodes();
    await f.service.saveNodes({ nodes: [{ ...current.nodes[0], budgets: { ...current.nodes[0].budgets, timeout_ms: 500 } }] }, current.revision);
    expect(() => a.connection.assertCurrent()).toThrow('configuration changed');
    expect((await a.connection.client.call('lease.revoke')).stopped).toBe(true);
  } finally { await f.close(); }
});

test('project authorization revocation stops tracked Run and never silently selects local', async () => {
  const f = await fixture();
  try {
    const a = await active(f); let stopped = false;
    f.service.watchRun(a.identity, async () => { stopped = true; return a.connection.client.call('lease.revoke'); });
    await f.service.savePolicy({ allowed_node_ids: [], default_node_id: f.node.id }, f.service.readPolicy().revision);
    expect(stopped).toBe(true);
    expect(f.service.readPolicy().default_node_id).toBe(f.node.id);
    expect(() => f.service.selectNode()).toThrow('not authorized');
    expect(() => f.service.selectNode(f.node.id)).toThrow('not authorized');
    expect(() => f.service.selectNode(undefined, a.task.id)).toThrow('not authorized');
    expect(f.service.selectNode('local')).toBeNull(); // an explicit local choice is not a fallback
    await expect(f.service.savePolicy({ allowed_node_ids: [], default_node_id: '11111111-1111-4111-8111-111111111111' },
      f.service.readPolicy().revision)).rejects.toThrow('New default');
    expect(f.service.readPolicy().default_node_id).toBe(f.node.id);
    expect(f.store.runnerRun(a.run.id).state).toBe('revoked');
    const forged = runnerIdentity(a.identity, { operation_id: 'control' }); forged.runner_id = 'different';
    await expect(f.service.connect(forged, { observation: true })).rejects.toThrow('identity');
  } finally { await f.close(); }
});
