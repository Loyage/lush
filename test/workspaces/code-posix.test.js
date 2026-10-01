import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dlopen, ptr } from 'bun:ffi';
import { createPosixFiles, posixFiles } from '../../src/core/workspaces/code-posix.js';
import { readWorkspace } from '../../src/core/workspaces/code-io.js';
import { temp } from '../helpers.js';

const libcName = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';

test('POSIX openat reads regular files, rejects link traversal and readlinkat returns only link text', () => {
  const root = temp(), api = createPosixFiles(); let parent, file;
  try {
    fs.writeFileSync(path.join(root, 'file'), 'hello'); fs.symlinkSync('/etc/passwd', path.join(root, 'link'));
    parent = api.openDirectory(root); file = api.openAt(parent, 'file');
    expect(fs.fstatSync(file).isFile()).toBe(true); const bytes = Buffer.alloc(5); fs.readSync(file, bytes, 0, 5, 0); expect(bytes.toString()).toBe('hello');
    expect(() => api.openAt(parent, 'link')).toThrow('ELOOP'); expect(api.readLinkAt(parent, 'link')).toBe('/etc/passwd');
    expect(() => api.openAt(parent, '..')).toThrow('EINVAL'); expect(() => api.openAt(parent, 'a/b')).toThrow('EINVAL');
    expect(() => api.openAt(parent, 'missing')).toThrow('ENOENT');
  } finally { if (file !== undefined) fs.closeSync(file); if (parent !== undefined) fs.closeSync(parent); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Darwin loader uses libSystem/__error and unavailable libc never falls back to path reads', () => {
  const attempted = [], errno = new Int32Array([os.constants.errno.EACCES]);
  const api = createPosixFiles({ platform: 'darwin', load(name, symbols) {
    attempted.push(name); expect(symbols.__error).toBeDefined(); expect(symbols.__errno_location).toBeUndefined();
    expect(Object.keys(symbols).sort()).toEqual(['__error', 'fcntl', 'openat', 'readlinkat']);
    return { symbols: { openat: () => -1, __error: () => ptr(errno) } };
  } });
  expect(() => api.openAt(123, 'file')).toThrow('EACCES'); expect(attempted).toEqual(['libSystem.B.dylib']);
  const missing = createPosixFiles({ platform: 'darwin', load() { throw new Error('missing'); } });
  expect(() => missing.openAt(123, 'file')).toThrow('ENOSYS');
  expect(() => createPosixFiles({ platform: 'win32' }).openAt(123, 'file')).toThrow('ENOSYS');
});

test('failed close-on-exec setup closes the newly opened FD and preserves original errno', () => {
  const root = temp(), fd = fs.openSync(path.join(root, 'file'), 'w+'), errno = new Int32Array([os.constants.errno.EIO]);
  try {
    const api = createPosixFiles({ platform: 'linux', load() { return { symbols: {
      openat: () => fd, fcntl: () => -1, __errno_location: () => ptr(errno),
    } }; } });
    expect(() => api.openAt(123, 'file')).toThrow('EIO');
    expect(() => fs.fstatSync(fd)).toThrow('EBADF');
  } finally { try { fs.closeSync(fd); } catch {} fs.rmSync(root, { recursive: true, force: true }); }
});

test('directory traversal failure closes every opened directory descriptor', () => {
  const root = temp(), opened = []; let handle;
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    const api = createPosixFiles({ load(name, definitions) {
      handle = dlopen(name, definitions); const native = handle.symbols.openat;
      return { ...handle, symbols: { ...handle.symbols, openat(...args) { const fd = native(...args); if (fd >= 0) opened.push(fd); return fd; } } };
    } });
    for (let i = 0; i < 5; i++) expect(() => api.openDirectory(path.join(root, 'nested', 'missing'))).toThrow('ENOENT');
    expect(opened.length).toBeGreaterThan(5);
    for (const fd of new Set(opened)) expect(() => fs.fstatSync(fd)).toThrow('EBADF');
  } finally { handle?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('opened FDs have FD_CLOEXEC set', () => {
  const root = temp(), api = createPosixFiles(); let parent, file, probe;
  try {
    fs.writeFileSync(path.join(root, 'file'), 'hello'); parent = api.openDirectory(root); file = api.openAt(parent, 'file');
    probe = dlopen(libcName, { fcntl: { args: ['i32', 'i32', 'i32'], returns: 'i32' } });
    // F_GETFD=1, FD_CLOEXEC=1 on the supported POSIX platforms.
    expect(probe.symbols.fcntl(parent, 1, 0) & 1).toBe(1); expect(probe.symbols.fcntl(file, 1, 0) & 1).toBe(1);
  } finally { if (file !== undefined) fs.closeSync(file); if (parent !== undefined) fs.closeSync(parent); probe?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('ancestor swaps cannot redirect descriptor-relative content reads outside the root', () => {
  const root = temp(), outside = temp(), open = posixFiles.openAt;
  try {
    fs.writeFileSync(path.join(outside, 'file'), 'SECRET');
    for (const when of ['before', 'after']) {
      fs.rmSync(path.join(root, 'dir'), { recursive: true, force: true });
      fs.rmSync(path.join(root, 'moved'), { recursive: true, force: true });
      fs.mkdirSync(path.join(root, 'dir')); fs.writeFileSync(path.join(root, 'dir', 'file'), 'safe');
      let swapped = false;
      const swap = () => { swapped = true; fs.renameSync(path.join(root, 'dir'), path.join(root, 'moved')); fs.symlinkSync(outside, path.join(root, 'dir')); };
      posixFiles.openAt = (parent, name, directory) => {
        if (name !== 'dir' || swapped) return open(parent, name, directory);
        if (when === 'before') swap();
        const fd = open(parent, name, directory); if (when === 'after') swap(); return fd;
      };
      let value;
      try { value = readWorkspace(root, 'dir/file'); } catch (error) { expect(error.message).toContain('符号链接'); }
      if (value?.exists) expect(value.buffer.toString()).toBe('safe');
      expect(value?.buffer?.toString()).not.toBe('SECRET'); expect(swapped).toBe(true);
    }
  } finally { posixFiles.openAt = open; fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});
