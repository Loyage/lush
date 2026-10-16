// Uploaded controlled entry for native managed-command assembly tests only.
// Not a production Runner, command/stop attestation, or cgroup preflight adapter.
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dir, '../../..');
export function runRunner() { throw new Error('Activated generation must use the dedicated assembly'); }
export async function createRunnerNode(config, { refresh_config }) {
  const original = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
  const expected = { ...original, cgroup_root: '/sys/fs/cgroup/controlled/new.service/runner' };
  if (JSON.stringify(config) !== JSON.stringify(expected) || JSON.stringify(refresh_config()) !== JSON.stringify(expected)) throw new Error('Managed effective configuration changed more than its cgroup');
  return { config, async close() { process.stdout.write(JSON.stringify({ phase: 'closed' }) + '\n'); } };
}
export function serveConnection(node, { input, output }) {
  if (input !== process.stdin || output !== process.stdout) throw new Error('Managed stdio was replaced');
  const done = (async () => {
    let stdin = '';
    for await (const bytes of input) { stdin += bytes; if (stdin.length > 256) throw new Error('Fixture input bound'); }
    if (stdin !== '{"fixture":"protocol-stdin"}\n') throw new Error('Managed bootstrap consumed protocol stdin');
    output.write(JSON.stringify({ phase: 'entry', node_id: node.config.node_id, cgroup_root: node.config.cgroup_root, stdin, bun: Bun.version }) + '\n');
  })();
  return { done, async stop() { await done; } };
}
