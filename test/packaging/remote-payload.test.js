import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { BUILD_DIR, BUN_VERSION, TARGETS, nativeTarget, inspectRuntimeBinary, collectRuntimeSources, buildRemotePayload, verifyRemotePayload, mergeRemotePayloads } from '../../scripts/build-remote.js';
import { createRemotePayload } from './remote-fixture.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const native = process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch);
let root;
function elf(target = 'linux-x64', interpreter = null, dynamicTag = null) {
  const count = 1 + Number(Boolean(interpreter)) + Number(Boolean(dynamicTag));
  const headerEnd = 64 + count * 56;
  const text = interpreter ? Buffer.from(`${interpreter}\0`) : Buffer.alloc(0);
  const bytes = Buffer.alloc(headerEnd + text.length + (dynamicTag ? 16 : 0));
  bytes.set([127, 69, 76, 70, 2, 1, 1]);
  bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(target === 'linux-x64' ? 62 : 183, 18);
  bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(count, 56);
  bytes.writeUInt32LE(1, 64); bytes.writeBigUInt64LE(BigInt(bytes.length), 96);
  let at = 120;
  if (interpreter) {
    bytes.writeUInt32LE(3, at); bytes.writeBigUInt64LE(BigInt(headerEnd), at + 8); bytes.writeBigUInt64LE(BigInt(text.length), at + 32);
    bytes.set(text, headerEnd); at += 56;
  }
  if (dynamicTag) {
    bytes.writeUInt32LE(2, at); bytes.writeBigUInt64LE(BigInt(headerEnd + text.length), at + 8); bytes.writeBigUInt64LE(16n, at + 32);
    bytes.writeBigInt64LE(BigInt(dynamicTag), headerEnd + text.length);
  }
  return bytes;
}
function runtimeRun(file, args, options) {
  if (path.basename(file) === 'test-bun') return { status: 0, stdout: `${BUN_VERSION}\n`, stderr: '' };
  return spawnSync(file, args, options);
}
function setup(dir) {
  for (const folder of ['src', 'bin', 'docs']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src/identity.js'), path.join(dir, 'src/identity.js'));
  fs.writeFileSync(path.join(dir, 'docs/README.md'), '# Runtime docs\n');
  for (const name of ['lush', 'lush-host', 'lushd']) fs.writeFileSync(path.join(dir, 'bin', name), '// trusted fixture entry\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Runtime fixture\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', version: '0.2.0' }));
  fs.writeFileSync(path.join(dir, 'test-bun'), elf(native ? nativeTarget() : 'linux-x64'), { mode: 0o755 });
}
function build(options = {}) { return buildRemotePayload({ root, bun: path.join(root, 'test-bun'), run: runtimeRun, ...options }); }
function manifestAt(directory) { return JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')); }
function replaceHash(directory) {
  const manifest = manifestAt(directory);
  for (const entry of Object.values(manifest.targets)) entry.sha256 = hash(fs.readFileSync(path.join(directory, entry.file)));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
}
function tarEntry(name, content = Buffer.alloc(0), { type = '0', mode = 0o644 } = {}) {
  const header = Buffer.alloc(512), data = Buffer.from(content);
  header.write(name, 0, 100, 'utf8');
  const octal = (at, length, value) => header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, at, length, 'ascii');
  octal(100, 8, mode); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, data.length); octal(136, 12, 0);
  header.fill(32, 148, 156); header.write(type, 156, 1); header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length)]);
}
function addEntry(directory, name, options = {}) {
  const entry = Object.values(manifestAt(directory).targets)[0], file = path.join(directory, entry.file);
  const original = gunzipSync(fs.readFileSync(file));
  let offset = 0;
  while (original.subarray(offset, offset + 512).some(byte => byte !== 0)) {
    const size = parseInt(original.subarray(offset + 124, offset + 136).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  fs.writeFileSync(file, gzipSync(Buffer.concat([original.subarray(0, offset), tarEntry(name, Buffer.from('sentinel'), options), Buffer.alloc(1024)])));
  replaceHash(directory);
}
function rewrite(directory, mutate, target = nativeTarget()) {
  const manifest = manifestAt(directory), oldEntry = Object.values(manifest.targets)[0];
  const stage = fs.mkdtempSync(path.join(root, 'rewrite-'));
  try {
    const extracted = spawnSync('tar', ['-xzf', path.join(directory, oldEntry.file), '-C', stage]);
    if (extracted.status !== 0) throw new Error('fixture extraction failed');
    const metadata = JSON.parse(fs.readFileSync(path.join(stage, 'remote.json'), 'utf8'));
    metadata.target = target;
    mutate(stage, metadata);
    fs.writeFileSync(path.join(stage, 'remote.json'), JSON.stringify(metadata));
    const file = `lush-remote-${target}.tar.gz`;
    const packed = spawnSync('tar', ['--format=ustar', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', path.join(directory, file), '-C', stage, 'src', 'bin', 'docs', 'README.md', 'package.json', 'bun', 'remote.json']);
    if (packed.status !== 0) throw new Error('fixture packing failed');
    if (file !== oldEntry.file) fs.unlinkSync(path.join(directory, oldEntry.file));
    manifest.targets = { [target]: { ...oldEntry, file, sha256: hash(fs.readFileSync(path.join(directory, file))), bun_sha256: metadata.bun_sha256 } };
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-remote-packaging-'))); setup(root); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('only explicit native Linux targets are accepted', () => {
  expect(TARGETS).toEqual(['linux-x64', 'linux-arm64']);
  expect(nativeTarget('linux', 'x64')).toBe('linux-x64');
  expect(nativeTarget('linux', 'arm64')).toBe('linux-arm64');
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['linux', 'ia32']]) expect(() => nativeTarget(platform, arch)).toThrow('native Linux');
});

test('reviewed third-party licenses are collected and accepted in remote archives on every platform', () => {
  const licenses = ['mtrojnar-pi-usage.txt', 'pi-usage-meters.txt', 'pi.txt'];
  const source = path.join(ROOT, 'docs/third-party/licenses');
  expect(fs.readdirSync(source).sort()).toEqual(licenses);
  for (const name of licenses) {
    const file = path.join(root, 'docs/third-party/licenses', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(source, name), file);
  }
  const files = collectRuntimeSources(root);
  const directory = path.join(root, 'licensed-payload');
  const manifest = createRemotePayload(root, directory);
  expect(verifyRemotePayload(directory, { requireTargets: TARGETS })).toEqual(manifest);
  for (const name of licenses) {
    const bytes = fs.readFileSync(path.join(source, name));
    expect(files.get(`docs/third-party/licenses/${name}`)).toEqual(bytes);
    for (const entry of Object.values(manifest.targets)) {
      expect(gunzipSync(fs.readFileSync(path.join(directory, entry.file))).includes(bytes)).toBe(true);
    }
  }
});

test('license exceptions do not allow unreviewed text files in sources or archives', () => {
  for (const name of ['docs/secret.txt', 'docs/third-party/licenses/secret.txt', 'docs/third-party/licenses/nested/pi.txt']) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'credential sentinel');
    expect(() => collectRuntimeSources(root)).toThrow(`Unreviewed source file: ${name}`);
    fs.unlinkSync(file);
    const directory = path.join(root, `unreviewed-${path.basename(path.dirname(file))}`);
    createRemotePayload(root, directory);
    addEntry(directory, name);
    expect(() => verifyRemotePayload(directory)).toThrow(`Unsafe or duplicate archive entry: ${name}`);
  }
});

test('ELF validation rejects wrong architecture, Nix loaders, private RPATHs and malformed headers', () => {
  expect(inspectRuntimeBinary(elf('linux-x64', '/lib64/ld-linux-x86-64.so.2'), 'linux-x64').interpreter).toBe('/lib64/ld-linux-x86-64.so.2');
  expect(inspectRuntimeBinary(elf('linux-arm64', '/lib/ld-linux-aarch64.so.1'), 'linux-arm64').target).toBe('linux-arm64');
  expect(() => inspectRuntimeBinary(elf('linux-arm64'), 'linux-x64')).toThrow('architecture');
  expect(() => inspectRuntimeBinary(elf('linux-x64', '/nix/store/example/lib/ld-linux.so'), 'linux-x64')).toThrow('Non-portable');
  for (const tag of [15, 29]) expect(() => inspectRuntimeBinary(elf('linux-x64', null, tag), 'linux-x64')).toThrow('RPATH');
  expect(() => inspectRuntimeBinary(Buffer.from('#!/bin/sh\necho 1.4.2'), 'linux-x64')).toThrow('ELF64');
  const malformed = elf(); malformed.writeUInt16LE(1000, 56);
  expect(() => inspectRuntimeBinary(malformed, 'linux-x64')).toThrow('headers');
});

describe.skipIf(!native)('native remote artifact boundary (ELF fixtures are not real Bun validation)', () => {
  test('actual ustar artifact has private Bun and all runtime sources but no surrounding project data', () => {
    for (const name of ['.lush/agent/agent.env', '.env', 'node_modules/electron/secret', 'project-secret.txt', 'test/credentials.json']) {
      const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'credential sentinel');
    }
    const { directory, manifest, archive, target } = build();
    expect(directory).toBe(path.join(root, BUILD_DIR));
    expect(verifyRemotePayload(directory)).toEqual(manifest);
    const list = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }).stdout;
    for (const name of ['bun', 'remote.json', 'src/identity.js', 'bin/lushd', 'docs/README.md']) expect(list).toContain(name);
    for (const name of ['node_modules', '.lush', '.env', 'project-secret.txt', 'test/']) expect(list).not.toContain(name);
    expect(manifest.targets[target].bun_version).toBe(BUN_VERSION);
    expect(manifest.targets[target].sha256).toBe(hash(fs.readFileSync(archive)));
  });
  test('rebuilding is deterministic and does not touch existing project state', () => {
    fs.mkdirSync(path.join(root, '.lush')); fs.writeFileSync(path.join(root, '.lush/keep'), 'preserve');
    const first = build(), bytes = fs.readFileSync(first.archive), second = build();
    expect(second.manifest).toEqual(first.manifest); expect(fs.readFileSync(second.archive)).toEqual(bytes);
    expect(fs.readFileSync(path.join(root, '.lush/keep'), 'utf8')).toBe('preserve');
  });
  test('source and destination symlinks including dangling links fail closed', () => {
    const file = path.join(root, 'src/identity.js'); fs.unlinkSync(file); fs.symlinkSync('/missing-credential-target', file);
    expect(() => build()).toThrow('Symlinked');
    fs.unlinkSync(file); fs.copyFileSync(path.join(ROOT, 'src/identity.js'), file);
    const out = path.join(root, 'external-link'); fs.symlinkSync('/missing-output', out);
    expect(() => build({ out })).toThrow('Symlinked');
    const { directory } = build();
    const archive = path.join(directory, manifestAt(directory).targets[nativeTarget()].file);
    fs.unlinkSync(archive); fs.symlinkSync('/missing-bundle', archive);
    expect(() => verifyRemotePayload(directory)).toThrow('Symlinked');
  });
  test('output cannot overwrite sources or project state; unreviewed source types reject instead of shipping secrets', () => {
    for (const out of [root, path.join(root, 'src/output'), path.join(root, '.lush/output')]) expect(() => build({ out })).toThrow('Output');
    fs.writeFileSync(path.join(root, 'src/.env'), 'secret'); expect(() => build()).toThrow('Unreviewed');
    fs.unlinkSync(path.join(root, 'src/.env')); fs.writeFileSync(path.join(root, 'docs/secret.env'), 'secret'); expect(() => build()).toThrow('Unreviewed');
  });
  test('paths beyond ustar limits fail without silently adding PAX/GNU metadata or partial artifacts', () => {
    const deep = path.join(root, 'src', 'a'.repeat(150), 'b'.repeat(150));
    fs.mkdirSync(deep, { recursive: true }); fs.writeFileSync(path.join(deep, 'long.js'), '// trusted source');
    const out = path.join(root, 'long-path-output');
    expect(() => build({ out })).toThrow('tar failed');
    expect(fs.readdirSync(out)).toEqual([]);
    expect(fs.readdirSync(root).some(name => /^remote-(stage|artifact)-/.test(name))).toBe(false);
  });
  test('runtime version is checked and no non-ELF installer script is executed', () => {
    expect(() => build({ run: () => ({ status: 0, stdout: '1.4.1\n', stderr: '' }) })).toThrow('1.4.2');
    fs.writeFileSync(path.join(root, 'test-bun'), '#!/bin/sh\necho 1.4.2\n');
    let invoked = false;
    expect(() => build({ run: () => { invoked = true; return { status: 0, stdout: '1.4.2' }; } })).toThrow('ELF64');
    expect(invoked).toBe(false);
  });
  test('source identity changes require a fresh output directory', () => {
    const original = build(); fs.appendFileSync(path.join(root, 'src/identity.js'), '\n// source changed\n');
    expect(() => build()).toThrow('different runtime identity');
    expect(verifyRemotePayload(original.directory)).toEqual(original.manifest);
  });
  test('manifest validation rejects unknown keys, paths, foreign runtime version and missing target', () => {
    const { directory } = build(), original = manifestAt(directory), file = path.join(directory, 'manifest.json');
    for (const modify of [m => { m.extra = 'secret'; }, m => { m.targets[nativeTarget()].file = '../escape.tar.gz'; }, m => { m.targets[nativeTarget()].bun_version = 'latest'; }, m => { m.targets['linux-ia32'] = m.targets[nativeTarget()]; }]) {
      const manifest = structuredClone(original); modify(manifest); fs.writeFileSync(file, JSON.stringify(manifest)); expect(() => verifyRemotePayload(directory)).toThrow('Invalid');
    }
    fs.writeFileSync(file, JSON.stringify(original));
    expect(() => verifyRemotePayload(directory, { requireTargets: TARGETS })).toThrow('Missing target');
  });
  test('unexpected payload-directory files cannot be included by resource packaging', () => {
    const { directory } = build(); fs.writeFileSync(path.join(directory, 'auth.json'), 'credential sentinel');
    expect(() => verifyRemotePayload(directory)).toThrow('Unexpected file');
  });
  test('changed archive bytes fail before extraction or execution', () => {
    const { directory, archive } = build(); fs.appendFileSync(archive, 'tampered');
    expect(() => verifyRemotePayload(directory)).toThrow('checksum mismatch');
  });
  test('verified hash does not excuse unsafe tar entries, links, duplicates or privilege bits', () => {
    const cases = [['/escape', {}], ['src/../../escape', {}], ['node_modules/credential', {}], ['src/extra.env', {}], ['src/identity.js', {}], ['src/linked.js', { type: '2' }], ['src/device.js', { type: '3' }], ['src/unsafe.js', { mode: 0o4755 }]];
    for (let index = 0; index < cases.length; index++) {
      const { directory } = build({ out: path.join(root, `malicious-${index}`) }); addEntry(directory, ...cases[index]);
      expect(() => verifyRemotePayload(directory)).toThrow();
    }
  });
  test('archive metadata and actual bundled Bun are independently checked', () => {
    const { directory } = build();
    rewrite(directory, (stage, metadata) => { metadata.fingerprint = '0000000000000000'; });
    expect(() => verifyRemotePayload(directory)).toThrow('metadata mismatch');
    const second = build({ out: path.join(root, 'bun-mismatch') });
    rewrite(second.directory, stage => fs.appendFileSync(path.join(stage, 'bun'), 'changed'));
    expect(() => verifyRemotePayload(second.directory)).toThrow('Bun checksum');
    const third = build({ out: path.join(root, 'source-mismatch') });
    rewrite(third.directory, stage => fs.appendFileSync(path.join(stage, 'src/identity.js'), '// changed'));
    expect(() => verifyRemotePayload(third.directory)).toThrow('source identity');
  });
  test('merge verifies both architecture fixtures, source identity, completeness and duplicate conflict', () => {
    const x = build({ out: path.join(root, 'native') }), arm = build({ out: path.join(root, 'foreign-fixture') });
    const other = nativeTarget() === 'linux-x64' ? 'linux-arm64' : 'linux-x64';
    rewrite(arm.directory, (stage, metadata) => {
      const binary = elf(other); fs.writeFileSync(path.join(stage, 'bun'), binary); metadata.bun_sha256 = hash(binary);
    }, other);
    const out = path.join(root, 'merged');
    const merged = mergeRemotePayloads([x.directory, arm.directory], { out });
    expect(Object.keys(verifyRemotePayload(out, { requireTargets: TARGETS }).targets).sort()).toEqual([...TARGETS].sort());
    expect(merged.manifest.fingerprint).toBe(x.manifest.fingerprint);
    expect(() => mergeRemotePayloads([x.directory], { out: path.join(root, 'missing') })).toThrow('Missing target');
    const bad = build({ out: path.join(root, 'conflicting') });
    rewrite(bad.directory, (stage, metadata) => { fs.appendFileSync(path.join(stage, 'bun'), '\0'); metadata.bun_sha256 = hash(fs.readFileSync(path.join(stage, 'bun'))); });
    expect(() => mergeRemotePayloads([x.directory, bad.directory], { out: path.join(root, 'bad'), requireTargets: [] })).toThrow('Conflicting');
    fs.appendFileSync(path.join(root, 'src/identity.js'), '// different identity');
    const different = build({ out: path.join(root, 'different') });
    expect(() => mergeRemotePayloads([x.directory, different.directory], { out: path.join(root, 'bad-identity'), requireTargets: [] })).toThrow('different runtime identities');
  });
  test('failed tar command leaves previous verified archive and manifest intact', () => {
    const first = build();
    expect(() => build({ run: (file, args, options) => file === 'tar' ? { status: 2, stderr: 'controlled tar failure' } : runtimeRun(file, args, options) })).toThrow('controlled tar failure');
    expect(verifyRemotePayload(first.directory)).toEqual(first.manifest);
    expect(fs.readdirSync(path.dirname(first.directory)).some(name => /^remote-(stage|artifact)-/.test(name))).toBe(false);
  });
});

const realBun = process.env.LUSH_REMOTE_TEST_BUN || process.execPath;
let realPortable = native;
try { inspectRuntimeBinary(fs.readFileSync(realBun), native ? nativeTarget() : 'linux-x64'); } catch { realPortable = false; }
test.skipIf(!realPortable)('real native fixed-version Bun archive extracts and imports daemon/Host without starting user services', () => {
  const out = path.join(root, 'real-runtime');
  const { target, manifest } = buildRemotePayload({ root: ROOT, bun: realBun, out });
  expect(verifyRemotePayload(out, { smoke: true })).toEqual(manifest);
  expect(target).toBe(nativeTarget());
}, 60000);

test('remote payload CI uses both native runners and verifies artifacts before upload without publishing', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/remote-payload.yml'), 'utf8');
  expect(workflow).toContain('workflow_call:');
  expect(workflow).toContain('runner: ubuntu-24.04');
  expect(workflow).toContain('runner: ubuntu-24.04-arm');
  expect(workflow).toContain(`bun-version: ${BUN_VERSION}`);
  expect(workflow).toContain('contents: read');
  expect(workflow).not.toContain('contents: write');
  expect(workflow).not.toContain('secrets.');
  expect(workflow).toContain('--smoke');
  expect(workflow.indexOf('build-remote.js --verify')).toBeLessThan(workflow.indexOf('actions/upload-artifact@v4'));
  expect(workflow).toContain('merge-multiple: false');
  expect(workflow).toContain('name: lush-remote-payload');
});

test.skipIf(!native)('Nix-patched installed runtime is rejected rather than mislabeled portable', () => {
  let binary;
  try { binary = fs.readFileSync(process.execPath); } catch { return; }
  if (!binary.includes(Buffer.from('/nix/store/'))) return;
  expect(() => inspectRuntimeBinary(binary, nativeTarget())).toThrow('Non-portable');
});
