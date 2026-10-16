import fs from 'node:fs';
import path from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import { check, fail } from './protocol.js';
let library;
function flock() {
  if (library) return library.symbols.flock;
  const names = process.platform === 'darwin' ? ['libSystem.B.dylib', '/usr/lib/libSystem.B.dylib']
    : ['libc.so.6', 'libc.so', 'libc.musl-x86_64.so.1', 'libc.musl-aarch64.so.1', 'libc.musl-riscv64.so.1'];
  for (const name of names) {
    try { library = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }); return library.symbols.flock; }
    catch { /* no path/PID-based stale lock fallback */ }
  }
  fail('UNSUPPORTED', 'Runner initialization requires POSIX advisory locks');
}
/** Serializes only database bootstrap; lock contention never retries an execution side effect. */
export function withInitializationLock(root, callback, { timeout_ms = 5000 } = {}) {
  const file = path.join(root, 'initialize.lock');
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  let held = false;
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0
      && (typeof process.getuid !== 'function' || stat.uid === process.getuid()), 'UNAUTHORIZED', 'Invalid Runner initialization lock');
    const lock = flock(), deadline = Date.now() + timeout_ms;
    while (Number(lock(fd, 2 | 4)) !== 0) {
      check(Date.now() < deadline, 'BUSY', 'Runner initialization lock deadline exceeded');
      Bun.sleepSync(Math.min(5, Math.max(1, deadline - Date.now())));
    }
    held = true;
    return callback();
  } finally {
    if (held) flock()(fd, 8);
    fs.closeSync(fd);
  }
}
