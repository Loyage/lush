import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageDesktopRemotePayload, verifyDesktopRemotePayload, REMOTE_RESOURCE_FILES } from '../../scripts/desktop-remote-payload.js';
import { createRemotePayload } from './remote-fixture.js';
let root, input;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-desktop-remote-')));
  input = path.join(root, 'node_modules/lush-remote-build/payload');
  createRemotePayload(root, input);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('desktop stages only independently verified matching Linux resources, never client executables', () => {
  const staged = stageDesktopRemotePayload(root);
  expect(fs.readdirSync(staged).sort()).toEqual([...REMOTE_RESOURCE_FILES].sort());
  const manifest = verifyDesktopRemotePayload(root, staged, { stagedDir: input });
  expect(Object.keys(manifest.targets).sort()).toEqual(['linux-arm64', 'linux-x64']);
  const packaged = path.join(root, 'packaged/remote-payload');
  fs.cpSync(staged, packaged, { recursive: true });
  expect(verifyDesktopRemotePayload(root, packaged, { stagedDir: staged })).toEqual(manifest);
  // All metadata still verifies, but a byte-wise changed manifest is not the reviewed staged resource.
  fs.appendFileSync(path.join(packaged, 'manifest.json'), '\n');
  expect(() => verifyDesktopRemotePayload(root, packaged, { stagedDir: staged })).toThrow('differs from staged');
});

test('a missing architecture or changed payload fails without removing prior staged resources or project state', () => {
  const staged = stageDesktopRemotePayload(root), manifest = fs.readFileSync(path.join(staged, 'manifest.json'));
  fs.mkdirSync(path.join(root, '.lush'));
  fs.writeFileSync(path.join(root, '.lush/keep'), 'project state');
  fs.appendFileSync(path.join(input, 'lush-remote-linux-x64.tar.gz'), 'corrupt');
  expect(() => stageDesktopRemotePayload(root)).toThrow('checksum mismatch');
  expect(fs.readFileSync(path.join(staged, 'manifest.json')).equals(manifest)).toBe(true);
  expect(fs.readFileSync(path.join(root, '.lush/keep'), 'utf8')).toBe('project state');
  const incomplete = path.join(root, 'incomplete');
  createRemotePayload(root, incomplete, ['linux-x64']);
  expect(() => stageDesktopRemotePayload(root, { payloadDir: incomplete })).toThrow('Missing target');
});

test('payloads from a different checkout are rejected even when their internal checksums are valid', () => {
  fs.appendFileSync(path.join(root, 'src/identity.js'), '// changed source\n');
  expect(() => stageDesktopRemotePayload(root)).toThrow('does not match desktop source identity');
});

test.skipIf(process.platform === 'win32')('symlinked payload destinations are rejected rather than followed', () => {
  const parent = path.join(root, 'node_modules/lush-desktop-build');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(parent, { recursive: true }); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'outside');
  fs.symlinkSync(outside, path.join(parent, 'remote-payload'));
  expect(() => stageDesktopRemotePayload(root)).toThrow('must not be a symlink');
  expect(fs.readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('outside');
});
