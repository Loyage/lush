import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fixture, repo, git } from '../helpers.js';
import { StdioTransport } from '../../src/runner/index.js';
import { hash } from '../../src/runner/protocol.js';
import { runnerIdentity } from '../../src/core/runner-service.js';
import { command } from '../workspaces/remote-harness.js';
export { git, command };

// Real Project, independent node processes/object repositories. Containment is test-only,
// not evidence of SSH or a delegated Linux cgroup. Worker creation is seeded explicitly
// until W298-6 connects the production creation/invocation entry points.
export async function runnerProjectFixture() {
  const f = fixture();
  f.project.stopping = true;
  await repo(f.root);
  const nodeFiles = new Map(), clients = new Set();
  const nodeHome = path.join(f.config.home, 'runner-home'); fs.mkdirSync(nodeHome);
  f.project.runnerOptions = { transport_factory(node) {
    return new StdioTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../runner/fixtures/integration-node.js', import.meta.url)), nodeFiles.get(node.id)],
      env: { PATH: '/usr/bin:/bin', HOME: nodeHome } });
  } };
  const service = f.project.runners;
  let settings = await service.saveNodes({ nodes: [0, 1].map(index => ({ name: `Fixture ${index}`, ssh_alias: `fixture-${index}`,
    enabled: true, budgets: { max_commands: 2, timeout_ms: 4000, output_bytes: 16384 } })) }, service.readNodes().revision);
  const policy = (await service.savePolicy({ allowed_node_ids: settings.nodes.map(node => node.id), default_node_id: settings.nodes[0].id }, 0)).policy;
  for (const node of settings.nodes) {
    const machine_token = hash(`machine-${node.id}`), control_token = hash(`control-${node.id}`);
    const file = path.join(f.config.home, `${node.id}.json`);
    nodeFiles.set(node.id, file);
    fs.writeFileSync(file, JSON.stringify({ version: 1, root: path.join(f.config.home, node.id), node_id: node.id,
      machine_token_hash: hash(machine_token), projects: { [policy.project_id]: { control_token_hash: hash(control_token) } },
      memory_reserve_bytes: 0, cgroup_root: path.join(f.config.home, 'test-only-containment') }), { mode: 0o600 });
    await service.saveCredentials({ node_id: node.id, project_id: policy.project_id, machine_token, control_token }, service.readCredentials().revision);
    const hello = await service.checkNode(node.id);
    settings = await service.saveNodes({ nodes: settings.nodes.map(item => item.id === node.id ? { ...item, expected_runner_id: hello.runner_id } : item) }, settings.revision);
  }
  const main = await f.project.ensureMainTask();
  async function worker({ parent_id = main.id, node_index = 0, name = 'remote', prepare = true } = {}) {
    const parent = f.store.task(parent_id), node = settings.nodes[node_index];
    const task = f.store.create({ parent_id, role: 'agent', task_kind: parent_id === main.id ? 'order' : 'child', goal: name, name });
    const base_commit = await git(f.root, 'rev-parse', `refs/heads/${parent.branch}`);
    const identity = { project_id: policy.project_id, node_id: node.id, runner_id: node.expected_runner_id, worker_id: task.id,
      workspace_id: randomUUID(), generation: 1, operation_id: randomUUID() };
    await f.project.workspaces.exclusive(() => f.project.workspaces.prepareRemoteBranchUnsafe(task, parent.branch, base_commit, { identity, guard() {} }));
    const connection = await service.connect(identity); clients.add(connection);
    const options = { client: connection.client, identity, request_id: randomUUID(), authorization_version: policy.authorization_version,
      guard() { service.assertBinding(identity); } };
    if (prepare) {
      await f.project.workspaces.prepareRemoteWorkspace(options);
      f.store.update(task.id, { status: 'waiting', head_commit: base_commit, result: 'fixture result' });
    }
    return { id: task.id, client: connection.client, options, task: f.store.task(task.id), connection };
  }
  async function commit(worker, file = 'remote.txt', content = 'remote') {
    const before = f.store.runnerBinding(worker.id).head_commit;
    // All values are fixture-controlled literals, no user command interpolation.
    const commit = await command(worker.client, `printf '%s\\n' '${content}' > '${file}'; git add '${file}'; git -c user.name=Fixture -c user.email=fixture@invalid commit -m change; git rev-parse HEAD`);
    const tip = commit.split('\n').at(-1);
    await f.project.workspaces.receiveRemoteCommit({ ...worker.options, request_id: randomUUID(), old_commit: before,
      original_commit: before, commit: tip, final_delivery: true, agent_exited: true });
    f.store.update(worker.id, { head_commit: tip, integration: 'pending' });
    return tip;
  }
  return { ...f, main, nodes: settings.nodes, policy, service, worker, commit,
    async close() {
      for (const client of clients) await client.close();
      await service.close(); await f.close();
    } };
}
