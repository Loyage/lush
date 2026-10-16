import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { posixFiles } from './workspaces/code-posix.js';

export const BUNDLE_LIMITS = Object.freeze({ files: 64, source_file: 1024 * 1024, runner: 16 * 1024 * 1024, runtime: 256 * 1024 * 1024 });
export const SOURCE_FILES = Object.freeze([
  'bin/lush-runner', 'src/core/types.js',
  ...['code', 'code-io', 'code-model', 'code-posix'].map(name => `src/core/workspaces/${name}.js`),
  ...['artifact-transfer', 'cgroup', 'client', 'code-reader', 'command-bootstrap', 'command-child', 'command-guard',
    'command-resources', 'command-state', 'commands', 'config', 'files', 'files-context', 'files-posix', 'index',
    'init-lock', 'node', 'protocol', 'server', 'store', 'transport'].map(name => `src/runner/${name}.js`),
]);
const allowed = new Set(SOURCE_FILES);
const builtins = new Set(['node:fs', 'node:path', 'node:os', 'node:crypto', 'node:child_process', 'node:url', 'node:readline', 'bun:ffi', 'bun:sqlite']);
export const signature = stat => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
export const digest = data => createHash('sha256').update(data).digest('hex');
export const fdPath = fd => `/proc/self/fd/${fd}`;
export const failure = (code = 'INVALID_ARTIFACT') => Object.assign(new Error(code === 'UNSUPPORTED'
  ? 'Runner deployment artifacts are unsupported on this runtime or ABI'
  : 'Runner deployment artifacts could not be safely fixed; no artifact was published'), { code });
export function requireArtifact(condition, code) { if (!condition) throw failure(code); }
export function safeRelative(file) {
  requireArtifact(typeof file === 'string' && /^[A-Za-z0-9_./-]+$/.test(file) && Buffer.byteLength(file) <= 100
    && !file.startsWith('/') && file.split('/').every(part => part && part !== '.' && part !== '..'));
  return file;
}
export function openRelative(root, file) {
  const parts = safeRelative(file).split('/'); let parent = root, owned = false;
  try {
    for (const part of parts.slice(0, -1)) {
      const next = posixFiles.openAt(parent, part, true);
      if (owned) fs.closeSync(parent); parent = next; owned = true;
    }
    return posixFiles.openAt(parent, parts.at(-1));
  } finally { if (owned) fs.closeSync(parent); }
}
export function regular(stat, limit) {
  requireArtifact(stat.isFile() && stat.nlink === 1n && stat.size >= 0n && stat.size <= BigInt(limit));
}
export function readSource(root, file) {
  const fd = openRelative(root, file);
  try {
    const before = fs.fstatSync(fd, { bigint: true }); regular(before, BUNDLE_LIMITS.source_file);
    const data = Buffer.alloc(Number(before.size) + 1); let length = 0, size;
    while (length < data.length && (size = fs.readSync(fd, data, length, data.length - length, null))) length += size;
    requireArtifact(length === Number(before.size) && signature(before) === signature(fs.fstatSync(fd, { bigint: true })));
    return { file, data: data.subarray(0, length), signature: signature(before) };
  } finally { fs.closeSync(fd); }
}
export function collectSources(root) {
  const queue = ['bin/lush-runner', 'src/runner/command-guard.js', 'src/runner/command-child.js'], snapshots = new Map();
  const parser = new Bun.Transpiler({ loader: 'js', target: 'bun' });
  while (queue.length) {
    const file = queue.shift(); if (snapshots.has(file)) continue;
    requireArtifact(allowed.has(file) && snapshots.size < BUNDLE_LIMITS.files, 'UNSUPPORTED');
    const snapshot = readSource(root, file), text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.data);
    const scanned = parser.scan(text);
    // No computed imports/requires or unregistered nonliteral child paths can silently escape this audited graph.
    requireArtifact(!/\b(?:import|require)\s*\(/.test(text), 'UNSUPPORTED');
    const urls = [...text.matchAll(/new\s+URL\s*\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g)];
    requireArtifact(urls.length === [...text.matchAll(/new\s+URL\s*\(/g)].length, 'UNSUPPORTED');
    const dependencies = [...scanned.imports.map(row => row.path), ...urls.map(row => row[2])];
    for (const dependency of dependencies) {
      if (builtins.has(dependency)) continue;
      requireArtifact(dependency.startsWith('./') || dependency.startsWith('../'), 'UNSUPPORTED');
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), dependency));
      requireArtifact(allowed.has(resolved), 'UNSUPPORTED'); queue.push(resolved);
    }
    snapshots.set(file, snapshot);
  }
  requireArtifact(snapshots.size === allowed.size, 'UNSUPPORTED');
  return [...snapshots.values()].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}
export function tarSources(sources) {
  const chunks = []; let size = 1024;
  const octal = (header, value, offset, length) => {
    const text = value.toString(8); requireArtifact(text.length < length);
    header.write(text.padStart(length - 1, '0') + '\0', offset, length, 'ascii');
  };
  for (const { file, data } of sources) {
    safeRelative(file);
    const padding = (512 - data.length % 512) % 512;
    size += 512 + data.length + padding; requireArtifact(size <= BUNDLE_LIMITS.runner);
    const header = Buffer.alloc(512); header.write(file, 0, 100, 'ascii');
    octal(header, file === 'bin/lush-runner' ? 0o755 : 0o644, 100, 8);
    octal(header, 0, 108, 8); octal(header, 0, 116, 8); octal(header, data.length, 124, 12); octal(header, 0, 136, 12);
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    chunks.push(header, data, Buffer.alloc(padding));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)], size);
}
export function runningBunHash() {
  // The kernel-provided executable link is the sole intentional symlink read; no caller can choose it.
  const fd = fs.openSync('/proc/self/exe', fs.constants.O_RDONLY), hash = createHash('sha256');
  try {
    const before = fs.fstatSync(fd, { bigint: true }); regular(before, BUNDLE_LIMITS.runtime);
    const buffer = Buffer.alloc(1024 * 1024); let count, size = 0;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) { size += count; requireArtifact(size <= BUNDLE_LIMITS.runtime); hash.update(buffer.subarray(0, count)); }
    requireArtifact(size === Number(before.size) && signature(before) === signature(fs.fstatSync(fd, { bigint: true })));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
export function elfLayout(fd, length) {
  const read = (size, position) => {
    requireArtifact(Number.isSafeInteger(size) && size >= 0 && Number.isSafeInteger(position) && position >= 0
      && Number.isSafeInteger(position + size) && position + size <= length);
    const buffer = Buffer.alloc(size); requireArtifact(fs.readSync(fd, buffer, 0, size, position) === size); return buffer;
  };
  const header = read(64, 0), machines = { x64: 62, arm64: 183 };
  requireArtifact(header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && header[4] === 2 && header[5] === 1
    && header[6] === 1 && [0, 3].includes(header[7]) && [2, 3].includes(header.readUInt16LE(16))
    && header.readUInt16LE(18) === machines[process.arch] && header.readUInt32LE(20) === 1, 'UNSUPPORTED');
  const offset = Number(header.readBigUInt64LE(32)), stride = header.readUInt16LE(54), count = header.readUInt16LE(56);
  requireArtifact(stride === 56 && count > 0 && count <= 128, 'UNSUPPORTED');
  return { read, programs: Array.from({ length: count }, (_, i) => read(stride, offset + i * stride)) };
}
export function elfAbi(fd, length) {
  const { read, programs } = elfLayout(fd, length);
  let interpreter;
  for (const program of programs) {
    if (program.readUInt32LE(0) !== 3) continue;
    requireArtifact(!interpreter, 'UNSUPPORTED');
    const start = Number(program.readBigUInt64LE(8)), size = Number(program.readBigUInt64LE(32));
    requireArtifact(size > 1 && size <= 4096, 'UNSUPPORTED');
    const value = read(size, start); requireArtifact(value.at(-1) === 0, 'UNSUPPORTED');
    interpreter = value.subarray(0, -1).toString('utf8');
  }
  const glibc = process.report?.getReport?.().header.glibcVersionRuntime;
  requireArtifact(typeof interpreter === 'string' && /^\/[A-Za-z0-9_./+-]+$/.test(interpreter)
    && /\/ld-linux-(?:x86-64|aarch64)\.so\.[0-9]+$/.test(interpreter) && /^\d+\.\d+$/.test(glibc ?? ''), 'UNSUPPORTED');
  return { format: 'elf64-le', machine: process.arch === 'x64' ? 'x86_64' : 'aarch64', interpreter, libc: 'glibc', libc_version: glibc };
}
