import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createCgroupController } from './cgroup.js';
import { safeCwd } from './command-state.js';

// Fixed bootstrap only: no untrusted command can execute before this process joins its cgroup.
const input = createInterface({ input: process.stdin });
input.once('line', line => {
  try {
    if (Buffer.byteLength(line) > 256 * 1024) throw new Error('oversize bootstrap');
    const { spec, receipt, workspace, home } = JSON.parse(line);
    input.close();
    createCgroupController({ cgroup_root: spec.cgroup_root, node_id: spec.node_id }).attach(receipt);
    const cwd = safeCwd(workspace, spec.cwd);
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd, env: { ...spec.env, HOME: home, TMPDIR: home }, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('error', () => process.exit(126));
    child.once('exit', (code, signal) => {
      // Guard owns cgroup termination, including descendants that changed process group/session.
      process.exit(code ?? (signal ? 128 : 126));
    });
  } catch { process.exit(126); }
});
input.once('close', () => { /* End of bootstrap frame is normal. */ });
