import { createInterface } from 'node:readline';
import { RunnerNode } from '../../../src/runner/node.js';
import { createCommandService } from '../../../src/runner/commands.js';
import { hash, check } from '../../../src/runner/protocol.js';
import { fixtureProcessAdapter } from './command-process-adapter.js';
const root = process.argv[2];
const node = new RunnerNode({ root, node_id: 'node', machine_token_hash: hash(hash('fixture-machine')),
  projects: { p: { control_token_hash: hash(hash('fixture-control')) } }, max_commands: 1, memory_reserve_bytes: 0 });
const command = createCommandService({ store: node.store, config: node.config, process_adapter: fixtureProcessAdapter() });
node.services = { ...command.services, check_context: (_, params) => check(params.context_ack === 'test-context', 'CONTEXT_REQUIRED', 'Missing context') };
node.preflight = command.preflight;
const session = node.openSession();
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  void node.dispatch({ ...request, identity: { ...request.identity, runner_id: node.runner_id } }, session)
    .then(frame => process.stdout.write(JSON.stringify(frame) + '\n'));
});
input.on('close', () => { void node.close().then(() => process.exit(0)); });
