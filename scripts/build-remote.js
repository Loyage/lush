import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUILD_DIR = 'node_modules/lush-remote-build/payload';
export const BUN_VERSION = '1.4.2';
export const TARGETS = Object.freeze(['linux-x64', 'linux-arm64']);
const SOURCE_DIRS = ['bin', 'src', 'docs'];
const SOURCE_FILES = ['README.md', 'package.json'];
const MAX_ARCHIVE = 256 * 1024 * 1024, MAX_UNPACKED = 512 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys, name) => {
  if (!plain(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) fail(`Invalid ${name} fields`);
};
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);

export function nativeTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!TARGETS.includes(target)) fail('Remote payload builds require native Linux x64 or ARM64');
  return target;
}

function safePath(file, type = null) {
  const absolute = path.resolve(file);
  const parts = absolute.split(path.sep);
  let current = path.parse(absolute).root;
  for (const part of parts.slice(1)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) fail(`Symlinked path is not allowed: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (type && !(type === 'file' ? fs.statSync(absolute).isFile() : fs.statSync(absolute).isDirectory())) fail(`Expected ${type}: ${absolute}`);
  return absolute;
}

function outputPath(root, out) {
  const directory = safePath(out || path.join(root, BUILD_DIR));
  const relative = path.relative(root, directory);
  const withinRoot = relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
  if ((withinRoot ? relative : directory).split(path.sep).includes('.lush') || directory === root || SOURCE_DIRS.some(dir => directory === path.join(root, dir) || directory.startsWith(`${path.join(root, dir)}${path.sep}`))) {
    fail('Output must not overwrite sources or project .lush state');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  return directory;
}

function sourceName(name, directory = false) {
  if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || /[\x00-\x1f\x7f]/.test(name)) return false;
  if (directory) return SOURCE_DIRS.some(dir => name === dir || name.startsWith(`${dir}/`));
  if (SOURCE_FILES.includes(name) || name === 'bun' || name === 'remote.json') return true;
  if (name.startsWith('bin/')) return /^bin\/[a-z0-9-]+$/.test(name);
  if (name.startsWith('docs/')) return name.endsWith('.md');
  return name.startsWith('src/') && /\.(?:js|cjs|html|css|json|md|txt)$/.test(name);
}

export function collectRuntimeSources(root = ROOT) {
  const files = new Map();
  const walk = name => {
    const file = safePath(path.join(root, name));
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      if (!sourceName(name, true)) fail(`Unreviewed source directory: ${name}`);
      for (const entry of fs.readdirSync(file).sort((a, b) => a.localeCompare(b))) walk(`${name}/${entry}`);
    } else {
      if (!stat.isFile() || !sourceName(name) || ['bun', 'remote.json'].includes(name)) fail(`Unreviewed source file: ${name}`);
      if (stat.size > 32 * 1024 * 1024) fail(`Source file is too large: ${name}`);
      files.set(name, fs.readFileSync(file));
    }
  };
  for (const name of [...SOURCE_DIRS, ...SOURCE_FILES]) walk(name);
  for (const name of ['src/identity.js', 'bin/lush', 'bin/lush-host', 'bin/lushd']) if (!files.has(name)) fail(`Missing runtime source: ${name}`);
  if ([...files.values()].reduce((total, bytes) => total + bytes.length, 0) > 64 * 1024 * 1024) fail('Runtime sources are too large');
  return files;
}

// Mirrors src/identity.js without importing or executing the source being packaged.
function fingerprint(files) {
  const hash = createHash('sha256');
  const walk = dir => {
    const names = new Set([...files.keys()].filter(name => name.startsWith(`${dir}/`)).map(name => name.slice(dir.length + 1).split('/')[0]));
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
      const relative = `${dir}/${name}`;
      if (files.has(relative)) hash.update(relative).update(files.get(relative));
      else walk(relative);
    }
  };
  walk('src'); walk('bin'); hash.update(files.get('package.json'));
  return hash.digest('hex').slice(0, 16);
}

/** Read source identity without executing source or a runtime; also used by desktop packaging. */
export function remoteSourceIdentity(root = ROOT) {
  const files = collectRuntimeSources(safePath(root, 'directory'));
  return { lush_version: JSON.parse(files.get('package.json').toString('utf8')).version, fingerprint: fingerprint(files) };
}

/** ELF validation happens before execution. Nix-patched loaders/RPATHs are not portable payloads. */
export function inspectRuntimeBinary(bytes, target) {
  if (!TARGETS.includes(target) || bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1) fail('Expected a Linux little-endian ELF64 Bun binary');
  const machine = bytes.readUInt16LE(18), expected = target === 'linux-x64' ? 62 : 183;
  if (machine !== expected || ![2, 3].includes(bytes.readUInt16LE(16))) fail(`Runtime architecture does not match ${target}`);
  const offset = Number(bytes.readBigUInt64LE(32)), stride = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  if (!Number.isSafeInteger(offset) || stride < 56 || count < 1 || count > 128 || offset + stride * count > bytes.length) fail('Invalid ELF program headers');
  const segments = [];
  let interpreter = null;
  for (let index = 0; index < count; index++) {
    const at = offset + index * stride;
    const segment = { type: bytes.readUInt32LE(at), offset: Number(bytes.readBigUInt64LE(at + 8)), address: Number(bytes.readBigUInt64LE(at + 16)), size: Number(bytes.readBigUInt64LE(at + 32)) };
    if (![segment.offset, segment.address, segment.size].every(Number.isSafeInteger) || segment.offset < 0 || segment.offset + segment.size > bytes.length) fail('Invalid ELF segment');
    segments.push(segment);
    if (segment.type === 3) {
      if (interpreter !== null || segment.size < 2 || segment.size > 256 || bytes[segment.offset + segment.size - 1] !== 0) fail('Invalid ELF interpreter');
      interpreter = bytes.subarray(segment.offset, segment.offset + segment.size - 1).toString('utf8');
    }
  }
  const expectedLoader = target === 'linux-x64' ? '/lib64/ld-linux-x86-64.so.2' : '/lib/ld-linux-aarch64.so.1';
  if (interpreter !== null && interpreter !== expectedLoader) fail(`Non-portable runtime interpreter: ${interpreter}`);
  // Private dependencies and machine-specific search paths are not part of this runtime bundle.
  const needed = [];
  let stringAddress = null;
  for (const segment of segments.filter(entry => entry.type === 2)) {
    if (segment.size % 16) fail('Invalid ELF dynamic table');
    for (let at = segment.offset; at < segment.offset + segment.size; at += 16) {
      const tag = bytes.readBigInt64LE(at), value = Number(bytes.readBigUInt64LE(at + 8));
      if (tag === 0n) break;
      if (!Number.isSafeInteger(value)) fail('Invalid ELF dynamic value');
      if (tag === 15n || tag === 29n) fail('Non-portable runtime RPATH/RUNPATH');
      if (tag === 1n) needed.push(value);
      if (tag === 5n) stringAddress = value;
    }
  }
  const standard = new Set(['libc.so.6', 'libpthread.so.0', 'libdl.so.2', 'libm.so.6', 'librt.so.1', 'libgcc_s.so.1', 'libstdc++.so.6', path.posix.basename(expectedLoader)]);
  const dependencies = [];
  if (needed.length) {
    const segment = segments.find(entry => entry.type === 1 && stringAddress !== null && stringAddress >= entry.address && stringAddress < entry.address + entry.size);
    if (!segment) fail('Invalid ELF dependency string table');
    const base = segment.offset + stringAddress - segment.address;
    for (const index of needed) {
      const start = base + index, end = bytes.indexOf(0, start);
      if (start >= segment.offset + segment.size || end < start || end >= segment.offset + segment.size || end - start > 256) fail('Invalid ELF dependency name');
      const name = bytes.subarray(start, end).toString('utf8');
      if (!standard.has(name)) fail(`Non-portable runtime dependency: ${name}`);
      dependencies.push(name);
    }
  }
  return { target, interpreter, dependencies };
}

function command(file, args, options = {}, run = spawnSync) {
  const result = run(file, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, ...options });
  if (result.error) fail(`${path.basename(file)} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${path.basename(file)} failed (${result.status ?? result.signal}): ${(result.stderr || '').slice(-2000)}`);
  return result.stdout.trim();
}

function parseManifest(directory) {
  const file = safePath(path.join(directory, 'manifest.json'), 'file');
  if (fs.statSync(file).size > 16384) fail('Manifest is too large');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  exact(manifest, ['version', 'lush_version', 'fingerprint', 'targets'], 'manifest');
  if (manifest.version !== 1 || !version(manifest.lush_version) || !hex(manifest.fingerprint, 16) || !plain(manifest.targets) || !Object.keys(manifest.targets).length) fail('Invalid manifest identity');
  for (const [target, entry] of Object.entries(manifest.targets)) {
    exact(entry, ['file', 'sha256', 'bun_version', 'bun_sha256'], 'target');
    if (!TARGETS.includes(target) || entry.file !== `lush-remote-${target}.tar.gz` || !hex(entry.sha256, 64) || !hex(entry.bun_sha256, 64) || entry.bun_version !== BUN_VERSION) fail('Invalid manifest target');
  }
  return manifest;
}

function tarNumber(header, start, length) {
  const text = header.subarray(start, start + length).toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(text)) fail('Invalid tar numeric field');
  const value = parseInt(text, 8);
  if (!Number.isSafeInteger(value)) fail('Tar numeric field is too large');
  return value;
}

// Validate before extraction: no links, special files, PAX overrides, traversal or duplicate entries.
function archiveFiles(archive) {
  const compressed = fs.readFileSync(archive);
  if (compressed.length > MAX_ARCHIVE) fail('Archive is too large');
  const bytes = gunzipSync(compressed, { maxOutputLength: MAX_UNPACKED });
  const files = new Map(), seen = new Map();
  let offset = 0, ended = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      if (bytes.length - offset < 512 || !bytes.subarray(offset).every(byte => byte === 0)) fail('Invalid tar trailer');
      ended = true; break;
    }
    const string = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
    if (string(257, 6) !== 'ustar') fail('Only ustar archives are accepted');
    const checksum = tarNumber(header, 148, 8);
    let sum = 0;
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index];
    if (sum !== checksum) fail('Invalid tar header checksum');
    const type = String.fromCharCode(header[156]), directory = type === '5';
    if (!directory && type !== '0' && type !== '\0') fail('Archive links or special entries are not allowed');
    const prefix = string(345, 155), raw = `${prefix ? `${prefix}/` : ''}${string(0, 100)}`;
    const name = directory ? raw.replace(/\/$/, '') : raw;
    if (!sourceName(name, directory) || seen.has(name)) fail(`Unsafe or duplicate archive entry: ${name}`);
    for (const [parent, isDirectory] of seen) if ((!isDirectory && name.startsWith(`${parent}/`)) || (!directory && parent.startsWith(`${name}/`))) fail('Archive file/directory collision');
    seen.set(name, directory);
    const size = tarNumber(header, 124, 12), mode = tarNumber(header, 100, 8);
    if ((mode & 0o7022) !== 0 || (directory && size !== 0) || offset + size > bytes.length || (!directory && (name === 'bun' || name.startsWith('bin/')) && !(mode & 0o100))) fail('Unsafe archive mode or size');
    if (!directory) files.set(name, bytes.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended) fail('Truncated archive');
  for (const name of [...SOURCE_FILES, 'bun', 'remote.json', 'src/identity.js', 'bin/lush', 'bin/lush-host', 'bin/lushd']) if (!files.has(name)) fail(`Missing archive entry: ${name}`);
  for (const name of SOURCE_DIRS) if (!seen.get(name)) fail(`Missing archive directory: ${name}`);
  return files;
}

function verifyArchive(directory, manifest, target) {
  const entry = manifest.targets[target], archive = safePath(path.join(directory, entry.file), 'file');
  if (fs.statSync(archive).size > MAX_ARCHIVE || sha256(fs.readFileSync(archive)) !== entry.sha256) fail(`Archive checksum mismatch: ${target}`);
  const files = archiveFiles(archive);
  if (files.get('remote.json').length > 16384 || files.get('package.json').length > 1024 * 1024) fail('Archive metadata is too large');
  const metadata = JSON.parse(files.get('remote.json').toString('utf8'));
  exact(metadata, ['version', 'target', 'lush_version', 'fingerprint', 'bun_version', 'bun_sha256'], 'remote metadata');
  const expected = { version: 1, target, lush_version: manifest.lush_version, fingerprint: manifest.fingerprint, bun_version: entry.bun_version, bun_sha256: entry.bun_sha256 };
  for (const [key, value] of Object.entries(expected)) if (metadata[key] !== value) fail(`Remote metadata mismatch: ${key}`);
  if (sha256(files.get('bun')) !== entry.bun_sha256) fail('Bun checksum mismatch');
  inspectRuntimeBinary(files.get('bun'), target);
  if (JSON.parse(files.get('package.json').toString('utf8')).version !== manifest.lush_version || fingerprint(files) !== manifest.fingerprint) fail('Runtime source identity mismatch');
  return archive;
}

/** Verify every declared target without executing or extracting foreign architecture binaries. */
export function verifyRemotePayload(directory, { requireTargets = [], smoke = false, run = spawnSync } = {}) {
  directory = safePath(directory, 'directory');
  const manifest = parseManifest(directory);
  const expectedFiles = new Set(['manifest.json', ...Object.values(manifest.targets).map(entry => entry.file)]);
  if (fs.readdirSync(directory).some(name => !expectedFiles.has(name))) fail('Unexpected file in payload directory');
  for (const target of requireTargets) if (!manifest.targets[target]) fail(`Missing target: ${target}`);
  for (const target of Object.keys(manifest.targets)) {
    const archive = verifyArchive(directory, manifest, target);
    if (smoke && target === nativeTarget()) {
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-remote-smoke-'));
      try {
        command('tar', ['-xzf', archive, '-C', stage, '--no-same-owner', '--no-same-permissions']);
        const bun = path.join(stage, 'bun');
        if (command(bun, ['--version'], {}, run) !== BUN_VERSION) fail('Extracted Bun version mismatch');
        const identity = JSON.parse(command(bun, ['--eval', 'import {codeIdentity} from "./src/identity.js"; console.log(JSON.stringify(codeIdentity()))'], { cwd: stage }, run));
        if (identity.fingerprint !== manifest.fingerprint || identity.version !== manifest.lush_version) fail('Extracted runtime identity mismatch');
        command(bun, ['--eval', 'import "./src/daemon/main.js"; import "./src/ui/web/server.js"; console.log("runtime imports ready")'], { cwd: stage }, run);
        command(bun, ['bin/lush', 'help'], { cwd: stage }, run);
      } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    }
  }
  return manifest;
}

/** Native only. The caller selects a trusted, portable fixed-version Bun, never a downloaded installer script. */
export function buildRemotePayload({ root = ROOT, bun = process.execPath, out, run = spawnSync } = {}) {
  root = safePath(root, 'directory');
  const target = nativeTarget(), files = collectRuntimeSources(root), runtime = safePath(bun, 'file');
  if (fs.statSync(runtime).size > 128 * 1024 * 1024) fail('Runtime binary is too large');
  const binary = fs.readFileSync(runtime);
  inspectRuntimeBinary(binary, target);
  if (command(runtime, ['--version'], {}, run) !== BUN_VERSION) fail(`Bun ${BUN_VERSION} is required`);
  const lush_version = JSON.parse(files.get('package.json').toString('utf8')).version;
  if (!version(lush_version)) fail('Invalid Lush version');
  const identity = fingerprint(files), directory = outputPath(root, out);
  let previous = null;
  if (fs.existsSync(path.join(directory, 'manifest.json'))) {
    previous = verifyRemotePayload(directory);
    if (previous.lush_version !== lush_version || previous.fingerprint !== identity) fail('Output contains a different runtime identity; use a fresh output directory');
  }
  const file = `lush-remote-${target}.tar.gz`;
  safePath(path.join(directory, file)); safePath(path.join(directory, 'manifest.json'));
  const stage = fs.mkdtempSync(path.join(path.dirname(directory), 'remote-stage-'));
  const temp = fs.mkdtempSync(path.join(path.dirname(directory), 'remote-artifact-'));
  try {
    for (const [name, bytes] of files) {
      const destination = path.join(stage, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
      fs.writeFileSync(destination, bytes, { mode: name.startsWith('bin/') ? 0o755 : 0o644 });
    }
    fs.writeFileSync(path.join(stage, 'bun'), binary, { mode: 0o755 });
    const metadata = { version: 1, target, lush_version, fingerprint: identity, bun_version: BUN_VERSION, bun_sha256: sha256(binary) };
    fs.writeFileSync(path.join(stage, 'remote.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 });
    const archive = path.join(temp, file);
    command('tar', ['--format=ustar', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', archive, '-C', stage, ...SOURCE_DIRS, ...SOURCE_FILES, 'bun', 'remote.json'], {}, run);
    const entry = { file, sha256: sha256(fs.readFileSync(archive)), bun_version: BUN_VERSION, bun_sha256: metadata.bun_sha256 };
    const manifest = { version: 1, lush_version, fingerprint: identity, targets: { ...(previous?.targets || {}), [target]: entry } };
    fs.writeFileSync(path.join(temp, 'manifest.json'), `${JSON.stringify({ ...manifest, targets: { [target]: entry } }, null, 2)}\n`);
    verifyRemotePayload(temp);
    fs.renameSync(archive, path.join(directory, file));
    fs.writeFileSync(path.join(temp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(path.join(temp, 'manifest.json'), path.join(directory, 'manifest.json'));
    return { directory, manifest, target, archive: path.join(directory, file) };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); fs.rmSync(temp, { recursive: true, force: true }); }
}

/** Combine only independently verified artifacts with exactly the same source identity. */
export function mergeRemotePayloads(directories, { out = path.join(ROOT, BUILD_DIR), requireTargets = TARGETS } = {}) {
  if (!Array.isArray(directories) || !directories.length) fail('At least one payload directory is required');
  const inputs = directories.map(directory => ({ directory: safePath(directory, 'directory'), manifest: verifyRemotePayload(directory) }));
  const first = inputs[0].manifest, targets = {};
  for (const { manifest } of inputs) {
    if (manifest.lush_version !== first.lush_version || manifest.fingerprint !== first.fingerprint) fail('Cannot merge different runtime identities');
    for (const [target, entry] of Object.entries(manifest.targets)) {
      if (targets[target] && ['file', 'sha256', 'bun_version', 'bun_sha256'].some(key => targets[target][key] !== entry[key])) fail(`Conflicting target: ${target}`);
      targets[target] = entry;
    }
  }
  for (const target of requireTargets) if (!targets[target]) fail(`Missing target: ${target}`);
  const directory = outputPath(ROOT, out), manifest = { ...first, targets };
  // Existing output is either the same verified content or is rejected, never silently overwritten.
  if (fs.existsSync(path.join(directory, 'manifest.json'))) {
    const previous = verifyRemotePayload(directory);
    if (previous.lush_version !== manifest.lush_version || previous.fingerprint !== manifest.fingerprint) fail('Output contains a different runtime identity');
    if (Object.keys(previous.targets).some(target => !targets[target])) fail('Output contains targets absent from merge');
  }
  for (const entry of Object.values(targets)) safePath(path.join(directory, entry.file));
  safePath(path.join(directory, 'manifest.json'));
  const temp = fs.mkdtempSync(path.join(path.dirname(directory), 'remote-merge-'));
  try {
    for (const { directory: input, manifest: source } of inputs) for (const entry of Object.values(source.targets)) fs.copyFileSync(path.join(input, entry.file), path.join(temp, entry.file));
    fs.writeFileSync(path.join(temp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    verifyRemotePayload(temp, { requireTargets });
    for (const entry of Object.values(targets)) fs.renameSync(path.join(temp, entry.file), path.join(directory, entry.file));
    fs.renameSync(path.join(temp, 'manifest.json'), path.join(directory, 'manifest.json'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  return { directory, manifest };
}

function main(args) {
  const mode = args.shift();
  if (mode === '--build') {
    const options = {};
    while (args.length) {
      const key = args.shift();
      if (!['--root', '--bun', '--out'].includes(key) || !args.length) fail('Expected --root, --bun or --out with a path');
      options[key.slice(2)] = args.shift();
    }
    const result = buildRemotePayload(options);
    console.log(`Built ${result.target}: ${result.archive}`); return;
  }
  if (mode === '--verify') {
    const smoke = args.includes('--smoke'), directories = args.filter(arg => arg !== '--smoke');
    if (directories.length > 1 || directories.some(arg => arg.startsWith('--'))) fail('Usage: --verify [directory] [--smoke]');
    const directory = directories[0] || path.join(ROOT, BUILD_DIR);
    const manifest = verifyRemotePayload(directory, { smoke });
    console.log(`Verified ${Object.keys(manifest.targets).join(', ')}; fingerprint ${manifest.fingerprint}`); return;
  }
  if (mode === '--merge') {
    const index = args.indexOf('--out');
    if (index < 0 || index !== args.length - 2 || index === 0) fail('Usage: --merge DIR... --out DIRECTORY');
    const result = mergeRemotePayloads(args.slice(0, index), { out: args[index + 1] });
    console.log(`Merged ${Object.keys(result.manifest.targets).join(', ')}: ${result.directory}`); return;
  }
  fail('Usage: bun scripts/build-remote.js --build [--bun PATH] [--root PATH] [--out DIR] | --verify [DIR] [--smoke] | --merge DIR... --out DIR');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
