import fs from 'node:fs';
import path from 'node:path';
import { fixture, env } from './helpers.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { RPCServer } from '../src/rpc/server.js';
import { StdioTransport } from '../src/runner/index.js';
import { hash } from '../src/runner/protocol.js';
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
  const secret = hash('synthetic-control'), machine = hash('synthetic-machine');
  return { ...f, dispatcher, rpc, runnerOptions, secret, machine, connections: () => connections,
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
