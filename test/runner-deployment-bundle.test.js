import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeploymentArtifacts, buildOfficialDeploymentArtifacts } from '../src/core/runner-deployment-bundle.js';
import { deflateRawSync } from 'node:zlib';
import { OFFICIAL_BUN, decodeOfficialZip, downloadOfficialZip, obtainOfficialRuntime } from '../src/core/runner-deployment-official.js';
import { BUNDLE_LIMITS, SOURCE_FILES, digest } from '../src/core/runner-deployment-package.js';
import { ABI_LIMITS, collectAbiEvidence, elfDependencies, fingerprintMappedFile, parseMappedLibraries } from '../src/core/runner-deployment-abi.js';
import { DEPLOYMENT_ACTIONS, publicDeployment, validateDeploymentApproval } from '../src/core/runner-deployment-view.js';
const CODE = fileURLToPath(new URL('../', import.meta.url));
function mappingFor(file) {
  const stat = fs.statSync(file, { bigint: true });
  return { ino: stat.ino, major: ((stat.dev >> 8n) & 0xfffn) | ((stat.dev >> 32n) & ~0xfffn), minor: (stat.dev & 0xffn) | ((stat.dev >> 12n) & ~0xffn) };
}
function elfFixture(needed = ['libc.so.6']) {
  const data = Buffer.alloc(4096), strings = Buffer.from('\0libfixture.so.1\0' + needed.join('\0') + '\0');
  data.set([127, 69, 76, 70, 2, 1, 1]); data.writeUInt16LE(3, 16); data.writeUInt16LE(process.arch === 'x64' ? 62 : 183, 18); data.writeUInt32LE(1, 20);
  data.writeBigUInt64LE(64n, 32); data.writeUInt16LE(64, 52); data.writeUInt16LE(56, 54); data.writeUInt16LE(2, 56);
  data.writeUInt32LE(1, 64); data.writeBigUInt64LE(0x1000n, 80); data.writeBigUInt64LE(BigInt(data.length), 96); data.writeBigUInt64LE(BigInt(data.length), 104);
  data.writeUInt32LE(2, 120); data.writeBigUInt64LE(256n, 128); data.writeBigUInt64LE(0x1100n, 136);
  data.writeBigUInt64LE(BigInt((needed.length + 4) * 16), 152); data.writeBigUInt64LE(BigInt((needed.length + 4) * 16), 160);
  const values = [[5, 0x1400], [10, strings.length], [14, 1]]; let offset = Buffer.byteLength('\0libfixture.so.1\0');
  for (const name of needed) { values.push([1, offset]); offset += Buffer.byteLength(name) + 1; }
  values.push([0, 0]); values.forEach(([tag, value], i) => { data.writeBigUInt64LE(BigInt(tag), 256 + i * 16); data.writeBigUInt64LE(BigInt(value), 264 + i * 16); });
  strings.copy(data, 1024); return data;
}
function officialFixture() {
  const binary = Buffer.from('#!/bin/sh\nthis-is-inert-test-data-not-a-real-Bun\n'), compressed = deflateRawSync(binary);
  const chunks = [], central = []; let offset = 0;
  for (let index = 0; index < 2; index++) {
    const name = Buffer.from(`${OFFICIAL_BUN.asset}/${index ? 'bun' : ''}`), local = Buffer.alloc(30), entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(index ? 8 : 0, 6); local.writeUInt16LE(index ? 8 : 0, 8); local.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(index ? 8 : 0, 8); entry.writeUInt16LE(index ? 8 : 0, 10);
    entry.writeUInt32LE(index ? compressed.length : 0, 20); entry.writeUInt32LE(index ? binary.length : 0, 24); entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(index ? 0x81ed0000 : 0x41ed0000, 38); entry.writeUInt32LE(offset, 42);
    chunks.push(local, name); offset += local.length + name.length;
    if (index) { const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(binary.length, 12); chunks.push(compressed, descriptor); offset += compressed.length + 16; }
    central.push(entry, name);
  }
  const end = Buffer.alloc(22), directory = Buffer.concat(central); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...chunks, directory, end]);
  return { zip, binary, pin: { ...OFFICIAL_BUN, archive_size: zip.length, archive_sha256: digest(zip), size: binary.length, sha256: digest(binary) } };
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-test-deployment-bundle-')), source = path.join(root, 'source'), output = path.join(root, 'output');
  fs.mkdirSync(source); fs.mkdirSync(output);
  for (const file of SOURCE_FILES) { fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true }); fs.copyFileSync(path.join(CODE, file), path.join(source, file)); }
  return { root, source, output, build: options => buildDeploymentArtifacts({ source_root: source, destination: output, ...options }),
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
function entries(file) {
  const tar = fs.readFileSync(file), result = []; let at = 0;
  while (at + 512 <= tar.length && tar[at]) {
    const header = tar.subarray(at, at + 512), name = header.subarray(0, 100).toString().split('\0')[0];
    const size = parseInt(header.subarray(124, 136).toString(), 8), checksum = parseInt(header.subarray(148, 156).toString(), 8);
    const fixed = Buffer.from(header); fixed.fill(32, 148, 156);
    expect(fixed.reduce((sum, byte) => sum + byte, 0)).toBe(checksum);
    expect(header[156]).toBe(48); expect(header.subarray(257, 263).toString()).toBe('ustar\0');
    expect(name).not.toMatch(/(?:^\/|\\|(?:^|\/)\.\.(?:\/|$))/);
    result.push({ name, data: tar.subarray(at + 512, at + 512 + size), mode: parseInt(header.subarray(100, 108).toString(), 8) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  expect(tar.subarray(at).length).toBe(1024); expect(tar.subarray(at).every(byte => byte === 0)).toBe(true);
  return result;
}
const invoke = (argv, options = {}) => {
  const result = Bun.spawnSync(argv, { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', ...options });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};
function assertDeploymentMetadata(artifact) {
  // Contract integration only: artifact construction is not remote readiness or action authorization.
  const plan = { supported: true, blockers: [], runtime: artifact.runtime, runner: artifact.runner,
    files: ['bin/bun', 'config.json', ...artifact.files],
    actions: DEPLOYMENT_ACTIONS.filter(id => !['git_install', 'cgroup_setup'].includes(id)).map(id => ({ id, privileged: false })) };
  expect(() => validateDeploymentApproval(plan, plan.actions.map(action => action.id))).not.toThrow();
  expect(() => validateDeploymentApproval(plan, plan.actions.filter(action => action.id !== 'verify_runner').map(action => action.id))).toThrow();
  const projected = publicDeployment({ plan, private_data: { runtime: artifact.runtime.file, bundle: artifact.runner.file } });
  const { version, source, sha256, size } = artifact.runtime;
  expect(projected.plan.runtime).toEqual({ version, source, sha256, size });
  expect(projected.plan.runner).toEqual({ version: artifact.runner.version, sha256: artifact.runner.sha256, size: artifact.runner.size });
  expect(projected.plan.files).toEqual(plan.files); expect(projected.plan.runtime).not.toHaveProperty('abi');
  expect(projected.plan.runtime).not.toHaveProperty('provenance'); expect(JSON.stringify(projected)).not.toContain(path.dirname(artifact.runner.file));
  expect(artifact.runtime.abi.probe_required).toBe(true);
}
async function rejected(f, options = {}) {
  try { await f.build(options); throw new Error('unexpected success'); }
  catch (error) { expect(['INVALID_ARTIFACT', 'UNSUPPORTED']).toContain(error.code); expect(error.message).not.toContain(f.root); expect(error.message).not.toContain('PRIVATE_SECRET'); }
  expect(fs.readdirSync(f.output).filter(name => name.startsWith('lush-runner-deployment-'))).toEqual([]);
}

test('fixed production closure excludes project/account/environment files and yields private deterministic immutable ustar plus real central Bun bytes', async () => {
  const f = fixture(); let artifact, repeated, syncSpy, outputFlushes = 0;
  try {
    const sync = fs.fsyncSync;
    syncSpy = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(`${f.output}/`)) outputFlushes++;
      return sync(fd);
    });
    for (const file of ['.env', '.lush/accounts.json', 'node_modules/private.js', 'src/core/unrelated.js']) {
      fs.mkdirSync(path.dirname(path.join(f.source, file)), { recursive: true }); fs.writeFileSync(path.join(f.source, file), 'PRIVATE_SECRET');
    }
    let yielded = false; setImmediate(() => { yielded = true; });
    artifact = await f.build(); expect(yielded).toBe(true);
    expect(artifact.runtime).toMatchObject({ source: 'central-bun', version: process.versions.bun, os: 'linux', arch: process.arch });
    expect(artifact.runtime.abi).toMatchObject({ format: 'elf64-le', libc: 'glibc', libc_version: process.report.getReport().header.glibcVersionRuntime });
    expect(artifact.runtime.abi.interpreter).toMatch(/^\/.*\/ld-linux-/);
    const abi = artifact.runtime.abi;
    expect(abi).toMatchObject({ supported: true, reason: null, proof: 'elf-dt-needed+proc-self-maps', probe_required: true });
    expect(abi.files.length).toBeGreaterThan(1); expect(abi.files.length).toBeLessThanOrEqual(ABI_LIMITS.files);
    expect(abi.files.some(file => file.path === abi.interpreter)).toBe(true);
    const covered = new Set(abi.files.flatMap(file => file.needed_as));
    for (const file of [{ realpath: process.execPath }, ...abi.files]) {
      const fd = fs.openSync(file.realpath, fs.constants.O_RDONLY);
      try { for (const needed of elfDependencies(fd, fs.fstatSync(fd).size).needed) expect(covered.has(needed)).toBe(true); }
      finally { fs.closeSync(fd); }
      if (file.sha256) {
        expect(file.realpath).toBe(fs.realpathSync(file.path)); expect(file.size).toBe(fs.statSync(file.realpath).size);
        expect(file.sha256).toBe(digest(fs.readFileSync(file.realpath))); expect(file.path).not.toContain(f.root);
      }
    }
    expect(artifact.runner.version).toBe('1.0.0'); expect(artifact.files).toEqual([...SOURCE_FILES].sort((a, b) => a.localeCompare(b, 'en')));
    expect(artifact.files.length).toBeLessThanOrEqual(BUNDLE_LIMITS.files);
    const rows = entries(artifact.runner.file); expect(rows.map(row => row.name)).toEqual(artifact.files);
    expect(rows.some(row => row.data.includes(Buffer.from('PRIVATE_SECRET')))).toBe(false);
    for (const file of ['src/runner/command-guard.js', 'src/runner/command-child.js', 'src/runner/command-bootstrap.js', 'src/core/workspaces/code-posix.js']) expect(artifact.files).toContain(file);
    expect(rows.find(row => row.name === 'bin/lush-runner').mode).toBe(0o755);
    for (const item of [artifact.runner, artifact.runtime]) {
      expect(item.sha256).toBe(digest(fs.readFileSync(item.file))); expect(item.size).toBe(fs.statSync(item.file).size);
      expect(fs.statSync(item.file).mode & 0o777).toBe(0o600);
    }
    expect(fs.statSync(path.dirname(artifact.runner.file)).mode & 0o777).toBe(0o700);
    expect(artifact.runtime.sha256).toBe(digest(fs.readFileSync(process.execPath)));
    assertDeploymentMetadata(artifact);
    repeated = await f.build(); expect(repeated.runner.sha256).toBe(artifact.runner.sha256); expect(repeated.runtime.sha256).toBe(artifact.runtime.sha256);
    repeated.cleanup(); expect(outputFlushes).toBe(0); // Transfer temporaries are read back, not crash-durable records.
    const fixed = artifact.runner.sha256;
    fs.appendFileSync(path.join(f.source, 'src/runner/protocol.js'), '\n// later source mutation\n');
    expect(digest(fs.readFileSync(artifact.runner.file))).toBe(fixed);
    const directory = path.dirname(artifact.runner.file); artifact.cleanup(); artifact.cleanup(); expect(fs.existsSync(directory)).toBe(false);
  } finally { syncSpy?.mockRestore(); repeated?.cleanup(); artifact?.cleanup(); f.close(); }
});

test('real tar extraction and copied Bun load the production entry, dynamic children and native FFI dependency without touching system cgroups', async () => {
  const f = fixture(); let artifact;
  try {
    artifact = await f.build();
    const unpacked = path.join(f.root, 'unpacked'); fs.mkdirSync(unpacked);
    expect(invoke(['tar', '-tf', artifact.runner.file]).out.trim().split('\n')).toEqual(artifact.files);
    expect(invoke(['tar', '-xf', artifact.runner.file, '-C', unpacked])).toEqual({ code: 0, out: '', err: '' });
    const runtime = path.join(unpacked, 'bun'); fs.copyFileSync(artifact.runtime.file, runtime); fs.chmodSync(runtime, 0o700);
    expect(invoke([runtime, '--version'])).toEqual({ code: 0, out: `${process.versions.bun}\n`, err: '' });
    const help = invoke([runtime, path.join(unpacked, 'bin/lush-runner'), '--help']); expect(help.code).toBe(0); expect(help.out).toContain('lush-runner serve'); expect(help.err).toBe('');
    const guard = invoke([runtime, path.join(unpacked, 'src/runner/command-guard.js')]); expect(guard.code).toBe(1); expect(guard.err).toBe('');
    const child = invoke([runtime, path.join(unpacked, 'src/runner/command-child.js')]); expect(child.code).toBe(0); expect(child.err).toBe('');
    const launch = invoke([runtime, '-e', `import {productionController} from './src/runner/command-guard.js'; const root=${JSON.stringify(f.root)}; const spec={cgroup_root:root,node_id:'bundle-test'}; const child=productionController(spec).launch({},spec,{},root,()=>{}); let errors=''; child.stderr.on('data',chunk=>{errors+=chunk}); const code=await new Promise(done=>child.once('close',done)); console.log(JSON.stringify({code,errors}));`], { cwd: unpacked });
    expect(launch).toEqual({ code: 0, out: '{"code":126,"errors":""}\n', err: '' });
    const native = invoke([runtime, '-e', `import fs from 'node:fs'; import {posixFiles} from './src/core/workspaces/code-posix.js'; import {observeBootstrap} from './src/runner/command-bootstrap.js'; const fd=posixFiles.openDirectory(${JSON.stringify(unpacked)}); fs.closeSync(fd); console.log(typeof observeBootstrap);`], { cwd: unpacked });
    expect(native).toEqual({ code: 0, out: 'function\n', err: '' });
    const serve = invoke([runtime, path.join(unpacked, 'bin/lush-runner'), 'serve'], { env: { PATH: '/usr/bin:/bin', HOME: f.root, LUSH_RUNNER_CONFIG: path.join(f.root, 'missing-private-config') } });
    expect(serve.code).toBe(1); expect(serve.err).not.toMatch(/Cannot find|ResolveMessage|SyntaxError/); expect(fs.existsSync(path.join(f.root, 'missing-private-config'))).toBe(false);
  } finally { artifact?.cleanup(); f.close(); }
});

test('production defaults resolve the executing module origin, not the caller cwd, project contents or env', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'private.js'), 'PRIVATE_SECRET');
    const program = `import {buildDeploymentArtifacts} from ${JSON.stringify(path.join(CODE, 'src/core/runner-deployment-bundle.js'))}; const a=await buildDeploymentArtifacts({destination:${JSON.stringify(f.output)}}); console.log(JSON.stringify({files:a.files,hash:a.runner.sha256})); a.cleanup();`;
    const child = invoke([process.execPath, '-e', program], { cwd: f.root, env: { PATH: '/usr/bin:/bin', BUNDLE_PRIVATE_ENV: 'PRIVATE_SECRET' } });
    expect(child.code).toBe(0); expect(child.err).toBe(''); expect(child.out).not.toContain('PRIVATE_SECRET');
    expect(JSON.parse(child.out).files).toContain('bin/lush-runner'); expect(JSON.parse(child.out).files).not.toContain('private.js');
    expect(JSON.parse(child.out).files.some(file => file.startsWith('src/core/runner-deployment-'))).toBe(false);
  } finally { f.close(); }
});

test('unsupported central platform or architecture fails before producing artifacts', () => {
  const f = fixture();
  try {
    for (const [key, value] of [['platform', 'darwin'], ['arch', 'riscv64']]) {
      const script = `Object.defineProperty(process,${JSON.stringify(key)},{value:${JSON.stringify(value)}}); const {buildDeploymentArtifacts}=await import(${JSON.stringify(path.join(CODE, 'src/core/runner-deployment-bundle.js'))}); try {await buildDeploymentArtifacts({destination:${JSON.stringify(f.output)}}); process.exitCode=1;} catch(error) {console.log(error.code);}`;
      expect(invoke([process.execPath, '-e', script])).toEqual({ code: 0, out: 'UNSUPPORTED\n', err: '' });
    }
    expect(fs.readdirSync(f.output)).toEqual([]);
  } finally { f.close(); }
});

test('missing/corrupt source, imports outside the audited closure, computed child paths and oversized files fail without leaked body or artifacts', async () => {
  const cases = ["import '../../PRIVATE_SECRET.js';", "import x from 'private-module';", 'const x = import(process.env.PRIVATE_SECRET);', 'new URL(process.env.PRIVATE_SECRET, import.meta.url);', 'const PRIVATE_SECRET = ;', "new URL('./PRIVATE_SECRET.js', import.meta.url);"];
  for (const text of cases) {
    const f = fixture(); try { fs.appendFileSync(path.join(f.source, 'src/runner/protocol.js'), `\n${text}\n`); await rejected(f); } finally { f.close(); }
  }
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.source, 'bin/lush-runner'), ''); await rejected(f);
    fs.copyFileSync(path.join(CODE, 'bin/lush-runner'), path.join(f.source, 'bin/lush-runner'));
    fs.unlinkSync(path.join(f.source, 'src/runner/command-child.js')); await rejected(f);
    fs.writeFileSync(path.join(f.source, 'src/runner/command-child.js'), Buffer.from([255, 255])); await rejected(f);
    fs.truncateSync(path.join(f.source, 'src/runner/command-child.js'), BUNDLE_LIMITS.source_file + 1); await rejected(f);
  } finally { f.close(); }
});

test('source symlinks, hardlinks, directory links, nonregular files and path traversal are refused', async () => {
  for (const kind of ['link', 'hardlink', 'directory', 'fifo', 'root', 'destination', 'traversal']) {
    const f = fixture();
    try {
      const file = path.join(f.source, 'src/runner/protocol.js'), target = path.join(f.root, 'PRIVATE_SECRET');
      fs.writeFileSync(target, fs.readFileSync(file));
      if (kind === 'destination') { const link = path.join(f.root, 'output-link'); fs.symlinkSync(f.output, link); await rejected(f, { destination: link }); continue; }
      if (kind === 'root') { const link = path.join(f.root, 'source-link'); fs.symlinkSync(f.source, link); await rejected(f, { source_root: link }); continue; }
      if (kind === 'traversal') { await rejected(f, { source_root: `${f.source}/../source` }); continue; }
      if (kind === 'directory') { fs.renameSync(path.join(f.source, 'src/runner'), path.join(f.root, 'real-runner')); fs.symlinkSync(path.join(f.root, 'real-runner'), path.join(f.source, 'src/runner')); }
      else { fs.unlinkSync(file); if (kind === 'link') fs.symlinkSync(target, file); else if (kind === 'hardlink') fs.linkSync(target, file); else expect(invoke(['mkfifo', file]).code).toBe(0); }
      await rejected(f);
    } finally { f.close(); }
  }
});

test('total tar budget, corrupt/truncated/wrong-architecture runtime, runtime links and 256MiB limit are enforced', async () => {
  const f = fixture();
  try {
    const runtime = path.join(f.root, 'fake-bun'); fs.writeFileSync(runtime, 'PRIVATE_SECRET'); fs.chmodSync(runtime, 0o700); await rejected(f, { bun_path: runtime });
    fs.truncateSync(runtime, BUNDLE_LIMITS.runtime + 1); await rejected(f, { bun_path: runtime });
    fs.unlinkSync(runtime); fs.symlinkSync(process.execPath, runtime); await rejected(f, { bun_path: runtime }); fs.unlinkSync(runtime);
    const header = Buffer.from(fs.readFileSync(process.execPath).subarray(0, 8192)); header.writeUInt16LE(0, 18); fs.writeFileSync(runtime, header, { mode: 0o700 }); await rejected(f, { bun_path: runtime });
    fs.copyFileSync('/usr/bin/ls', runtime); fs.chmodSync(runtime, 0o700); await rejected(f, { bun_path: runtime });
    for (const file of SOURCE_FILES.filter(file => file.endsWith('.js'))) fs.appendFileSync(path.join(f.source, file), '\n/*' + 'x'.repeat(800000) + '*/\n');
    await rejected(f);
  } finally { f.close(); }
});

test('source mutation or directory link swap after snapshot cannot produce a mixed-version package', async () => {
  for (const swap of [false, true]) {
    const f = fixture(); let changed = false, spy;
    try {
      const original = fs.readSync;
      spy = spyOn(fs, 'readSync').mockImplementation((fd, ...args) => {
        const result = original(fd, ...args);
        if (!changed && fs.readlinkSync(`/proc/self/fd/${fd}`) === process.execPath) {
          changed = true;
          if (swap) { fs.renameSync(path.join(f.source, 'src/runner'), path.join(f.root, 'moved')); fs.symlinkSync(path.join(f.root, 'moved'), path.join(f.source, 'src/runner')); }
          else fs.appendFileSync(path.join(f.source, 'src/runner/protocol.js'), '\n// PRIVATE_SECRET concurrent change\n');
        }
        return result;
      });
      await rejected(f); expect(changed).toBe(true);
    } finally { spy?.mockRestore(); f.close(); }
  }
});

test('artifact read-back catches same-size corruption during writes before output signatures were captured', async () => {
  for (const output of ['runner.tar', 'bun']) {
    const f = fixture(); let spy, changed = false;
    try {
      const method = output === 'bun' ? 'writeSync' : 'writeFileSync', original = fs[method], write = fs.writeSync;
      spy = spyOn(fs, method).mockImplementation((target, ...args) => {
        const result = original(target, ...args);
        if (!changed && typeof target === 'number' && fs.readlinkSync(`/proc/self/fd/${target}`).endsWith(`/${output}`)) {
          changed = true; write(target, Buffer.from('X'), 0, 1, 0);
        }
        return result;
      });
      await rejected(f); expect(changed).toBe(true);
    } finally { spy?.mockRestore(); f.close(); }
  }
});

test('runtime mutation/directory replacement and output mutation are detected before publication', async () => {
  for (const kind of ['runtime', 'runtime-directory', 'output']) {
    const f = fixture(); let spy, changed = false;
    try {
      const binaryDirectory = path.join(f.root, 'runtime'); fs.mkdirSync(binaryDirectory);
      const binary = path.join(binaryDirectory, 'bun'); fs.copyFileSync(process.execPath, binary); fs.chmodSync(binary, 0o700);
      const original = fs.readSync;
      spy = spyOn(fs, 'readSync').mockImplementation((fd, ...args) => {
        const result = original(fd, ...args), name = fs.readlinkSync(`/proc/self/fd/${fd}`);
        const output = fs.readdirSync(f.output).find(name => name.startsWith('lush-runner-deployment-'));
        if (!changed && (kind === 'output' ? output && name.endsWith('/src/runner/protocol.js') : name === binary && args[2] === 1024 * 1024)) {
          changed = true;
          if (kind === 'runtime') fs.appendFileSync(binary, 'PRIVATE_SECRET');
          else if (kind === 'runtime-directory') { fs.renameSync(binaryDirectory, `${binaryDirectory}-moved`); fs.symlinkSync(`${binaryDirectory}-moved`, binaryDirectory); }
          else fs.appendFileSync(path.join(f.output, output, 'runner.tar'), 'PRIVATE_SECRET');
        }
        return result;
      });
      await rejected(f, { bun_path: binary }); expect(changed).toBe(true);
    } finally { spy?.mockRestore(); f.close(); }
  }
});

test('official acquisition is opt-in; verified private cache works offline without executing or overwriting inputs', async () => {
  const f = fixture(), { zip, binary, pin } = officialFixture();
  const cache = path.join(f.root, 'cache'); fs.mkdirSync(cache, { mode: 0o700 }); let calls = 0, cacheFlushes = 0, syncSpy;
  const request = async (url, options) => { calls++; expect(url).toBe(pin.url); expect(options).toMatchObject({ redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer' }); return new Response(zip); };
  try {
    const sync = fs.fsyncSync;
    syncSpy = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(`${cache}/.official-`)) cacheFlushes++;
      return sync(fd);
    });
    await expect(obtainOfficialRuntime({ cache_directory: cache }, request, pin)).rejects.toMatchObject({ code: 'UNSUPPORTED' }); expect(calls).toBe(0);
    expect(await obtainOfficialRuntime({ cache_directory: cache, allow_download: true }, request, pin)).toEqual(binary); expect(calls).toBe(1);
    expect(await obtainOfficialRuntime({ cache_directory: cache }, request, pin)).toEqual(binary); expect(calls).toBe(1);
    expect(cacheFlushes).toBe(1); // Unlike transfer temporaries, persistent cache publication still flushes before linking.
    const file = path.join(cache, `${pin.archive_sha256}.zip`); expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(cache)).toEqual([`${pin.archive_sha256}.zip`]);
    fs.writeFileSync(file, 'PRIVATE_SECRET corrupt cache');
    await expect(obtainOfficialRuntime({ cache_directory: cache, allow_download: true }, request, pin)).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' });
    expect(calls).toBe(1); expect(fs.readFileSync(file, 'utf8')).toBe('PRIVATE_SECRET corrupt cache');
    fs.unlinkSync(file); fs.symlinkSync(path.join(f.root, 'PRIVATE_SECRET'), file);
    await expect(obtainOfficialRuntime({ cache_directory: cache }, request, pin)).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' });
    fs.unlinkSync(file); fs.chmodSync(cache, 0o755);
    await expect(obtainOfficialRuntime({ cache_directory: cache, allow_download: true }, request, pin)).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' }); expect(calls).toBe(1);
    await expect(buildOfficialDeploymentArtifacts({ destination: f.output })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  } finally { syncSpy?.mockRestore(); f.close(); }
});

test('official cache directory replacement during download cannot redirect publication into caller files', async () => {
  const f = fixture(), { zip, pin } = officialFixture();
  try {
    const cache = path.join(f.root, 'cache'), moved = path.join(f.root, 'moved'), external = path.join(f.root, 'external');
    fs.mkdirSync(cache, { mode: 0o700 }); fs.mkdirSync(external, { mode: 0o700 }); fs.writeFileSync(path.join(external, 'sentinel'), 'keep');
    await expect(obtainOfficialRuntime({ cache_directory: cache, allow_download: true }, async () => {
      fs.renameSync(cache, moved); fs.symlinkSync(external, cache); return new Response(zip);
    }, pin)).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' });
    expect(fs.readdirSync(external)).toEqual(['sentinel']); expect(fs.readFileSync(path.join(external, 'sentinel'), 'utf8')).toBe('keep');
  } finally { f.close(); }
});

test('official download restricts redirects, bounds bytes and verifies a fixed digest without retry or raw errors', async () => {
  const { zip, pin } = officialFixture(); let calls = 0;
  const good = async (url, options) => { calls++; expect(options.headers).toEqual({ 'accept-encoding': 'identity' }); return calls === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixed-public-asset' } }) : new Response(zip, { headers: { 'content-length': String(zip.length) } }); };
  expect(await downloadOfficialZip(good, pin)).toEqual(zip); expect(calls).toBe(2);
  for (const location of ['http://release-assets.githubusercontent.com/asset', 'https://evil.example/PRIVATE_SECRET', 'https://release-assets.githubusercontent.com:8443/asset', 'https://user:secret@release-assets.githubusercontent.com/asset']) {
    let count = 0; await expect(downloadOfficialZip(async () => { count++; return new Response(null, { status: 302, headers: { location } }); }, pin)).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' }); expect(count).toBe(1);
  }
  for (const response of [new Response(Buffer.concat([zip, Buffer.from('x')])), new Response(Buffer.alloc(zip.length)), new Response(zip, { status: 404 }), new Response(zip, { headers: { 'content-length': '99999999' } })]) {
    await expect(downloadOfficialZip(async () => response, pin)).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' });
  }
  try { await downloadOfficialZip(async () => { throw new Error('PRIVATE_SECRET transport'); }, pin); throw new Error('unexpected success'); }
  catch (error) { expect(error.code).toBe('UNSUPPORTED'); expect(error.message).not.toContain('PRIVATE_SECRET'); }
});

test('official zip extractor is bounded, exact-layout only, and rejects corruption, links, traversal and wrong binary hashes', () => {
  const { zip, binary, pin } = officialFixture(); expect(decodeOfficialZip(zip, pin)).toEqual(binary);
  expect(() => decodeOfficialZip(Buffer.alloc(zip.length), pin)).toThrow();
  const central = zip.readUInt32LE(zip.length - 6), second = central + 46 + Buffer.byteLength(`${pin.asset}/`);
  const changes = [data => { data.writeUInt16LE(3, data.length - 12); }, data => { data.writeUInt32LE(0xa1ed0000, second + 38); },
    data => { data.write('../', second + 46, 3); }, data => { data.writeUInt32LE(0xffffffff, second + 24); }, data => { data.writeUInt16LE(1, second + 10); }];
  for (const change of changes) { const data = Buffer.from(zip); change(data); expect(() => decodeOfficialZip(data, { ...pin, archive_sha256: digest(data) })).toThrow(); }
  expect(() => decodeOfficialZip(zip, { ...pin, sha256: '0'.repeat(64) })).toThrow();
  const bomb = Buffer.from(zip); bomb.writeUInt32LE(1, second + 24); bomb.writeUInt32LE(1, central - 4);
  expect(() => decodeOfficialZip(bomb, { ...pin, size: 1, archive_sha256: digest(bomb) })).toThrow();
});

const realOfficialZip = process.env.LUSH_TEST_OFFICIAL_BUN_ZIP;
test.skipIf(!realOfficialZip || process.versions.bun !== OFFICIAL_BUN.version)('real pinned official Bun executes extracted production entry, dynamic launcher/children and native FFI; this is local proof, not remote readiness', async () => {
  const f = fixture(); let artifact, spy;
  try {
    const cache = path.join(f.root, 'cache'); fs.mkdirSync(cache, { mode: 0o700 }); const zip = path.join(cache, `${OFFICIAL_BUN.archive_sha256}.zip`);
    fs.copyFileSync(realOfficialZip, zip); fs.chmodSync(zip, 0o600);
    spy = spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('offline acceptance must never fetch'); });
    artifact = await buildOfficialDeploymentArtifacts({ cache_directory: cache, destination: f.output, source_root: f.source }); expect(spy).not.toHaveBeenCalled();
    expect(artifact.runtime).toMatchObject({ source: 'official-bun', version: OFFICIAL_BUN.version, sha256: OFFICIAL_BUN.sha256, size: OFFICIAL_BUN.size });
    expect(artifact.runtime.abi).toMatchObject({ supported: true, profile: 'official-linux-x64-baseline', cpu_features: ['sse4_2'], libc_min_version: '2.17', kernel_min_version: '3.10', files: [], probe_required: true });
    expect(artifact.runtime.provenance.archive_sha256).toBe(OFFICIAL_BUN.archive_sha256);
    assertDeploymentMetadata(artifact);
    expect(digest(fs.readFileSync(artifact.runtime.file))).toBe(OFFICIAL_BUN.sha256); expect(fs.statSync(artifact.runtime.file).mode & 0o777).toBe(0o600);
    expect(entries(artifact.runner.file).map(row => row.name)).toEqual(artifact.files);
    const unpacked = path.join(f.root, 'official-unpacked'); fs.mkdirSync(unpacked); expect(invoke(['tar', '-xf', artifact.runner.file, '-C', unpacked]).code).toBe(0);
    const runtime = path.join(unpacked, 'bun'); fs.copyFileSync(artifact.runtime.file, runtime); fs.chmodSync(runtime, 0o700);
    expect(invoke([runtime, '--version'])).toEqual({ code: 0, out: `${OFFICIAL_BUN.version}\n`, err: '' });
    const help = invoke([runtime, path.join(unpacked, 'bin/lush-runner'), '--help']); expect(help.code).toBe(0); expect(help.out).toContain('lush-runner serve'); expect(help.err).toBe('');
    expect(invoke([runtime, path.join(unpacked, 'src/runner/command-guard.js')])).toEqual({ code: 1, out: '', err: '' });
    expect(invoke([runtime, path.join(unpacked, 'src/runner/command-child.js')])).toEqual({ code: 0, out: '', err: '' });
    const probe = invoke([runtime, '-e', `import fs from 'node:fs';import {posixFiles} from './src/core/workspaces/code-posix.js';import {productionController} from './src/runner/command-guard.js';const root=${JSON.stringify(unpacked)};fs.closeSync(posixFiles.openDirectory(root));const spec={cgroup_root:root,node_id:'official-test'};const child=productionController(spec).launch({},spec,{},root,()=>{});let errors='';child.stderr.on('data',chunk=>{errors+=chunk});const code=await new Promise(done=>child.once('close',done));console.log(JSON.stringify({code,errors}));`], { cwd: unpacked });
    expect(probe).toEqual({ code: 0, out: '{"code":126,"errors":""}\n', err: '' });
  } finally { spy?.mockRestore(); artifact?.cleanup(); f.close(); }
});

test('ELF evidence parser follows bounded dynamic tables and refuses corrupt, ambiguous or unsafe metadata', () => {
  const f = fixture(); const file = path.join(f.root, 'fixture.so');
  const parse = data => { fs.writeFileSync(file, data); const fd = fs.openSync(file, fs.constants.O_RDONLY); try { return elfDependencies(fd, data.length); } finally { fs.closeSync(fd); } };
  try {
    expect(parse(elfFixture())).toEqual({ needed: ['libc.so.6'], soname: 'libfixture.so.1' });
    const corruptions = [
      data => { data[0] = 0; }, data => { data[4] = 1; }, data => { data[5] = 2; }, data => { data.writeUInt16LE(0, 18); },
      data => { data.writeBigUInt64LE(0x9999n, 264); }, data => { data.writeBigUInt64LE(BigInt(ABI_LIMITS.strings + 1), 280); },
      data => { data.writeBigUInt64LE(10n, 288); }, data => { data.writeBigUInt64LE(0x7fffffffn, 288); },
      data => { data.writeBigUInt64LE(BigInt(ABI_LIMITS.dynamic + 16), 152); },
      data => { data.writeBigUInt64LE(BigInt(data.length), 312); },
      data => { data.writeBigUInt64LE(0n, 104); },
    ];
    for (const corrupt of corruptions) { const data = elfFixture(); corrupt(data); expect(() => parse(data)).toThrow(); }
    expect(() => parse(elfFixture(['../PRIVATE_SECRET']))).toThrow();
    expect(() => parse(elfFixture(Array(ABI_LIMITS.files + 1).fill('libc.so.6')))).toThrow();
    expect(() => parse(Buffer.alloc(10))).toThrow();
  } finally { f.close(); }
});

test('proc mapping evidence is bounded and rejects deleted, private or conflicting library paths', () => {
  const line = (file, inode = 12) => `1000-2000 r-xp 00000000 00:01 ${inode} ${file}\n`;
  expect(parseMappedLibraries(line('/usr/lib/libfixture.so.1'))).toEqual([{ path: '/usr/lib/libfixture.so.1', major: 0n, minor: 1n, ino: 12n }]);
  for (const text of [line('/home/user/PRIVATE_SECRET.so'), line('/usr/lib/libfixture.so.1 (deleted)'), line('/usr/lib/../private.so'),
    line('/usr/lib/libfixture.so.1') + line('/usr/lib/libfixture.so.1', 13), 'x'.repeat(ABI_LIMITS.maps + 1),
    Array.from({ length: ABI_LIMITS.candidates + 1 }, (_, i) => line(`/usr/lib/lib${i}.so.1`)).join('')]) expect(() => parseMappedLibraries(text)).toThrow();
});

test('ABI aliases hash the actual mapped regular file and refuse wrong identity, changes, hardlinks, nonregular files and size limits', () => {
  const f = fixture(); let spy;
  try {
    const real = path.join(f.root, 'fixture.so'), alias = path.join(f.root, 'alias.so');
    fs.writeFileSync(real, elfFixture(), { mode: 0o700 }); fs.symlinkSync(real, alias);
    const snapshot = fingerprintMappedFile(alias, mappingFor(real));
    expect(snapshot).toMatchObject({ path: alias, realpath: real, sha256: digest(fs.readFileSync(real)), size: 4096 });
    expect(() => fingerprintMappedFile(alias, { ...mappingFor(real), ino: 0n })).toThrow();
    fs.chmodSync(real, 0o777); expect(() => fingerprintMappedFile(alias, mappingFor(real))).toThrow(); fs.chmodSync(real, 0o700);
    fs.linkSync(real, path.join(f.root, 'hardlink')); expect(() => fingerprintMappedFile(alias, mappingFor(real))).toThrow(); fs.unlinkSync(path.join(f.root, 'hardlink'));
    const original = fs.readSync; let changed = false;
    spy = spyOn(fs, 'readSync').mockImplementation((fd, ...args) => {
      const result = original(fd, ...args);
      if (!changed && fs.readlinkSync(`/proc/self/fd/${fd}`) === real) { changed = true; fs.appendFileSync(real, 'PRIVATE_SECRET'); }
      return result;
    });
    expect(() => fingerprintMappedFile(alias, mappingFor(real))).toThrow(); expect(changed).toBe(true); spy.mockRestore();
    fs.writeFileSync(real, elfFixture()); const replacement = path.join(f.root, 'replacement.so'); fs.writeFileSync(replacement, elfFixture()); changed = false;
    spy = spyOn(fs, 'readSync').mockImplementation((fd, ...args) => {
      const result = original(fd, ...args);
      if (!changed && fs.readlinkSync(`/proc/self/fd/${fd}`) === real) { changed = true; fs.unlinkSync(alias); fs.symlinkSync(replacement, alias); }
      return result;
    });
    expect(() => fingerprintMappedFile(alias, mappingFor(real))).toThrow(); expect(changed).toBe(true); spy.mockRestore();
    fs.truncateSync(real, ABI_LIMITS.file + 1); expect(() => fingerprintMappedFile(real, mappingFor(real))).toThrow();
    const fifo = path.join(f.root, 'fifo'); expect(invoke(['mkfifo', fifo]).code).toBe(0); expect(() => fingerprintMappedFile(fifo, mappingFor(fifo))).toThrow();
  } finally { spy?.mockRestore(); f.close(); }
});

test('unresolved DT_NEEDED or unavailable kernel evidence is unsupported, without private errors or an executable-compatibility claim', async () => {
  const f = fixture(); let spy, artifact;
  try {
    const foreign = path.join(f.root, 'not-running-bun'); fs.writeFileSync(foreign, elfFixture(['PRIVATE_SECRET.so']));
    const loader = parseMappedLibraries(fs.readFileSync('/proc/self/maps', 'utf8')).find(row => row.path.includes('/ld-linux-')).path;
    const fd = fs.openSync(foreign, fs.constants.O_RDONLY);
    try { expect(collectAbiEvidence(fd, fs.fstatSync(fd).size, { interpreter: loader })).toMatchObject({ supported: false, reason: 'abi_evidence_unavailable', files: [], probe_required: true }); }
    finally { fs.closeSync(fd); }
    const original = fs.openSync;
    spy = spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      if (file === '/proc/self/maps') throw new Error(`PRIVATE_SECRET ${f.root}`);
      return original(file, ...args);
    });
    artifact = await f.build();
    expect(artifact.runtime.abi).toMatchObject({ supported: false, reason: 'abi_evidence_unavailable', files: [], probe_required: true });
    expect(JSON.stringify(artifact.runtime.abi)).not.toContain('PRIVATE_SECRET'); expect(artifact.runner.size).toBeGreaterThan(0);
    expect(artifact.runtime.sha256).toBe(digest(fs.readFileSync(process.execPath)));
  } finally { spy?.mockRestore(); artifact?.cleanup(); f.close(); }
});

test('cleanup never removes a replacement directory/symlink or caller files and can be retried after restoring its own directory', async () => {
  const f = fixture(); let artifact, moved;
  try {
    artifact = await f.build(); const directory = path.dirname(artifact.runner.file), external = path.join(f.root, 'external');
    fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'PRIVATE_SECRET'), 'keep');
    moved = `${directory}-moved`; fs.renameSync(directory, moved); fs.symlinkSync(external, directory);
    expect(() => artifact.cleanup()).toThrow('could not be safely fixed'); expect(fs.readFileSync(path.join(external, 'PRIVATE_SECRET'), 'utf8')).toBe('keep');
    fs.unlinkSync(directory); fs.renameSync(moved, directory); moved = null;
    fs.renameSync(artifact.runner.file, `${artifact.runner.file}-own`); fs.symlinkSync(path.join(external, 'PRIVATE_SECRET'), artifact.runner.file);
    expect(() => artifact.cleanup()).toThrow(); expect(fs.readFileSync(path.join(external, 'PRIVATE_SECRET'), 'utf8')).toBe('keep');
    fs.unlinkSync(artifact.runner.file); fs.renameSync(`${artifact.runner.file}-own`, artifact.runner.file);
    fs.writeFileSync(path.join(directory, 'caller.txt'), 'keep'); expect(() => artifact.cleanup()).toThrow(); expect(fs.readFileSync(path.join(directory, 'caller.txt'), 'utf8')).toBe('keep');
    fs.unlinkSync(path.join(directory, 'caller.txt')); artifact.cleanup(); artifact.cleanup(); expect(fs.existsSync(directory)).toBe(false);
  } finally { artifact?.cleanup(); f.close(); }
});
