// Internal supervisor: the daemon owns stdin. EOF (including a daemon crash) kills only our process group.
import { spawn } from 'node:child_process';

const [cwd, encoded] = process.argv.slice(2);
const argv = JSON.parse(encoded);
const child = spawn(argv[0], argv.slice(1), { cwd, env: process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
let stopping = false;
function signal(value) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(value);
    else process.kill(-child.pid, value);
  } catch { /* group already exited */ }
}
function stop() {
  if (stopping) return;
  stopping = true;
  signal('SIGTERM');
  setTimeout(() => { signal('SIGKILL'); process.exit(0); }, 1000);
}
child.on('error', error => { console.error(error.message); stop(); });
child.on('exit', stop); // Also reap descendants left by a wrapper command that exited.
process.stdout.on('error', stop);
process.stderr.on('error', stop);
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdin.resume();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
