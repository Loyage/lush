import { createCodeService } from './code-reader.js';
import { RunnerNode } from './node.js';
import { createCommandService } from './commands.js';
import { createFileService } from './files.js';
import { createArtifactTransferService } from './artifact-transfer.js';
import { readRunnerConfig, defaultConfigPath } from './config.js';
import { serveConnection } from './server.js';

export { RunnerClient, LocalTransport } from './client.js';
export { StdioTransport, SshTransport } from './transport.js';
export { RunnerNode } from './node.js';
export { RunnerError, PROTOCOL_VERSION, IMPLEMENTATION_VERSION, CAPABILITIES, OPERATIONS, ERROR_CODES, LIMITS } from './protocol.js';
export { readRunnerConfig, defaultConfigPath } from './config.js';
export { serveConnection } from './server.js';

/** Production assembly: always checks real Linux cgroup v2; no adapter/env/CLI bypass. */
export async function createRunnerNode(config, { refresh_config = null } = {}) {
  const node = new RunnerNode(config, { refresh_config });
  try {
    const commands = createCommandService({ store: node.store, config: node.config });
    node.services = { ...commands.services, ...createFileService(), ...createCodeService(), ...createArtifactTransferService({ store: node.store }) };
    node.preflight = commands.preflight;
    await node.preflight();
    return node;
  } catch (error) { await node.close(); throw error; }
}

export async function runRunner({ config_file = defaultConfigPath(), input = process.stdin, output = process.stdout } = {}) {
  const node = await createRunnerNode(readRunnerConfig(config_file), { refresh_config: () => readRunnerConfig(config_file) });
  const connection = serveConnection(node, { input, output });
  const stop = () => { void connection.stop(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try { await connection.done; }
  finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    await node.close();
  }
}
