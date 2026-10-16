import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeploymentStore } from '../src/core/runner-deployment-store.js';
import { DEPLOYMENT_ACTIONS } from '../src/core/runner-deployment-view.js';
import { fixture, env } from './helpers.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { RPCServer } from '../src/rpc/server.js';
import { StdioTransport } from '../src/runner/index.js';
import { hash, IMPLEMENTATION_VERSION } from '../src/runner/protocol.js';
import { createSignal } from '../src/signal.js';

export async function managementFixture() {
  const f = fixture(); f.project.kick = () => {};
  let connections = 0, files = 0;
  const runnerOptions = { ssh: { home: path.join(f.root, 'isolated-os-user') }, transport_factory() {
    connections++;
    return new StdioTransport({ command: process.execPath,
      args: [path.resolve(import.meta.dir, 'runner/fixtures/integration-node.js'), path.join(f.root, 'node.json')],
      env: { PATH: '/usr/bin:/bin', HOME: f.root } });
  } };
  f.project.runnerOptions = runnerOptions;
  const dispatcher = new Dispatcher(f.project, createSignal()), rpc = new RPCServer(f.config.socket, dispatcher);
  await rpc.start();
  const secret = hash('synthetic-control'), machine = hash('synthetic-machine'), deployments = new DeploymentStore(f.config);
  return { ...f, dispatcher, rpc, runnerOptions, secret, machine, deployments, connections: () => connections,
    // Synthetic private history only: this fixture does not probe, install or approve a real target.
    deployment(value = {}) {
      const actions = DEPLOYMENT_ACTIONS.map(id => ({ id, label: id, privileged: ['git_install', 'cgroup_setup'].includes(id),
        ...(['git_install', 'cgroup_setup'].includes(id) ? { unit_path: `/etc/systemd/system/lush-runner-${id}-fixture.service`,
          unit_sha256: 'a'.repeat(64), unit_summary: `Fixed ${id} unit`, effect: `Start the reviewed ${id} unit`, unit_text: 'private-receipt-proof' } : {}),
        ...(id === 'git_install' ? { packages: [{ name: 'git', version: '1:2.39.5-0+deb12u1', previous_version: null, operation: 'install' }], packages_truncated: false } : {}),
      }));
      return deployments.create({ status: 'planned', ssh_alias: 'fixture-' + randomUUID(), name: 'Fixture deployment', project_id: 'deployment-project',
        plan: { supported: true, blockers: [], target: { os: 'linux', arch: 'x64', user: 'fixture', uid: 1000, home: '/home/fixture', private_proof: 'private-receipt-proof' },
          install_root: '/home/fixture/.local/share/lush-runner/managed/fixture', files: ['bin/bun', 'runner/config.json'], actions,
          runtime: { version: Bun.version, source: 'official-bun', sha256: 'b'.repeat(64), size: 79500640, file: '/private-receipt-proof/bun' },
          runner: { version: IMPLEMENTATION_VERSION, sha256: 'c'.repeat(64), size: 227840, file: '/private-receipt-proof/runner.tar' },
          dependencies: [{ name: 'git', status: 'needs_install', version: '1:2.39.5-0+deb12u1' }],
          cgroup: { status: 'needs_setup', binding: 'post_start', relative_group: 'runner', message: 'A dedicated delegated group is required' },
          system: { repositories: 'private-receipt-proof' } }, stages: [], private_data: { machine_token: machine, control_token: secret, proof: 'private-receipt-proof' }, ...value });
    },
    file(value) { const file = path.join(f.root, `runner-${++files}.json`); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); return file; },
    provision(node_id, project_id) {
      fs.writeFileSync(path.join(f.root, 'node.json'), JSON.stringify({ version: 1, root: path.join(f.root, 'node'), node_id,
        machine_token_hash: hash(machine), projects: { [project_id]: { control_token_hash: hash(secret) } },
        memory_reserve_bytes: 0, cgroup_root: path.join(f.root, 'test-only-cgroup') }), { mode: 0o600 });
    },
    async cli(args, { executable = 'lush', extra = {}, cwd = f.root } = {}) {
      const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, `../bin/${executable}`), '--json', ...args], {
        cwd, env: env({ ...f.config.env, ...extra }), stdout: 'pipe', stderr: 'pipe',
      });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { out, err, code };
    },
    async close() { await rpc.close(); await f.project._runners?.close(); await f.close(); },
  };
}
export const nodeDefinition = () => ({ name: 'Fixture', ssh_alias: 'fixture', enabled: true,
  budgets: { max_commands: 1, timeout_ms: 1000, output_bytes: 4096 } });
