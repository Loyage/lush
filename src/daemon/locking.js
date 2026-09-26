/**
 * Single-instance daemon lock.
 *
 * POSIX advisory locks are not exposed by Bun's `node:fs`, but the `flock(2)` syscall is available
 * through the built-in `bun:ffi`, which keeps the runtime dependency-free. `flock` is a kernel lock:
 * acquisition is atomic, and the kernel drops it when the owning process dies — including SIGKILL —
 * so a crashed daemon can never leave a lock that a later start would have to reclaim by racing on
 * the file. The PID is still written into the file, but only as descriptive state for status and
 * `forceStopDaemon`; ownership is decided by the lock, never by the recorded PID.
 */
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { dlopen, FFIType } from 'bun:ffi';
import { LushError } from '../core/types.js';

const LOCK_NAME = 'daemon.lock';

// flock(2) operation flags are stable across Linux and macOS.
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

let flock = null;

/** Resolve `flock` from libc once. Named dlopen keeps this working on macOS and glibc/musl Linux. */
function loadFlock() {
  if (flock) return flock;
  const candidates = process.platform === 'darwin'
    ? ['libSystem.B.dylib', '/usr/lib/libSystem.B.dylib']
    : ['libc.so.6', 'libc.so', 'libc.musl-x86_64.so.1', 'libc.musl-aarch64.so.1', 'libc.musl-riscv64.so.1'];
  let lastError = null;
  for (const name of candidates) {
    try {
      flock = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock;
      return flock;
    } catch (error) {
      lastError = error;
    }
  }
  throw new LushError(`cannot load the POSIX flock syscall for single-instance locking: ${lastError?.message ?? 'no libc found'}`);
}

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
    this.fd = null;
  }

  acquire() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const fd = fs.openSync(this.path, 'a+', 0o600);
    let rc;
    try {
      rc = Number(loadFlock()(fd, LOCK_EX | LOCK_NB));
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
    if (rc !== 0) {
      fs.closeSync(fd);
      throw new LushError('lushd is already running');
    }
    // The lock is ours; record the PID for status output without changing lock ownership.
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, String(process.pid), 0, 'utf8');
    this.fd = fd;
    this.held = true;
  }

  release() {
    const fd = this.fd;
    this.held = false;
    this.fd = null;
    if (fd === null) return;
    try { loadFlock()(fd, LOCK_UN); } catch { /* process exit releases anyway */ }
    fs.closeSync(fd);
  }
}

/** True while some live process holds the advisory lock for this home. */
export function isLocked(home) {
  const file = lockPath(home);
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return false; }
  try {
    const rc = Number(loadFlock()(fd, LOCK_EX | LOCK_NB));
    if (rc !== 0) return true;
    loadFlock()(fd, LOCK_UN);
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** OS PID named by the lock file, or null when absent or unreadable. Descriptive only, never ownership. */
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
