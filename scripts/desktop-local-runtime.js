import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { BUN_VERSION, collectRuntimeSources, remoteSourceIdentity } from './build-remote.js';

export const LOCAL_RUNTIME_DIR = 'node_modules/lush-desktop-build/local-runtime';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (value, message) => { if (!value) throw new Error(message); };

/** Thin native Mach-O only. No Nix/private dylibs or machine-specific RPATHs. */
export function inspectMacRuntime(bytes, arch) {
  check(['x64', 'arm64'].includes(arch) && bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf, 'Expected a native macOS Mach-O64 Bun');
  check(bytes.readUInt32LE(4) === (arch === 'arm64' ? 0x100000c : 0x1000007) && bytes.readUInt32LE(12) === 2, 'macOS Bun architecture or executable type mismatch');
  const count = bytes.readUInt32LE(16), size = bytes.readUInt32LE(20);
  check(count > 0 && count <= 1024 && size <= bytes.length - 32, 'Invalid Mach-O load commands');
  let offset = 32;
  const dependencies = [];
  for (let i = 0; i < count; i++) {
    check(offset + 8 <= 32 + size, 'Truncated Mach-O command');
    const command = bytes.readUInt32LE(offset), length = bytes.readUInt32LE(offset + 4);
    check(length >= 8 && length % 8 === 0 && offset + length <= 32 + size, 'Invalid Mach-O command size');
    check(command !== 0x8000001c, 'Non-portable macOS runtime RPATH');
    if ([0xc, 0x80000018, 0x8000001f, 0x80000023, 0x20, 0xe].includes(command)) {
      check(length >= (command === 0xe ? 12 : 24), 'Invalid Mach-O dependency');
      const start = bytes.readUInt32LE(offset + 8), end = bytes.indexOf(0, offset + start);
      check(start >= (command === 0xe ? 12 : 24) && start < length && end >= offset + start && end < offset + length, 'Invalid Mach-O dependency name');
      const name = bytes.subarray(offset + start, end).toString('utf8');
      check(path.posix.normalize(name) === name && !/[\x00-\x1f\x7f]/.test(name)
        && (command === 0xe ? name === '/usr/lib/dyld' : name.startsWith('/usr/lib/') || name.startsWith('/System/Library/')), `Non-portable macOS dependency: ${name}`);
      dependencies.push(name);
    }
    offset += length;
  }
  check(offset === 32 + size, 'Unexpected Mach-O command bytes');
  return { arch, dependencies };
}

function safeDirectory(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try { check(!fs.lstatSync(current).isSymbolicLink(), `Local runtime path must not be a symlink: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return absolute;
}
function runBun(bun, args, options = {}, run = spawnSync) {
  const result = run(bun, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, ...options });
  check(!result.error && result.status === 0, `Private macOS Bun failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout.trim();
}
function readFiles(directory) {
  const files = new Map();
  const walk = name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    check(!stat.isSymbolicLink(), `Local runtime symlink: ${name}`);
    if (stat.isDirectory()) {
      check(['src', 'bin', 'docs'].some(dir => name === dir || name.startsWith(`${dir}/`)), `Unexpected local runtime directory: ${name}`);
      for (const child of fs.readdirSync(file)) walk(`${name}/${child}`);
    } else {
      check(stat.isFile() && stat.size <= 128 * 1024 * 1024, `Unsafe local runtime file: ${name}`);
      files.set(name, fs.readFileSync(file));
    }
  };
  for (const name of fs.readdirSync(directory)) walk(name);
  return files;
}

/** Validate against the checkout as well as metadata; never execute a foreign runtime. */
export function verifyDesktopLocalRuntime(root, directory, { arch = process.arch, stagedDir, smoke = false, run = spawnSync } = {}) {
  directory = safeDirectory(directory);
  const files = readFiles(directory), sources = collectRuntimeSources(root);
  const metadataBytes = files.get('runtime.json');
  check(metadataBytes && metadataBytes.length <= 1024 * 1024, 'Missing local runtime metadata');
  const metadata = JSON.parse(metadataBytes.toString());
  const identity = remoteSourceIdentity(root);
  check(metadata.version === 1 && metadata.target === `darwin-${arch}` && metadata.bun_version === BUN_VERSION
    && metadata.lush_version === identity.lush_version && metadata.fingerprint === identity.fingerprint, 'Local runtime source identity mismatch');
  const expected = new Set([...sources.keys(), 'bun', 'runtime.json']);
  check(files.size === expected.size && [...files.keys()].every(name => expected.has(name)), 'Unexpected local runtime files');
  check(metadata.files && Object.keys(metadata.files).length === expected.size - 1, 'Invalid local runtime file manifest');
  for (const [name, bytes] of files) {
    if (name === 'runtime.json') continue;
    check(metadata.files[name] === digest(bytes), `Local runtime checksum mismatch: ${name}`);
    if (sources.has(name)) check(bytes.equals(sources.get(name)), `Local runtime source differs from checkout: ${name}`);
    if (stagedDir) check(bytes.equals(fs.readFileSync(path.join(safeDirectory(stagedDir), name))), `Packaged local runtime differs from staged bytes: ${name}`);
  }
  if (stagedDir) check(metadataBytes.equals(fs.readFileSync(path.join(safeDirectory(stagedDir), 'runtime.json'))), 'Packaged local runtime metadata differs from staged bytes');
  inspectMacRuntime(files.get('bun'), arch);
  if (process.platform === 'darwin') {
    for (const name of ['bun', ...sources.keys()].filter(name => name === 'bun' || name.startsWith('bin/'))) {
      check(fs.statSync(path.join(directory, name)).mode & 0o100, `Local runtime is not executable: ${name}`);
    }
  }
  if (smoke) {
    check(process.platform === 'darwin' && process.arch === arch, 'Local runtime smoke requires native macOS');
    const bun = path.join(directory, 'bun');
    check(runBun(bun, ['--version'], {}, run) === BUN_VERSION, 'Private macOS Bun version mismatch');
    const actual = JSON.parse(runBun(bun, ['--eval', 'import {codeIdentity} from "./src/identity.js"; import "./src/daemon/main.js"; import "./src/ui/web/server.js"; console.log(JSON.stringify(codeIdentity()))'], { cwd: directory }, run));
    check(actual.fingerprint === identity.fingerprint && actual.version === identity.lush_version, 'Private macOS runtime smoke identity mismatch');
    runBun(bun, ['bin/lush', 'help'], { cwd: directory }, run);
  }
  return metadata;
}

/** Explicit trusted native runtime input, not an installer/download mechanism. */
export function stageDesktopLocalRuntime(root, { bun = process.execPath, arch = process.arch, run = spawnSync } = {}) {
  check(process.platform === 'darwin' && process.arch === arch, 'Local runtime builds require native macOS x64 or ARM64');
  const runtime = safeDirectory(bun), stat = fs.lstatSync(runtime);
  check(stat.isFile() && stat.size <= 128 * 1024 * 1024, 'Unsafe macOS Bun input');
  const binary = fs.readFileSync(runtime);
  inspectMacRuntime(binary, arch);
  check(runBun(runtime, ['--version'], {}, run) === BUN_VERSION, `Bun ${BUN_VERSION} is required`);
  const directory = safeDirectory(path.join(root, LOCAL_RUNTIME_DIR));
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(directory), 'local-runtime-stage-'));
  try {
    const sources = collectRuntimeSources(root), hashes = {};
    for (const [name, bytes] of [...sources, ['bun', binary]]) {
      const file = path.join(temporary, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes, { mode: name === 'bun' || name.startsWith('bin/') ? 0o755 : 0o644 });
      hashes[name] = digest(bytes);
    }
    const metadata = { version: 1, target: `darwin-${arch}`, ...remoteSourceIdentity(root), bun_version: BUN_VERSION, files: hashes };
    fs.writeFileSync(path.join(temporary, 'runtime.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    verifyDesktopLocalRuntime(root, temporary, { arch, smoke: true, run });
    fs.rmSync(directory, { recursive: true, force: true });
    fs.renameSync(temporary, directory);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  return directory;
}
