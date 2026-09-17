/**
 * Single-instance daemon lock.
 *
 * POSIX advisory locks are not exposed by Bun, so the lock is an atomically
 * created file holding the daemon PID. Ownership is verified by process
 * liveness, which also makes a lock left behind by a crashed (SIGKILL) daemon
 * reclaimable. The file is written to a temporary path and hard-linked into
 * place so a reader never observes an empty lock file.
 */
import fs from 'node:fs';
import path from 'node:path';
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
