import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, repo } from '../../helpers.js';
import { StdioTransport } from '../../../src/runner/index.js';
import { hash } from '../../../src/runner/protocol.js';
import { Dispatcher } from '../../../src/rpc/dispatcher.js';
import { REMOTE_PI_VERSION } from '../../../src/agent/remote-contract.js';

export const remoteProfile = { agent: 'pi', config_mode: 'lush', model: '', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [] };
/** Project lifecycle + real Dispatcher/Bridge/independent Runner. Controlled Provider does NOT load
 * the SDK; its inert compatible installation metadata exercises the admission version boundary.
 * Only Runner containment is a test adapter. This is not SSH/cgroup/real Pi SDK acceptance.
 */
export async function runnerProject(provider, { intercept = null } = {}) {
  const f = fixture({ resolve: () => remoteProfile, ...provider });
  try {
    await repo(f.root);
    const sdk = path.join(f.config.home, 'test-sdk'); fs.mkdirSync(sdk, { recursive: true });
    fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: REMOTE_PI_VERSION, exports: './index.js' }));
    fs.writeFileSync(path.join(sdk, 'index.js'), 'throw new Error("fixture SDK must not execute");');
    fs.writeFileSync(path.join(sdk, 'pi'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    f.config.env.LUSH_PI_COMMAND = path.join(sdk, 'pi');
    const configs = new Map();
    f.project.runnerOptions.transport_factory = node => {
      const transport = new StdioTransport({ command: process.execPath,
        args: [fileURLToPath(new URL('../../runner/fixtures/integration-node.js', import.meta.url)), configs.get(node.id)],
        env: { PATH: '/usr/bin:/bin', HOME: f.config.home } });
      if (intercept) {
        const request = transport.request.bind(transport);
        transport.request = (frame, options) => intercept(frame, () => request(frame, options));
      }
      return transport;
    };
    const service = f.project.runners;
    const nodes = (await service.saveNodes({ nodes: ['A', 'B'].map(name => ({ name, ssh_alias: `fixture-${name}`, enabled: true,
      budgets: { max_commands: 2, timeout_ms: 5000, output_bytes: 65536 } })) }, service.readNodes().revision)).nodes;
    const policy = (await service.savePolicy({ allowed_node_ids: nodes.map(node => node.id), default_node_id: nodes[0].id }, 0)).policy;
    for (const node of nodes) {
      await service.saveCredentials({ node_id: node.id, project_id: policy.project_id,
        machine_token: hash('machine'), control_token: hash('control') }, service.readCredentials().revision);
      const config = path.join(f.config.home, `test-node-${node.name}.json`); configs.set(node.id, config);
      fs.writeFileSync(config, JSON.stringify({ version: 1, root: path.join(f.config.home, `node-${node.name}`), node_id: node.id,
        machine_token_hash: hash(hash('machine')), projects: { [policy.project_id]: { control_token_hash: hash(hash('control')) } },
        memory_reserve_bytes: 0, cgroup_root: path.join(f.config.home, 'fixture-cgroup') }), { mode: 0o600 });
      const diagnostic = await service.checkNode(node.id), current = service.readNodes();
      await service.saveNodes({ nodes: current.nodes.map(value => value.id === node.id ? { ...value, expected_runner_id: diagnostic.runner_id } : value) }, current.revision);
    }
    const dispatcher = new Dispatcher(f.project, { isRequested: () => false });
    return { ...f, service, nodes: service.readNodes().nodes, dispatcher, sdk,
      async close() { await f.project.shutdown(); await service.close(); await f.close(); } };
  } catch (error) { await f.project._runners?.close(); await f.close(); throw error; }
}
