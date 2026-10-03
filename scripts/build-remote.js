import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { BUN_VERSION, TARGETS, SOURCE_DIRS, SOURCE_FILES, safePath, sourceName, runtimeSourceIdentity, inspectRuntimeBinary, validateRemoteManifest, verifyPayloadDirectory } from '../src/ui/desktop/remote-artifact.js';
export { BUN_VERSION, TARGETS, runtimeSourceIdentity, inspectRuntimeBinary, validateRemoteManifest };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUILD_DIR = 'node_modules/lush-remote-build/payload';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);

export function nativeTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!TARGETS.includes(target)) fail('Remote payload builds require native Linux x64 or ARM64');
  return target;
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

/** Read source identity without executing source or a runtime; also used by desktop packaging. */
export function remoteSourceIdentity(root = ROOT) {
  const files = collectRuntimeSources(safePath(root, 'directory'));
  return runtimeSourceIdentity(files);
}

function command(file, args, options = {}, run = spawnSync) {
  const result = run(file, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, ...options });
  if (result.error) fail(`${path.basename(file)} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${path.basename(file)} failed (${result.status ?? result.signal}): ${(result.stderr || '').slice(-2000)}`);
  return result.stdout.trim();
}

/** Verify every declared target without executing or extracting foreign architecture binaries. */
export function verifyRemotePayload(directory, { requireTargets = [], smoke = false, run = spawnSync } = {}) {
  directory = safePath(directory, 'directory');
  const manifest = verifyPayloadDirectory(directory, { requireTargets });
  for (const target of Object.keys(manifest.targets)) {
    const archive = safePath(path.join(directory, manifest.targets[target].file), 'file');
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
  const identity = runtimeSourceIdentity(files).fingerprint, directory = outputPath(root, out);
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
