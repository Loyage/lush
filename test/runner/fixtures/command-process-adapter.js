import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// TEST ONLY. Models a containment receipt with a process group, NOT cgroup/setsid containment.
export function fixtureController() {
  let child;
  const liveGroup = pid => {
    for (const name of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
      try {
        const text = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) === pid && !['Z', 'X'].includes(fields[0])) return true;
      } catch { /* process exited */ }
    }
    return false;
  };
  return {
    preflight() {},
    prepare(row) { return { kind: 'test-process-group', execution_id: row.execution_id, pid: null }; },
    launch(receipt, spec, workspace, home) {
      child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd === '.' ? workspace.directory : `${workspace.directory}/${spec.cwd}`,
        env: { ...spec.env, HOME: home, TMPDIR: home }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      receipt.pid = child.pid;
      return child;
    },
    populated(receipt) { return Boolean(receipt.pid && liveGroup(receipt.pid)); },
    async stop(receipt) {
      if (receipt.pid) { try { process.kill(-receipt.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      const deadline = Date.now() + 1500;
      while (receipt.pid && liveGroup(receipt.pid)) {
        if (Date.now() > deadline) throw new Error('fixture did not stop');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return true;
    },
  };
}
export function delayedAttachController(mode) {
  return {
    preflight() {},
    prepare(row) { return { kind: 'test-delayed-attach', execution_id: row.execution_id }; },
    launch(receipt, spec, workspace, home, onBootstrap) {
      if (mode === 'unconfirmed-bootstrap') {
        const child = new EventEmitter();
        Object.assign(child, { pid: 1, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => false });
        onBootstrap(child);
        return child; // No OS process: deliberately withholds the exit receipt.
      }
      const child = spawn(process.execPath, [fileURLToPath(new URL('./command-delayed-bootstrap.js', import.meta.url)), workspace.directory], {
        env: { PATH: '/usr/bin:/bin', HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      onBootstrap(child);
      receipt.pid = child.pid; // Fixture only, never used for production recovery.
      if (mode === 'throw-after-spawn') throw new Error('controlled initialization failure after handle capture');
      return child;
    },
    populated() { return false; }, // Parked outside the group: an empty group alone proves nothing.
    async stop() { return true; },
  };
}
// No cgroup directories exist in this adapter. Never used by production assembly; no PID inference.
export function fixtureResourceCleanupController() {
  const verify = (receipt, execution) => {
    if (receipt?.kind !== 'test-process-group' || receipt.execution_id !== execution.execution_id)
      throw new Error('fixture containment identity changed');
    return null;
  };
  return { verify, remove: verify, absent(receipt, execution) { verify(receipt, execution); return true; } };
}

export function fixtureProcessAdapter({ available_memory = 1024 ** 3, guard_mode = 'group', guard_gate } = {}) {
  return {
    preflight() {}, availableMemory: () => available_memory,
    launch({ root, execution_id }) {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./command-fixture-guard.js', import.meta.url))], {
        env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'ignore', 'inherit'], detached: true,
      });
      child.stdin.on('error', () => {});
      child.stdin.write(JSON.stringify({ root, execution_id, guard_mode, guard_gate }) + '\n');
      return child;
    },
    async reconcile() { throw new Error('Test adapter cannot prove historical process ownership'); },
  };
}
