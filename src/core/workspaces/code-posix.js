import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dlopen, FFIType, ptr, read } from 'bun:ffi';

// Like daemon/locking.js, use Bun's bundled FFI and the system libc only.
// No headers/compiler, native package, struct-stat ABI or /proc dependency.
const CANDIDATES = {
  darwin: ['libSystem.B.dylib', '/usr/lib/libSystem.B.dylib'],
  linux: ['libc.so.6', 'libc.so', 'libc.musl-x86_64.so.1', 'libc.musl-aarch64.so.1', 'libc.musl-riscv64.so.1'],
};
const error = code => Object.assign(new Error(`安全文件描述符操作失败 (${code})`), { code });
const errnoName = value => Object.entries(os.constants.errno).find(([, number]) => number === value)?.[0] ?? 'EIO';
// These fcntl constants have the same POSIX ABI on Linux and Darwin. Bun/node:fs
// does not expose O_CLOEXEC, so set FD_CLOEXEC immediately after synchronous openat.
const F_SETFD = 2, FD_CLOEXEC = 1;
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/** Injectable loader is for ABI/failed-load tests; production constructs one lazy instance. */
export function createPosixFiles({ platform = process.platform, load = dlopen, errno = errnoName } = {}) {
  let library;
  const native = () => {
    if (library) return library;
    const errnoSymbol = platform === 'darwin' ? '__error' : '__errno_location';
    const definitions = {
      openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      readlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.usize], returns: FFIType.isize },
      fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      [errnoSymbol]: { args: [], returns: FFIType.ptr },
    };
    for (const candidate of CANDIDATES[platform] ?? []) {
      try {
        const handle = load(candidate, definitions);
        library = { handle, ...handle.symbols, errno: handle.symbols[errnoSymbol] };
        return library;
      } catch { /* Never fall back to path-based content reads. */ }
    }
    throw error('ENOSYS');
  };
  const failure = libc => error(errno(read.i32(libc.errno())));
  const nameBytes = name => {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw error('EINVAL');
    return Buffer.from(name + '\0');
  };
  const openAt = (parent, name, directory = false) => {
    const bytes = nameBytes(name), libc = native();
    const fd = libc.openat(parent, ptr(bytes), OPEN_FLAGS | (directory ? fs.constants.O_DIRECTORY : 0), 0);
    if (fd < 0) throw failure(libc);
    // All calls are synchronous, with no await/spawn between openat and fcntl.
    if (libc.fcntl(fd, F_SETFD, FD_CLOEXEC) < 0) {
      const fail = failure(libc); fs.closeSync(fd); throw fail;
    }
    return fd;
  };
  const readLinkAt = (parent, name) => {
    const bytes = nameBytes(name), buffer = Buffer.alloc(16384), libc = native();
    const length = Number(libc.readlinkat(parent, ptr(bytes), ptr(buffer), buffer.length));
    if (length < 0) throw failure(libc);
    if (length >= buffer.length) throw error('EFBIG');
    return buffer.subarray(0, length).toString('utf8');
  };
  const openDirectory = root => {
    if (!path.isAbsolute(root) || path.resolve(root) !== root) throw error('EINVAL');
    // Traverse even trusted-root ancestors by descriptor: a swapped parent symlink
    // must not redirect the initial absolute open outside the recorded worktree.
    let fd = fs.openSync(path.parse(root).root, OPEN_FLAGS | fs.constants.O_DIRECTORY);
    try {
      for (const name of root.slice(path.parse(root).root.length).split(path.sep).filter(Boolean)) {
        const next = openAt(fd, name, true); fs.closeSync(fd); fd = next;
      }
      const actual = fs.fstatSync(fd, { bigint: true }), named = fs.statSync(root, { bigint: true });
      if (actual.dev !== named.dev || actual.ino !== named.ino) throw error('ESTALE');
      return fd;
    } catch (fail) { fs.closeSync(fd); throw fail; }
  };
  return { openAt, readLinkAt, openDirectory };
}

export const posixFiles = createPosixFiles();
