import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { posixFiles } from './workspaces/code-posix.js';
import { elfLayout, requireArtifact, signature } from './runner-deployment-package.js';

// Evidence only: these files are neither packaged nor executed. No environment-driven library search.
export const ABI_LIMITS = Object.freeze({ files: 32, candidates: 64, file: 64 * 1024 * 1024, total: 128 * 1024 * 1024,
  maps: 1024 * 1024, strings: 1024 * 1024, dynamic: 64 * 1024 });
const safePath = file => typeof file === 'string' && file.length <= 4096 && /^\/[A-Za-z0-9_./+-]+$/.test(file)
  && path.normalize(file) === file;
const systemPath = file => safePath(file) && ['/lib/', '/lib64/', '/usr/lib/', '/usr/lib64/', '/nix/store/'].some(root => file.startsWith(root));
function sameMapping(stat, mapping) {
  const major = ((stat.dev >> 8n) & 0xfffn) | ((stat.dev >> 32n) & ~0xfffn);
  const minor = (stat.dev & 0xffn) | ((stat.dev >> 12n) & ~0xffn);
  return stat.ino === mapping.ino && major === mapping.major && minor === mapping.minor;
}
function checkFile(stat) {
  requireArtifact(stat.isFile() && stat.nlink === 1n && stat.size > 0n && stat.size <= BigInt(ABI_LIMITS.file)
    && (stat.mode & 0o022n) === 0n && [0n, BigInt(process.getuid())].includes(stat.uid));
}
export function elfDependencies(fd, size) {
  const { read, programs } = elfLayout(fd, size);
  const loads = [], dynamics = [];
  for (const program of programs) {
    const type = program.readUInt32LE(0);
    if (![1, 2].includes(type)) continue;
    const offset = Number(program.readBigUInt64LE(8)), address = Number(program.readBigUInt64LE(16)), length = Number(program.readBigUInt64LE(32));
    requireArtifact([offset, address, length, offset + length, address + length].every(Number.isSafeInteger)
      && offset >= 0 && length >= 0 && offset + length <= size && program.readBigUInt64LE(40) >= BigInt(length));
    (type === 1 ? loads : dynamics).push({ offset, address, length });
  }
  requireArtifact(dynamics.length === 1 && dynamics[0].length > 0 && dynamics[0].length <= ABI_LIMITS.dynamic && dynamics[0].length % 16 === 0);
  const table = read(dynamics[0].length, dynamics[0].offset), values = new Map(), needed = []; let terminated = false;
  for (let at = 0; at < table.length; at += 16) {
    const tag = table.readBigInt64LE(at), value = Number(table.readBigUInt64LE(at + 8));
    if (tag === 0n) { terminated = true; break; }
    if (tag === 1n) { requireArtifact(needed.length < ABI_LIMITS.files); needed.push(value); }
    if ([5n, 10n, 14n].includes(tag)) { requireArtifact(!values.has(tag)); values.set(tag, value); }
    // Auxiliary/filter/audit objects are outside the verified DT_NEEDED closure.
    requireArtifact(![0x7ffffffdn, 0x7fffffffn, 0x6ffffefbn, 0x6ffffefcn].includes(tag));
  }
  const start = values.get(5n), length = values.get(10n);
  requireArtifact(terminated && Number.isSafeInteger(start) && Number.isSafeInteger(length) && length > 0 && length <= ABI_LIMITS.strings);
  const segments = loads.filter(row => start >= row.address && start + length <= row.address + row.length);
  requireArtifact(segments.length === 1);
  const strings = read(length, segments[0].offset + start - segments[0].address);
  const string = offset => {
    requireArtifact(Number.isSafeInteger(offset) && offset >= 0 && offset < strings.length);
    const end = strings.indexOf(0, offset); requireArtifact(end >= offset && end - offset <= 4096);
    const value = strings.subarray(offset, end).toString('utf8');
    requireArtifact(/^[A-Za-z0-9_./+-]+$/.test(value) && !value.split('/').includes('..')
      && (!value.includes('/') || safePath(value))); return value;
  };
  return { needed: [...new Set(needed.map(string))], soname: values.has(14n) ? string(values.get(14n)) : null };
}
export function parseMappedLibraries(text) {
  requireArtifact(typeof text === 'string' && Buffer.byteLength(text) <= ABI_LIMITS.maps);
  const rows = new Map();
  for (const line of text.split('\n')) {
    const match = /^[0-9a-f]+-[0-9a-f]+ ([rwxps-]{4}) [0-9a-f]+ ([0-9a-f]+):([0-9a-f]+) ([0-9]+)\s+(.+)$/.exec(line);
    if (!match || !match[1].includes('x') || !match[5].startsWith('/')) continue;
    const file = match[5];
    if (!/(?:\.so(?:\.|$)|\/ld-linux-)/.test(file)) continue;
    requireArtifact(systemPath(file) && rows.size < ABI_LIMITS.candidates);
    const mapping = { path: file, major: BigInt(`0x${match[2]}`), minor: BigInt(`0x${match[3]}`), ino: BigInt(match[4]) };
    const previous = rows.get(file);
    requireArtifact(!previous || previous.ino === mapping.ino && previous.major === mapping.major && previous.minor === mapping.minor);
    rows.set(file, mapping);
  }
  requireArtifact(rows.size > 0); return [...rows.values()];
}
function readMaps() {
  const fd = fs.openSync('/proc/self/maps', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(ABI_LIMITS.maps + 1); let at = 0, count;
    while (at < buffer.length && (count = fs.readSync(fd, buffer, at, buffer.length - at, null))) at += count;
    requireArtifact(at <= ABI_LIMITS.maps); return parseMappedLibraries(buffer.subarray(0, at).toString('utf8'));
  } finally { fs.closeSync(fd); }
}
function openCanonical(file) {
  const directory = posixFiles.openDirectory(path.dirname(file));
  try { return posixFiles.openAt(directory, path.basename(file)); } finally { fs.closeSync(directory); }
}
export function fingerprintMappedFile(logical, mapping) {
  // Symlinks are permitted only as explicit logical -> canonical aliases of the actual mapped inode.
  requireArtifact(safePath(logical));
  const real = fs.realpathSync(logical); requireArtifact(safePath(real));
  const fd = openCanonical(real);
  try {
    const before = fs.fstatSync(fd, { bigint: true }); checkFile(before); requireArtifact(sameMapping(before, mapping));
    const elf = elfDependencies(fd, Number(before.size)), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let size = 0, count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) { size += count; requireArtifact(size <= Number(before.size)); hash.update(buffer.subarray(0, count)); }
    requireArtifact(size === Number(before.size) && signature(before) === signature(fs.fstatSync(fd, { bigint: true })) && fs.realpathSync(logical) === real);
    const snapshot = { path: logical, realpath: real, sha256: hash.digest('hex'), size, signature: signature(before), elf, mapping };
    verifySnapshot(snapshot); return snapshot;
  } finally { fs.closeSync(fd); }
}
function verifySnapshot(snapshot) {
  requireArtifact(fs.realpathSync(snapshot.path) === snapshot.realpath);
  const fd = openCanonical(snapshot.realpath);
  try { requireArtifact(signature(fs.fstatSync(fd, { bigint: true })) === snapshot.signature); } finally { fs.closeSync(fd); }
}
export function collectAbiEvidence(runtime, size, abi) {
  try {
    const main = elfDependencies(runtime, size), mappings = readMaps(), snapshots = [];
    let total = 0;
    for (const mapping of mappings) {
      const real = fs.realpathSync(mapping.path); requireArtifact(systemPath(real));
      const stat = fs.statSync(real, { bigint: true }); checkFile(stat);
      total += Number(stat.size); requireArtifact(total <= ABI_LIMITS.total);
      snapshots.push(fingerprintMappedFile(mapping.path, mapping));
    }
    requireArtifact(systemPath(abi.interpreter));
    const interpreter = fs.realpathSync(abi.interpreter); requireArtifact(systemPath(interpreter));
    const loaders = snapshots.filter(row => row.realpath === interpreter); requireArtifact(loaders.length === 1);
    const queue = [...main.needed], selected = new Set([loaders[0]]), aliases = new Map([[loaders[0], new Set([abi.interpreter])]]), neededAs = new Map();
    queue.push(...loaders[0].elf.needed);
    while (queue.length) {
      const needed = queue.shift();
      if (needed.startsWith('/')) requireArtifact(systemPath(needed));
      const real = needed.startsWith('/') ? fs.realpathSync(needed) : null;
      const candidates = snapshots.filter(row => real ? row.realpath === real : row.elf.soname === needed || !row.elf.soname && path.basename(row.path) === needed);
      requireArtifact(candidates.length === 1);
      const snapshot = candidates[0];
      if (!neededAs.has(snapshot)) neededAs.set(snapshot, new Set()); neededAs.get(snapshot).add(needed);
      if (!aliases.has(snapshot)) aliases.set(snapshot, new Set([snapshot.path]));
      if (real) aliases.get(snapshot).add(needed);
      if (selected.has(snapshot)) continue;
      selected.add(snapshot); requireArtifact(selected.size <= ABI_LIMITS.files); queue.push(...snapshot.elf.needed);
    }
    const after = readMaps(), files = [];
    for (const snapshot of selected) {
      verifySnapshot(snapshot);
      requireArtifact(after.some(row => row.path === snapshot.mapping.path && row.ino === snapshot.mapping.ino && row.major === snapshot.mapping.major && row.minor === snapshot.mapping.minor));
      for (const logical of aliases.get(snapshot)) {
        requireArtifact(files.length < ABI_LIMITS.files && fs.realpathSync(logical) === snapshot.realpath);
        files.push({ path: logical, realpath: snapshot.realpath, sha256: snapshot.sha256, size: snapshot.size, needed_as: [...(neededAs.get(snapshot) ?? [])].sort() });
      }
    }
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { supported: true, reason: null, proof: 'elf-dt-needed+proc-self-maps', probe_required: true, files };
  } catch {
    return { supported: false, reason: 'abi_evidence_unavailable', proof: 'elf-dt-needed+proc-self-maps', probe_required: true, files: [] };
  }
}
