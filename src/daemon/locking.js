/**
 * Single-instance daemon lock.
 *
 * POSIX advisory locks are not exposed by Bun, so the lock is an atomically
 * created file holding the daemon PID. Ownership is verified by process
 * liveness, which also makes a lock left behind by a crashed (SIGKILL) daemon
 * reclaimable. The file is written to a temporary path and hard-linked into
 * place so a reader never observes an empty lock file.
 *
 * The same file is also the only durable record of "which daemon owns this
 * home", so it is what `forceStopDaemon` reads when the graceful path is not
 * available (test teardown, the demo, `just prune`).
 */
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { LushError } from '../core/types.js';

const LOCK_NAME = 'daemon.lock';

function lockPath(home) {
  return path.join(home, LOCK_NAME);
}

function readPid(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!/^\d+$/.test(raw)) return null;
    const pid = Number.parseInt(raw, 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return err.code === 'EPERM';
  }
}

export class DaemonLock {
  constructor(home) {
    this.path = lockPath(home);
    this.held = false;
  }

  acquire() {
    const tmp = `${this.path}.${process.pid}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      fs.writeFileSync(tmp, String(process.pid), { mode: 0o600 });
      try {
        fs.linkSync(tmp, this.path);
        this.held = true;
        fs.rmSync(tmp, { force: true });
        return;
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        if (err.code !== 'EEXIST') throw err;
        const owner = readPid(this.path);
        if (owner !== null && owner !== process.pid && isAlive(owner)) {
          throw new LushError('lushd is already running');
        }
        fs.rmSync(this.path, { force: true }); // stale lock from a crashed daemon
      }
    }
    throw new LushError('lushd is already running');
  }

  release() {
    if (!this.held) return;
    this.held = false;
    const owner = readPid(this.path);
    if (owner === null || owner === process.pid) fs.rmSync(this.path, { force: true });
  }
}

export function isLocked(home) {
  const file = lockPath(home);
  if (!fs.existsSync(file)) return false;
  const owner = readPid(file);
  return owner !== null && isAlive(owner);
}

/** PID named by the lock file, or null when the file is absent or unreadable. */
export function lockOwner(home) {
  return readPid(lockPath(home));
}

/** Ways a Lush daemon appears in `ps` output: `src/daemon/main.js`, or the `lushd` bin. */
const DAEMON_MARKERS = ['daemon/main.js', 'daemon\\main.js', 'bin/lushd'];

function isLushDaemon(pid) {
  const result = cp.spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (result.error) return false; // no `ps`, or the process is already gone
  const command = String(result.stdout ?? '').trim();
  return DAEMON_MARKERS.some((marker) => command.includes(marker));
}

/**
 * Force-stop the daemon that owns `home`.
 *
 * `lush daemon stop` is graceful and can fail: the socket may be gone, the
 * daemon may be wedged inside a handler, or the shutdown reply may never
 * arrive — and a detached daemon then outlives the run that started it. This
 * is the last resort for test teardown, the demo and `just prune`.
 *
 * The pid is only signalled after checking that it really is a Lush daemon:
 * pids are recycled, and killing a stranger is worse than leaking a process.
 * Returns `{ pid, killed, reason }`; a daemon that is already gone reports
 * `killed: false` rather than an error.
 */
export async function forceStopDaemon(home, { signal = 'SIGKILL', timeoutMs = 3000 } = {}) {
  const pid = lockOwner(home);
  if (pid === null) return { pid: null, killed: false, reason: 'no lock file' };
  if (!isAlive(pid)) return { pid, killed: false, reason: 'lock owner is gone' };
  if (!isLushDaemon(pid)) return { pid, killed: false, reason: 'lock owner is not a lush daemon' };
  try {
    process.kill(pid, signal);
  } catch (err) {
    return { pid, killed: false, reason: `kill failed: ${err.message}` };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return { pid, killed: true, reason: signal };
    await Bun.sleep(20);
  }
  return { pid, killed: false, reason: `still alive ${timeoutMs}ms after ${signal}` };
}
