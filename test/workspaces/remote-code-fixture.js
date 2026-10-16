import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fixture, temp, repo, git } from '../helpers.js';
import { StdioTransport } from '../../src/runner/index.js';
import { hash } from '../../src/runner/protocol.js';

/** Real Project + independent stdio Runner and repository. Only cgroup containment is a fixture. */
export async function remoteCodeFixture({ sha256 = false } = {}) {
  const f = fixture(), nodeRoot = temp(), nodeFile = path.join(nodeRoot, 'config.json');
  let connects = 0;
  f.project.runnerOptions = { transport_factory() {
    connects++;
    return new StdioTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../runner/fixtures/integration-node.js', import.meta.url)), nodeFile],
      env: { PATH: '/usr/bin:/bin', HOME: nodeRoot } });
  } };
  const service = f.project.runners;
  let connection;
  try {
    if (sha256) await git(f.root, 'init', '--initial-branch=main', '--object-format=sha256');
    await repo(f.root);
    let nodes = service.readNodes();
    nodes = await service.saveNodes({ nodes: [{ name: 'Reader fixture', ssh_alias: 'reader', enabled: true,
      budgets: { max_commands: 1, timeout_ms: 1000, output_bytes: 4096 } }] }, nodes.revision);
    const node = nodes.nodes[0];
    const policy = (await service.savePolicy({ allowed_node_ids: [node.id], default_node_id: node.id }, 0)).policy;
    const machine_token = hash('code-machine'), control_token = hash('code-control');
    await service.saveCredentials({ node_id: node.id, project_id: policy.project_id, machine_token, control_token }, service.readCredentials().revision);
    fs.writeFileSync(nodeFile, JSON.stringify({ version: 1, root: path.join(nodeRoot, 'runner'), node_id: node.id,
      machine_token_hash: hash(machine_token), projects: { [policy.project_id]: { control_token_hash: hash(control_token) } },
      memory_reserve_bytes: 0, cgroup_root: path.join(nodeRoot, 'fixture-only-containment') }), { mode: 0o600 });
    const hello = await service.checkNode(node.id);
    await service.saveNodes({ nodes: [{ ...node, expected_runner_id: hello.runner_id }] }, nodes.revision);
    const task = f.store.create({ role: 'agent', task_kind: 'order', goal: 'code fixture', name: 'code-fixture' });
    f.store.update(task.id, { status: 'paused' });
    const identity = { project_id: policy.project_id, node_id: node.id, runner_id: hello.runner_id, worker_id: task.id,
      workspace_id: `reader-${task.id}`, generation: 1, operation_id: randomUUID() };
    const base = await git(f.root, 'rev-parse', 'HEAD');
    const options = { identity, request_id: randomUUID(), authorization_version: policy.authorization_version,
      guard() { service.selectNode(node.id); } };
    await f.project.workspaces.exclusive(() => f.project.workspaces.prepareRemoteBranchUnsafe(task, 'main', base, options));
    connection = await service.connect(identity); options.client = connection.client;
    await f.project.workspaces.prepareRemoteWorkspace(options);
    const remote = (await connection.client.call('workspace.inspect')).directory;
    return { ...f, nodeRoot, nodeFile, service, node, policy, identity, base, remote, options, client: connection.client,
      task: f.store.task(task.id), connects: () => connects,
      state(opts) { return f.project.codeState(task.id, opts); },
      tree(opts) { return f.project.codeTree(task.id, opts); },
      file(name, opts) { return f.project.codeFile(task.id, { path: name, ...opts }); },
      write(name, content) { fs.mkdirSync(path.dirname(path.join(remote, name)), { recursive: true }); fs.writeFileSync(path.join(remote, name), content); },
      async commit() {
        await git(remote, 'add', '.');
        await git(remote, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'code change');
        return git(remote, 'rev-parse', 'HEAD');
      },
      async close() { await connection.close(); await service.close(); await f.close(); fs.rmSync(nodeRoot, { recursive: true, force: true }); },
    };
  } catch (error) { await connection?.close(); await service.close(); await f.close(); fs.rmSync(nodeRoot, { recursive: true, force: true }); throw error; }
}
