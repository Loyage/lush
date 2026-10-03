import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createPackage } from '@electron/asar';
import { APP_FILES, BUILD_DIR, buildPaths, stageDesktop, validateStage, verifyArchive, builderConfig, writeChecksums } from '../../scripts/build-desktop.js';
import { stageDesktopRemotePayload, REMOTE_RESOURCE_FILES, DESKTOP_PAYLOAD_DIR } from '../../scripts/desktop-remote-payload.js';
import { createRemotePayload } from './remote-fixture.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-packaging-')));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  for (const file of APP_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  createRemotePayload(root, path.join(root, 'node_modules/lush-remote-build/payload'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const relative = `${prefix}${entry.name}`;
    return entry.isDirectory() ? walk(path.join(dir, entry.name), `${relative}/`) : [relative];
  }).sort();
}
async function archiveStage() {
  const paths = stageDesktop(root);
  fs.mkdirSync(path.dirname(paths.archive), { recursive: true });
  await createPackage(paths.app, paths.archive);
  return paths;
}

describe('Windows remote-only application boundary', () => {
  test('staging only copies the allowlist and sanitizes the manifest', () => {
    for (const file of ['.lush/web.json', '.lush/agent/agent.env', 'bin/lushd', 'src/ui/desktop/local-host.js', 'src/core/project.js', '.env', 'node_modules/secret/index.js']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), 'credential sentinel');
    }
    const { app } = stageDesktop(root);
    expect(walk(app)).toEqual(['package.json', ...APP_FILES].sort());
    const manifest = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
    expect(Object.keys(manifest).sort()).toEqual(['description', 'lushRemote', 'main', 'name', 'type', 'version']);
    expect(manifest.lushRemote.lush_version).toBe(pkg.version);
    expect(manifest.lushRemote.fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(manifest.main).toBe('./src/ui/desktop/main.js');
    validateStage(app);
    expect(fs.existsSync(path.join(app, 'node_modules'))).toBe(false);
  });
  test('restaging discards stale staged files but preserves project state', () => {
    const { app } = stageDesktop(root);
    fs.writeFileSync(path.join(app, 'secret.txt'), 'stale');
    fs.mkdirSync(path.join(root, '.lush'));
    fs.writeFileSync(path.join(root, '.lush', 'keep'), 'project state');
    stageDesktop(root);
    expect(fs.existsSync(path.join(app, 'secret.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.lush', 'keep'), 'utf8')).toBe('project state');
  });
  test('the current connection page includes every local referenced asset', () => {
    const { app } = stageDesktop(root);
    const html = fs.readFileSync(path.join(app, 'src/ui/desktop/connection.html'), 'utf8');
    for (const [, asset] of html.matchAll(/(?:href|src)="(\.\/[^"#]+)"/g)) {
      expect(fs.existsSync(path.resolve(app, 'src/ui/desktop', asset))).toBe(true);
    }
    validateStage(app);
  });
  test('unreviewed static imports fail closed, including Bun-dependent local Host entry', () => {
    const { app } = stageDesktop(root);
    fs.appendFileSync(path.join(app, 'src/ui/desktop/main.js'), "import { createLocalHost } from './local-host.js';\n");
    expect(() => validateStage(app)).toThrow('Unpackaged static dependency');
  });
  test('unreviewed third-party modules fail closed', () => {
    const { app } = stageDesktop(root);
    fs.appendFileSync(path.join(app, 'src/ui/desktop/runtime.js'), "import 'unreviewed-package';\n");
    expect(() => validateStage(app)).toThrow('Unpackaged static dependency');
  });
  test.skipIf(process.platform === 'win32')('symlinked input and build directories are rejected', () => {
    const file = path.join(root, APP_FILES[0]), target = path.join(root, 'outside.js');
    fs.renameSync(file, target); fs.symlinkSync(target, file);
    expect(() => stageDesktop(root)).toThrow('Unsafe desktop source');
    fs.unlinkSync(file); fs.renameSync(target, file);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-build-outside-'));
    try {
      fs.rmSync(buildPaths(root).work, { recursive: true, force: true });
      fs.symlinkSync(outside, buildPaths(root).work);
      expect(() => stageDesktop(root)).toThrow('must not be a symlink');
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
  test('real ASAR is verified against the exact allowlist and staged bytes', async () => {
    const { archive, app } = await archiveStage();
    expect(verifyArchive(archive, app)).toEqual(['package.json', ...APP_FILES].sort());
    fs.appendFileSync(path.join(app, 'src/ui/desktop/connection.css'), '\n/* changed */');
    expect(() => verifyArchive(archive, app)).toThrow('differs from staged source');
  });
  test('packaged Release identity is sealed independently of the bundled payload', async () => {
    const { archive, app } = await archiveStage();
    const bad = path.join(root, 'tampered-app'); fs.cpSync(app, bad, { recursive: true });
    const file = path.join(bad, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(file));
    manifest.lushRemote.fingerprint = '0000000000000000';
    fs.writeFileSync(file, JSON.stringify(manifest));
    await createPackage(bad, archive);
    expect(() => verifyArchive(archive, app)).toThrow('Unexpected packaged manifest: lushRemote');
  });
  test('unexpected credential file in ASAR is rejected', async () => {
    const paths = stageDesktop(root);
    fs.mkdirSync(path.join(paths.app, '.lush'));
    fs.writeFileSync(path.join(paths.app, '.lush', 'web.json'), 'secret');
    fs.mkdirSync(path.dirname(paths.archive), { recursive: true });
    await createPackage(paths.app, paths.archive);
    expect(() => verifyArchive(paths.archive, paths.app)).toThrow('Unexpected application archive contents');
  });
  test('unpacked resources and manifest dependencies are rejected', async () => {
    const { archive, app } = await archiveStage();
    fs.mkdirSync(`${archive}.unpacked`);
    expect(() => verifyArchive(archive, app)).toThrow('Unexpected app.asar.unpacked');
    fs.rmSync(`${archive}.unpacked`, { recursive: true });
    const file = path.join(app, 'package.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), dependencies: { bun: '*' } }));
    await createPackage(app, archive);
    expect(() => verifyArchive(archive, app)).toThrow('Unexpected packaged manifest: dependencies');
  });
});

describe('Windows builder and delivery configuration', () => {
  test('fixed Electron version, x64 NSIS, non-elevated per-user install and no publishing', async () => {
    const config = builderConfig(root);
    expect(config.electronVersion).toBe(pkg.devDependencies.electron);
    expect(config.electronVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies['electron-builder']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies['@electron/asar']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(config.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
    expect(config.nsis.perMachine).toBe(false);
    expect(config.nsis.allowElevation).toBe(false);
    expect(config.win.requestedExecutionLevel).toBe('asInvoker');
    expect(config.publish).toBe(null);
    expect(config.files).toEqual(['package.json', ...APP_FILES]);
    expect(config.extraResources).toEqual([{ from: path.join(root, DESKTOP_PAYLOAD_DIR), to: 'remote-payload', filter: [...REMOTE_RESOURCE_FILES] }]);
    expect(config.directories.output).toBe(path.join(root, BUILD_DIR, 'dist'));
    // Validate against the actual pinned electron-builder schema, not a mock.
    const { validateConfiguration } = await import('app-builder-lib/out/util/config/config.js');
    const { DebugLogger } = await import('builder-util');
    await validateConfiguration(config, new DebugLogger());
  });
  test('afterPack verifies the archive and rejects other platforms', async () => {
    const { archive } = await archiveStage();
    const config = builderConfig(root);
    const appOutDir = path.dirname(path.dirname(archive));
    await expect(config.afterPack({ electronPlatformName: 'win32', appOutDir })).rejects.toThrow();
    createRemotePayload(root, path.join(root, 'node_modules/lush-remote-build/payload'));
    const staged = stageDesktopRemotePayload(root);
    fs.cpSync(staged, path.join(appOutDir, 'resources/remote-payload'), { recursive: true });
    await config.afterPack({ electronPlatformName: 'win32', appOutDir });
    await expect(config.afterPack({ electronPlatformName: 'linux' })).rejects.toThrow('matching desktop packaging');
  });
  test('installer checksum has an unambiguous filename and SHA-256', () => {
    const output = buildPaths(root).output;
    fs.mkdirSync(output, { recursive: true });
    expect(() => writeChecksums(output)).toThrow('exactly one');
    const file = `Lush-${pkg.version}-windows-x64-setup.exe`;
    fs.writeFileSync(path.join(output, file), 'fixture, not an actual installer');
    expect(writeChecksums(output)).toEqual([file]);
    const hash = createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex');
    expect(fs.readFileSync(path.join(output, 'SHA256SUMS.txt'), 'utf8')).toBe(`${hash}  ${file}\n`);
    fs.writeFileSync(path.join(output, 'Lush-old-windows-x64-setup.exe'), 'stale');
    expect(() => writeChecksums(output)).toThrow('exactly one');
  });
  test('Windows workflow builds and checks actual installer before artifact upload, without release credentials', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/windows-desktop.yml'), 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('runs-on: windows-2022');
    expect(workflow).toContain('bun install --frozen-lockfile');
    expect(workflow).toContain('contents: read');
    expect(workflow).not.toContain('contents: write');
    expect(workflow).not.toContain('secrets.');
    expect(workflow.indexOf('bun run desktop:build:win')).toBeLessThan(workflow.indexOf('bun run desktop:verify:win'));
    expect(workflow.indexOf('bun run desktop:verify:win')).toBeLessThan(workflow.indexOf('actions/upload-artifact@v4'));
    expect(workflow).toContain('if-no-files-found: error');
    expect(workflow).toContain('SHA256SUMS.txt');
    expect(workflow).toContain('uses: ./.github/workflows/remote-payload.yml');
    expect(workflow).toContain('needs: remote-payload');
    expect(workflow).toContain('name: lush-remote-payload');
  });
});
