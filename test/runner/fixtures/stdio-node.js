// Test-only independent Runner process. No production switch can select this preflight.
import { RunnerNode } from '../../../src/runner/node.js';
import { serveConnection } from '../../../src/runner/server.js';
import { hash } from '../../../src/runner/protocol.js';
const [root, fault] = process.argv.slice(2);
const node = new RunnerNode({ root, node_id: 'node-a', machine_token_hash: hash(hash('fixture-machine')),
  projects: { 'project-a': { control_token_hash: hash(hash('fixture-control')) } } }, { preflight: async () => {} });
if (fault === 'drop-register') {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (data, ...args) => {
    const response = JSON.parse(String(data));
    if (response.result?.directory) {
      const callback = args.find(value => typeof value === 'function'); callback?.(); return true;
    }
    return original(data, ...args);
  };
}
const server = serveConnection(node);
try { await server.done; } catch { process.exitCode = 1; }
finally { await node.close(); }
