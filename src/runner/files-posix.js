import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { dlopen, FFIType, ptr, read } from 'bun:ffi';
import { posixFiles } from '../core/workspaces/code-posix.js';
import { check, fail, RunnerError } from './protocol.js';

let library;
function native() {
  if (library) return library;
  check(process.platform === 'linux', 'UNSUPPORTED', 'Runner file writes require Linux');
  const definitions = {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    linkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  };
  for (const name of ['libc.so.6', 'libc.so', 'libc.musl-x86_64.so.1', 'libc.musl-aarch64.so.1']) {
    try { const handle = dlopen(name, definitions); library = { handle, ...handle.symbols }; return library; } catch {}
  }
  fail('UNSUPPORTED', 'Safe descriptor-relative writes are unavailable');
}
const bytes = name => Buffer.from(name + '\0');
function syscall(result) {
  if (result >= 0) return result;
  const errno = read.i32(native().__errno_location());
  const code = Object.entries(os.constants.errno).find(([, value]) => value === errno)?.[0] ?? 'EIO';
  throw Object.assign(new Error('Descriptor operation failed'), { code });
}
export function fileError(error) {
  if (error instanceof RunnerError) throw error;
  if (['ELOOP', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) fail('UNAUTHORIZED', 'Path is not a permitted ordinary workspace path');
  if (error.code === 'ENOENT') fail('NOT_FOUND', 'Workspace path does not exist');
  if (error.code === 'ESTALE') fail('STALE', 'Workspace path changed during operation');
  if (error.code === 'EEXIST') fail('CONFLICT', 'Workspace path already exists');
  if (['ENAMETOOLONG', 'EINVAL'].includes(error.code)) fail('INVALID_REQUEST', 'Invalid workspace path');
  throw error; // Unknown I/O may have caused a side effect; the node must retain its receipt/lock.
}
export function relativeFile(value, { root = false } = {}) {
  check(typeof value === 'string' && Buffer.byteLength(value) <= 4096 && !value.includes('\0') && !value.includes('\\')
    && !value.startsWith('/') && !/^[A-Za-z]:/.test(value), 'INVALID_REQUEST', 'Expected a literal workspace-relative path');
  if (root && value === '') return [];
  const parts = value.split('/');
  check(parts.length <= 128 && parts.every(part => part && part !== '.' && part !== '..'), 'INVALID_REQUEST', 'Invalid workspace path components');
  check(!parts.some(part => ['.git', '.lush'].includes(part.toLowerCase())), 'UNAUTHORIZED', 'Reserved workspace path');
  return parts;
}
export const signature = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
export const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** Every untrusted path component is traversed via O_NOFOLLOW directory descriptors. */
export class WorkspaceFiles {
  constructor(workspace) {
    this.workspace = workspace;
    this.fds = new Set();
    try {
      this.root = this.own(posixFiles.openDirectory(workspace.directory));
      const stat = fs.fstatSync(this.root, { bigint: true });
      check(String(stat.dev) === workspace.dev && String(stat.ino) === workspace.ino, 'STALE', 'Workspace root identity changed');
    } catch (error) { this.close(); fileError(error); }
  }
  own(fd) { this.fds.add(fd); return fd; }
  release(fd) { if (this.fds.delete(fd)) fs.closeSync(fd); }
  close() { for (const fd of this.fds) { try { fs.closeSync(fd); } catch {} } this.fds.clear(); }
  directory(parts, create = false) {
    let parent = this.root;
    for (const name of parts) {
      let next;
      try { next = posixFiles.openAt(parent, name, true); }
      catch (error) {
        if (!create || error.code !== 'ENOENT') throw error;
        const encoded = bytes(name);
        try { syscall(native().mkdirat(parent, ptr(encoded), 0o755)); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        next = posixFiles.openAt(parent, name, true);
      }
      const old = parent;
      parent = this.own(next);
      if (old !== this.root) this.release(old);
    }
    return parent;
  }
  open(parent, name) {
    let fd;
    try { fd = this.own(posixFiles.openAt(parent, name)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) { this.release(fd); fail('UNAUTHORIZED', 'Only ordinary files are supported'); }
    return { fd, stat };
  }
  verifyParent(parts, parent) {
    const reopened = this.directory(parts);
    try { check(sameInode(fs.fstatSync(parent, { bigint: true }), fs.fstatSync(reopened, { bigint: true })), 'STALE', 'Parent directory changed'); }
    finally { if (reopened !== this.root && reopened !== parent) this.release(reopened); }
    const named = posixFiles.openDirectory(this.workspace.directory);
    try { check(sameInode(fs.fstatSync(this.root, { bigint: true }), fs.fstatSync(named, { bigint: true })), 'STALE', 'Workspace root changed'); }
    finally { fs.closeSync(named); }
  }
  read(handle, max) {
    check(handle.stat.size <= BigInt(max), 'LIMIT_EXCEEDED', 'File exceeds the bounded read limit', { size: Number(handle.stat.size), max_bytes: max });
    const buffer = Buffer.alloc(Number(handle.stat.size)); let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(handle.fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    check(offset === buffer.length && signature(fs.fstatSync(handle.fd, { bigint: true })) === signature(handle.stat), 'STALE', 'File changed during read');
    return buffer;
  }
  verifyNamed(parent, name, before) {
    const current = this.open(parent, name);
    try { check(before ? current && signature(current.stat) === signature(before.stat) : !current, 'STALE', 'File changed before replacement'); }
    finally { if (current) this.release(current.fd); }
  }
  /** New files use linkat no-replace; existing files are atomically renamed within the locked workspace. */
  replace(parent, name, buffer, before, verify) {
    const temporary = `.lush-runner-write-${randomUUID()}`;
    const temp = bytes(temporary), target = bytes(name), libc = native();
    let fd, created = false, published = false;
    try {
      fd = this.own(syscall(libc.openat(parent, ptr(temp), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600)));
      created = true;
      syscall(libc.fcntl(fd, 2, 1)); // FD_CLOEXEC, no await or spawn before this call.
      let written = 0;
      while (written < buffer.length) {
        const count = fs.writeSync(fd, buffer, written, buffer.length - written);
        if (!count) throw Object.assign(new Error('File write made no progress'), { code: 'EIO' });
        written += count;
      }
      fs.fchmodSync(fd, before ? Number(before.stat.mode & 0o777n) : 0o644);
      fs.fsyncSync(fd);
      verify();
      if (before) syscall(libc.renameat(parent, ptr(temp), parent, ptr(target)));
      else syscall(libc.linkat(parent, ptr(temp), parent, ptr(target), 0));
      published = true;
      if (before) created = false;
      else { syscall(libc.unlinkat(parent, ptr(temp), 0)); created = false; }
      fs.fsyncSync(parent);
      return { dev: String(fs.fstatSync(fd, { bigint: true }).dev), ino: String(fs.fstatSync(fd, { bigint: true }).ino) };
    } catch (error) {
      if (published) fail('UNKNOWN', 'File was published but durable completion could not be confirmed');
      throw error;
    } finally {
      if (fd !== undefined) this.release(fd);
      if (created) {
        try { syscall(libc.unlinkat(parent, ptr(temp), 0)); }
        catch (error) { if (error.code !== 'ENOENT') fail('UNKNOWN', 'Temporary write cleanup could not be confirmed'); }
      }
    }
  }
  /** /proc path contains only our still-open FD, never caller path components. No fallback. */
  entries(directory, visit) {
    check(process.platform === 'linux', 'UNSUPPORTED', 'Descriptor directory scanning requires Linux');
    const dir = fs.opendirSync(`/proc/self/fd/${directory}`);
    try { for (let entry; (entry = dir.readSync());) visit(entry); }
    finally { dir.closeSync(); }
  }
}
