import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareDesktopPayload, desktopPayloadWarning } from '../../scripts/prepare-desktop.js';
import { createRemotePayload } from './remote-fixture.js';
import { createReleasePayloadProvider, desktopReleaseIdentity } from '../../src/ui/desktop/ssh-release.js';
let root, input;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-prepare-')));
  input = path.join(root, 'trusted-input');
  createRemotePayload(root, input);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function git(...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: os.devNull, GIT_CONFIG_GLOBAL: os.devNull });
  const result = spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0) throw new Error(`Fixture Git failed: ${result.error?.message || result.stderr}`);
  return result.stdout.trim();
}
function commitSources(attributes = false) {
  const packageFile = path.join(root, 'package.json');
  fs.writeFileSync(packageFile, `${JSON.stringify(JSON.parse(fs.readFileSync(packageFile)), null, 2)}\n`);
  fs.mkdirSync(path.join(root, 'src/nested'));
  fs.writeFileSync(path.join(root, 'src/nested/module.js'), 'export const value = "测试";\n');
  createRemotePayload(root, input);
  if (attributes) fs.copyFileSync(path.resolve(import.meta.dir, '../../.gitattributes'), path.join(root, '.gitattributes'));
  git('init', '-b', 'main');
  git('-c', 'core.autocrlf=false', 'add', 'src', 'bin', 'docs', 'README.md', 'package.json', ...(attributes ? ['.gitattributes'] : []));
  git('-c', 'user.name=Lush Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
}

test('without checkout attributes, Git autocrlf reproduces the cross-platform identity rejection', () => {
  commitSources();
  const checkout = path.join(root, 'crlf-checkout');
  git('-c', 'core.autocrlf=true', 'clone', '--no-hardlinks', root, checkout);
  expect(fs.readFileSync(path.join(checkout, 'src/identity.js'), 'utf8')).toContain('\r\n');
  expect(desktopReleaseIdentity(checkout).fingerprint).not.toBe(desktopReleaseIdentity(root).fingerprint);
  expect(() => prepareDesktopPayload(checkout, { payloadDir: input })).toThrow('does not match');
  expect(fs.existsSync(path.join(checkout, 'node_modules/lush-remote-build/payload'))).toBe(false);
});

test('runtime checkout attributes keep both autocrlf settings byte-identical and prepare the same Linux payload', () => {
  commitSources(true);
  for (const autocrlf of ['false', 'true']) {
    const checkout = path.join(root, `checkout-${autocrlf}`);
    git('-c', `core.autocrlf=${autocrlf}`, 'clone', '--no-hardlinks', root, checkout);
    for (const name of ['src/identity.js', 'src/nested/module.js', 'bin/lush', 'package.json']) {
      expect(fs.readFileSync(path.join(checkout, name))).toEqual(fs.readFileSync(path.join(root, name)));
      expect(fs.readFileSync(path.join(checkout, name), 'utf8')).not.toContain('\r\n');
    }
    expect(desktopReleaseIdentity(checkout)).toEqual(desktopReleaseIdentity(root));
    const prepared = prepareDesktopPayload(checkout, { payloadDir: input });
    expect(prepared.manifest.fingerprint).toBe(desktopReleaseIdentity(root).fingerprint);
    expect(desktopPayloadWarning(checkout)).toBe(null);
    fs.appendFileSync(path.join(checkout, 'src/identity.js'), '// actual source edit\n');
    expect(() => prepareDesktopPayload(checkout, { payloadDir: input, replace: true })).toThrow('does not match');
  }
});

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

test('unreleased development sources prepare local payloads and serve both SSH targets without GitHub', async () => {
  fs.appendFileSync(path.join(root, 'src/identity.js'), '// unpublished development edit\n');
  const manifest = createRemotePayload(root, input);
  const prepared = prepareDesktopPayload(root, { payloadDir: input });
  let requests = 0;
  const userData = path.join(root, 'desktop-user-data');
  const provider = createReleasePayloadProvider({
    payloadDir: prepared.directory, userData, identity: desktopReleaseIdentity(root),
    fetchImpl: () => { requests++; throw new Error('GitHub must not be needed for local development'); },
  });
  for (const target of ['linux-x64', 'linux-arm64']) {
    expect(provider.resolve(target).download).toBeUndefined();
    const payload = await provider.download(target);
    expect(payload.fingerprint).toBe(manifest.fingerprint);
    expect(payload.archiveSha256).toBe(manifest.targets[target].sha256);
  }
  expect(requests).toBe(0); expect(fs.existsSync(userData)).toBe(false);
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
  for (const file of ['windows-desktop.yml', 'macos-desktop.yml', 'remote-payload.yml']) {
    const workflow = fs.readFileSync(path.join(checkout, '.github/workflows', file), 'utf8');
    expect(workflow.match(/- \.gitattributes/g)).toHaveLength(2);
    if (file !== 'remote-payload.yml') expect(workflow).toContain('bun run desktop:prepare node_modules/lush-remote-inputs/combined');
  }
});
