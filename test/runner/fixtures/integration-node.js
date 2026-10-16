import { createCodeService } from '../../../src/runner/code-reader.js';
// Explicit test assembly. Production bin/lush-runner never imports or selects this adapter.
import { RunnerNode, readRunnerConfig, serveConnection } from '../../../src/runner/index.js';
import { createFileService } from '../../../src/runner/files.js';
import { createArtifactTransferService } from '../../../src/runner/artifact-transfer.js';
import { createCommandService } from '../../../src/runner/commands.js';
import { fixtureProcessAdapter, fixtureResourceCleanupController } from './command-process-adapter.js';
const [config_file, dropped_id, guard_gate] = process.argv.slice(2);
const config = readRunnerConfig(config_file);
const node = new RunnerNode(config, { refresh_config: () => readRunnerConfig(config_file) });
const commands = createCommandService({ store: node.store, config: node.config, process_adapter: fixtureProcessAdapter({ guard_gate }) });
node.services = { ...commands.services, ...createFileService(), ...createCodeService(), ...createArtifactTransferService({ store: node.store, cleanup_controller: fixtureResourceCleanupController() }) }; node.preflight = commands.preflight;
if (dropped_id) {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (data, ...args) => {
    if (JSON.parse(String(data)).request_id === dropped_id) { args.find(value => typeof value === 'function')?.(); return true; }
    return original(data, ...args);
  };
}
const connection = serveConnection(node);
try { await connection.done; } catch { process.exitCode = 1; }
finally { await node.close(); }
