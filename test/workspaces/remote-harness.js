import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/persistence/store.js';
import { Workspaces } from '../../src/core/workspaces.js';
import { RunnerClient, StdioTransport } from '../../src/runner/index.js';
import { hash } from '../../src/runner/protocol.js';
import { git, repo } from '../helpers.js';
export { git };
export async function remoteFixture({ sha256 = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-remote-git-'));
  const project = path.join(root, 'central'); fs.mkdirSync(project);
  if (sha256) await git(project, 'init', '--initial-branch=main', '--object-format=sha256');
  await repo(project);
  const store = new Store(path.join(root, 'central.db'), project);
  const ids = [randomUUID(), randomUUID()];
  const policy = store.saveRunnerProject({ allowed_node_ids: ids, default_node_id: ids[0] }, 0).policy;
  const workspaces = new Workspaces({ project, home: path.join(project, '.lush'), env: process.env }, store);
  const clients = [];
  async function worker(index = 0, parentBranch = 'main', commit = null) {
    const task = store.create({ role: 'agent', goal: 'remote fixture', task_kind: 'order', name: 'remote' });
    const machine_token = hash('machine'), control_token = hash('control');
    const configFile = path.join(root, `node-${task.id}.json`);
    fs.writeFileSync(configFile, JSON.stringify({ version: 1, root: path.join(root, `node-${task.id}`), node_id: ids[index],
      machine_token_hash: hash(machine_token), projects: { [policy.project_id]: { control_token_hash: hash(control_token) } },
      memory_reserve_bytes: 0, cgroup_root: path.join(root, 'test-only-containment') }), { mode: 0o600 });
    const client = new RunnerClient({ transport: new StdioTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../runner/fixtures/integration-node.js', import.meta.url)), configFile], env: { PATH: '/usr/bin:/bin', HOME: root } }),
      identity: { project_id: policy.project_id, node_id: ids[index], worker_id: task.id, workspace_id: `worker-${task.id}`, generation: 1, operation_id: `control-${task.id}` },
      auth: { machine_token, control_token } });
    clients.push(client); await client.handshake();
    const options = { client, identity: client.identity, guard() {}, request_id: `prepare-${task.id}`, authorization_version: policy.authorization_version };
    commit ??= await git(project, 'rev-parse', 'HEAD');
    await workspaces.exclusive(() => workspaces.prepareRemoteBranchUnsafe(task, parentBranch, commit, options));
    await workspaces.prepareRemoteWorkspace(options);
    return { task: store.task(task.id), options, client, commit, configFile };
  }
  return { root, project, store, workspaces, policy, worker,
    async close() { for (const client of clients) await client.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
export async function command(client, script) {
  const context = await client.call('file.context', { scope: 'workspace' });
  const started = await client.call('command.start', { script, context_ack: context.fingerprint });
  const deadline = Date.now() + 6000;
  let status;
  do {
    status = await client.call('command.status', { execution_id: started.execution_id });
    if (status.stop_confirmed) break;
    if (Date.now() > deadline) throw new Error('fixture command did not stop');
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (true);
  if (status.exit_code !== 0) throw new Error('fixture command failed: ' + JSON.stringify(status));
  const output = await client.call('command.output', { execution_id: started.execution_id });
  if (!output.complete || output.gap || output.truncated) throw new Error('fixture command output incomplete');
  return output.chunks.map(chunk => Buffer.from(chunk.data, 'base64').toString()).join('').trim();
}
