import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectMacRuntime, stageDesktopLocalRuntime, verifyDesktopLocalRuntime } from '../../scripts/desktop-local-runtime.js';
import { createLocalHost } from '../../src/ui/desktop/local-host.js';
import { createRemotePayload } from './remote-fixture.js';
import { createLocalRuntime, macho } from './macos-runtime-fixture.js';
let root, directory;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-local-runtime-')));
  createRemotePayload(root, path.join(root, 'linux-fixture'));
  directory = path.join(root, 'runtime');
  createLocalRuntime(root, directory);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('Mach-O requires native architecture, bounded commands, system dependencies and no RPATH', () => {
  for (const arch of ['x64', 'arm64']) expect(inspectMacRuntime(macho(arch), arch).dependencies).toEqual(['/usr/lib/libSystem.B.dylib']);
  expect(() => inspectMacRuntime(macho(), 'x64')).toThrow('architecture');
  expect(() => inspectMacRuntime(Buffer.from('installer script'), 'arm64')).toThrow('Mach-O64');
  expect(() => inspectMacRuntime(macho('arm64', '/nix/store/private/lib.dylib'), 'arm64')).toThrow('Non-portable');
  expect(() => inspectMacRuntime(macho('arm64', '@rpath/lib.dylib'), 'arm64')).toThrow('Non-portable');
  expect(() => inspectMacRuntime(macho('arm64', '/usr/lib/../../private/lib.dylib'), 'arm64')).toThrow('Non-portable');
  expect(() => inspectMacRuntime(macho('arm64', '/usr/lib/dyld', 0x8000001c), 'arm64')).toThrow('RPATH');
  expect(inspectMacRuntime(macho('arm64', '/usr/lib/dyld', 0xe), 'arm64').dependencies).toEqual(['/usr/lib/dyld']);
  const invalid = macho(); invalid.writeUInt32LE(1, 36);
  expect(() => inspectMacRuntime(invalid, 'arm64')).toThrow('command size');
  const truncated = macho(); truncated.writeUInt32LE(2000, 20);
  expect(() => inspectMacRuntime(truncated, 'arm64')).toThrow('load commands');
});

test('independent local runtime verification checks allowlist, metadata, source and staged bytes without executing Bun', () => {
  const original = verifyDesktopLocalRuntime(root, directory, { arch: 'arm64' });
  expect(original.target).toBe('darwin-arm64');
  const packaged = path.join(root, 'packaged'); fs.cpSync(directory, packaged, { recursive: true });
  expect(verifyDesktopLocalRuntime(root, packaged, { arch: 'arm64', stagedDir: directory })).toEqual(original);
  fs.appendFileSync(path.join(packaged, 'runtime.json'), '\n');
  expect(() => verifyDesktopLocalRuntime(root, packaged, { arch: 'arm64', stagedDir: directory })).toThrow('metadata differs');
  fs.appendFileSync(path.join(packaged, 'bun'), 'changed');
  expect(() => verifyDesktopLocalRuntime(root, packaged, { arch: 'arm64' })).toThrow('checksum mismatch');
});

test('extra credentials, changed checkout, architecture or Bun version fail closed', () => {
  const metaFile = path.join(directory, 'runtime.json'), original = fs.readFileSync(metaFile);
  const metadata = JSON.parse(original);
  fs.writeFileSync(metaFile, JSON.stringify({ ...metadata, bun_version: '9.0.0' }));
  expect(() => verifyDesktopLocalRuntime(root, directory, { arch: 'arm64' })).toThrow('identity mismatch');
  fs.writeFileSync(metaFile, original);
  expect(() => verifyDesktopLocalRuntime(root, directory, { arch: 'x64' })).toThrow('identity mismatch');
  fs.writeFileSync(path.join(directory, '.env'), 'secret');
  expect(() => verifyDesktopLocalRuntime(root, directory, { arch: 'arm64' })).toThrow('Unexpected');
  fs.unlinkSync(path.join(directory, '.env'));
  fs.appendFileSync(path.join(root, 'src/identity.js'), '// changed checkout\n');
  expect(() => verifyDesktopLocalRuntime(root, directory, { arch: 'arm64' })).toThrow('identity mismatch');
});

test.skipIf(process.platform === 'win32')('runtime symlinks are rejected', () => {
  fs.renameSync(path.join(directory, 'bun'), path.join(root, 'outside-bun'));
  fs.symlinkSync(path.join(root, 'outside-bun'), path.join(directory, 'bun'));
  expect(() => verifyDesktopLocalRuntime(root, directory, { arch: 'arm64' })).toThrow('symlink');
});

test.skipIf(process.platform !== 'darwin')('native staging rejects non-Mach-O input before executing it or replacing prior resources', () => {
  const bun = path.join(root, 'not-bun'); fs.writeFileSync(bun, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  expect(() => stageDesktopLocalRuntime(root, { bun })).toThrow('Mach-O64');
  expect(fs.existsSync(path.join(root, 'node_modules/lush-desktop-build/local-runtime'))).toBe(false);
});

test.skipIf(process.platform !== 'darwin')('native structural staging checks version and refuses dangling outputs before replacing state (mock execution only)', () => {
  const bun = path.join(root, 'test-bun'); fs.writeFileSync(bun, macho(process.arch), { mode: 0o755 });
  expect(() => stageDesktopLocalRuntime(root, { bun, run: () => ({ status: 0, stdout: '1.0.0' }) })).toThrow('Bun 1.4.2 is required');
  const parent = path.join(root, 'node_modules/lush-desktop-build'); fs.mkdirSync(parent, { recursive: true });
  fs.symlinkSync(path.join(root, 'missing'), path.join(parent, 'local-runtime'));
  expect(() => stageDesktopLocalRuntime(root, { bun, run: () => ({ status: 0, stdout: '1.4.2' }) })).toThrow('must not be a symlink');
  expect(fs.lstatSync(path.join(parent, 'local-runtime')).isSymbolicLink()).toBe(true);
});

// Explicit opt-in; a structural fixture is never executed as an acceptance runtime.
const liveBun = process.env.LUSH_MAC_TEST_BUN;
test.skipIf(process.platform !== 'darwin' || !liveBun)('real private macOS runtime imports and owns an isolated ephemeral Host without touching projects', async () => {
  const checkout = path.resolve(import.meta.dir, '../..');
  // Use a temporary faithful source copy; no replacement of the developer checkout's generated files.
  const { collectRuntimeSources } = await import('../../scripts/build-remote.js');
  const isolated = path.join(root, 'checkout');
  for (const [name, bytes] of collectRuntimeSources(checkout)) {
    fs.mkdirSync(path.dirname(path.join(isolated, name)), { recursive: true });
    fs.writeFileSync(path.join(isolated, name), bytes);
  }
  const staged = stageDesktopLocalRuntime(isolated, { bun: liveBun });
  verifyDesktopLocalRuntime(isolated, staged, { smoke: true });
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const host = createLocalHost({ root: staged, bun: path.join(staged, 'bun'),
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, LUSH_GLOBAL_CONFIG: path.join(home, 'config'), LUSH_BUN_COMMAND: path.join(staged, 'bun') } });
  try {
    const url = await host.start();
    const status = await (await fetch(`${url}api/host`)).json();
    expect(status.mode).toBe('host'); expect(status.projects).toEqual([]);
    host.stop();
    const deadline = Date.now() + 5000;
    let exited = false;
    while (Date.now() < deadline) {
      try { await fetch(`${url}api/host`); } catch { exited = true; break; }
      await Bun.sleep(20);
    }
    expect(exited).toBe(true);
  } finally { host.stop(); }
}, 30000);
