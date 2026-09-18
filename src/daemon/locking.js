/**
 * Single-instance daemon lock.
 *
 * POSIX advisory locks are not exposed by Bun, so the lock is an atomically
 * created file holding the daemon's OS PID. Ownership is verified by process
 * liveness, which also makes a lock left behind by a crashed (SIGKILL) daemon
 * reclaimable.
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
        if (owner !== null && isAlive(owner)) {
          throw new LushError('lushd is already running');
        }
        fs.rmSync(this.path, { force: true });
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

/** OS PID named by the lock file, or null when absent or unreadable. */
export function lockOwner(home) {
  return readPid(lockPath(home));
}

const DAEMON_MARKERS = ['daemon/main.js', 'daemon\\main.js', 'bin/lushd'];

function isLushDaemon(pid) {
  const result = cp.spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (result.error) return false;
  const command = String(result.stdout ?? '').trim();
  return DAEMON_MARKERS.some((marker) => command.includes(marker));
}

/** Force-stop the daemon owning a home, as a last-resort cleanup operation. */
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
