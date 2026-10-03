import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareDesktopPayload, desktopPayloadWarning } from '../../scripts/prepare-desktop.js';
import { createRemotePayload } from './remote-fixture.js';
let root, input;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-prepare-')));
  input = path.join(root, 'trusted-input');
  createRemotePayload(root, input);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('explicit import checks both architectures and identity without executing Linux Bun', () => {
  expect(desktopPayloadWarning(root)).toContain('bun run desktop:prepare');
  const result = prepareDesktopPayload(root, { payloadDir: input });
  expect(Object.keys(result.manifest.targets).sort()).toEqual(['linux-arm64', 'linux-x64']);
  expect(desktopPayloadWarning(root)).toBe(null);
  for (const file of fs.readdirSync(input)) expect(fs.readFileSync(path.join(result.directory, file))).toEqual(fs.readFileSync(path.join(input, file)));
  expect(prepareDesktopPayload(root, { payloadDir: input }).directory).toBe(result.directory);
  expect(prepareDesktopPayload(root, { payloadDir: result.directory }).directory).toBe(result.directory);
  expect(() => prepareDesktopPayload(root)).toThrow('Usage:');
});

test('missing architecture, corruption and different source identity reject before replacing generated files', () => {
  const result = prepareDesktopPayload(root, { payloadDir: input });
  const previous = fs.readFileSync(path.join(result.directory, 'manifest.json'));
  const partial = path.join(root, 'partial');
  createRemotePayload(root, partial, ['linux-x64']);
  expect(() => prepareDesktopPayload(root, { payloadDir: partial, replace: true })).toThrow('Missing target');
  fs.appendFileSync(path.join(input, 'lush-remote-linux-arm64.tar.gz'), 'corrupt');
  expect(() => prepareDesktopPayload(root, { payloadDir: input, replace: true })).toThrow('checksum mismatch');
  createRemotePayload(root, input);
  fs.appendFileSync(path.join(root, 'src/identity.js'), '// new checkout\n');
  expect(() => prepareDesktopPayload(root, { payloadDir: input, replace: true })).toThrow('does not match');
  expect(fs.readFileSync(path.join(result.directory, 'manifest.json'))).toEqual(previous);
});

test('replacing old generated identity requires explicit authorization and preserves all project state', () => {
  const result = prepareDesktopPayload(root, { payloadDir: input });
  fs.mkdirSync(path.join(root, '.lush'));
  fs.writeFileSync(path.join(root, '.lush/keep'), 'valuable project data');
  fs.appendFileSync(path.join(root, 'src/identity.js'), '// new version\n');
  createRemotePayload(root, input);
  expect(() => prepareDesktopPayload(root, { payloadDir: input })).toThrow('does not match');
  expect(desktopPayloadWarning(root)).toContain('--replace');
  const replacement = prepareDesktopPayload(root, { payloadDir: input, replace: true });
  expect(replacement.manifest.fingerprint).not.toBe(result.manifest.fingerprint);
  expect(fs.readFileSync(path.join(root, '.lush/keep'), 'utf8')).toBe('valuable project data');
  expect(desktopPayloadWarning(root)).toBe(null);
});

test.skipIf(process.platform === 'win32')('symlink destinations including dangling links are never followed or replaced', () => {
  const parent = path.join(root, 'node_modules/lush-remote-build');
  fs.mkdirSync(parent, { recursive: true });
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'external');
  fs.symlinkSync(outside, path.join(parent, 'payload'));
  expect(() => prepareDesktopPayload(root, { payloadDir: input, replace: true })).toThrow('symlink');
  expect(fs.readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('external');
  fs.unlinkSync(path.join(parent, 'payload')); fs.symlinkSync(path.join(root, 'missing'), path.join(parent, 'payload'));
  expect(() => prepareDesktopPayload(root, { payloadDir: input, replace: true })).toThrow('symlink');
});

test('source launcher and both installer workflows prepare explicitly, never download on startup', () => {
  const checkout = path.resolve(import.meta.dir, '../..');
  const pkg = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json')));
  expect(pkg.scripts.desktop).toBe('bun ./scripts/start-desktop.js');
  const launcher = fs.readFileSync(path.join(checkout, 'scripts/start-desktop.js'), 'utf8');
  expect(launcher).toContain('desktopPayloadWarning(root)');
  expect(launcher).not.toContain('fetch(');
  for (const file of ['windows-desktop.yml', 'macos-desktop.yml']) {
    const workflow = fs.readFileSync(path.join(checkout, '.github/workflows', file), 'utf8');
    expect(workflow).toContain('bun run desktop:prepare node_modules/lush-remote-inputs/combined');
  }
});
