import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPackage } from '@electron/asar';
import { desktopFiles, buildPaths, stageDesktop, validateStage, verifyArchive, builderConfig, writeChecksums } from '../../scripts/build-desktop.js';
import { stageDesktopRemotePayload } from '../../scripts/desktop-remote-payload.js';
import { LOCAL_RUNTIME_DIR } from '../../scripts/desktop-local-runtime.js';
import { createRemotePayload } from './remote-fixture.js';
import { createLocalRuntime } from './macos-runtime-fixture.js';
const ROOT = path.resolve(import.meta.dir, '../..');
let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-macos-desktop-')));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  for (const file of desktopFiles('darwin')) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  createRemotePayload(root, path.join(root, 'node_modules/lush-remote-build/payload'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('macOS ASAR includes reviewed local-host and SSH configuration without duplicating backend or Bun', async () => {
  stageDesktop(root, 'darwin');
  const paths = buildPaths(root, 'darwin', 'arm64');
  validateStage(paths.app, 'darwin');
  expect(desktopFiles('darwin')).toContain('src/ui/desktop/local-host.js');
  expect(desktopFiles('win32')).not.toContain('src/ui/desktop/local-host.js');
  expect(desktopFiles('win32')).toContain('src/ui/desktop/ssh-config.js');
  fs.mkdirSync(paths.resources, { recursive: true });
  await createPackage(paths.app, paths.archive);
  expect(verifyArchive(paths.archive, paths.app, 'darwin')).toEqual(['package.json', ...desktopFiles('darwin')].sort());
  fs.appendFileSync(path.join(paths.app, 'src/ui/desktop/local-host.js'), '\n// changed\n');
  expect(() => verifyArchive(paths.archive, paths.app, 'darwin')).toThrow('differs from staged source');
  expect(() => desktopFiles('linux')).toThrow('Only Windows and macOS');
});

test('macOS configuration is native ZIP, unsigned/unnotarized and carries separate local and dual-Linux runtimes', async () => {
  const { validateConfiguration } = await import('app-builder-lib/out/util/config/config.js');
  const { DebugLogger } = await import('builder-util');
  for (const arch of ['x64', 'arm64']) {
    const config = builderConfig(root, 'darwin', arch);
    expect(config.mac.target).toEqual([{ target: 'zip', arch: [arch] }]);
    expect(config.mac.identity).toBe(null);
    expect(config.mac.notarize).toBe(false);
    expect(config.forceCodeSigning).toBe(false);
    expect(config.publish).toBe(null);
    expect(config.extraResources.map(row => row.to)).toEqual(['remote-payload', 'local-runtime']);
    expect(config.artifactName).toBe('Lush-${version}-macos-${arch}.${ext}');
    await validateConfiguration(config, new DebugLogger());
  }
  expect(builderConfig(root).extraResources.map(row => row.to)).toEqual(['remote-payload']);
});

test('macOS afterPack verifies ASAR, complete Linux resources and local runtime bytes before delivery', async () => {
  stageDesktop(root, 'darwin');
  const paths = buildPaths(root, 'darwin', 'arm64');
  fs.mkdirSync(paths.resources, { recursive: true });
  await createPackage(paths.app, paths.archive);
  const remote = stageDesktopRemotePayload(root);
  const local = path.join(root, LOCAL_RUNTIME_DIR); createLocalRuntime(root, local);
  fs.cpSync(remote, path.join(paths.resources, 'remote-payload'), { recursive: true });
  fs.cpSync(local, path.join(paths.resources, 'local-runtime'), { recursive: true });
  const config = builderConfig(root, 'darwin', 'arm64');
  const context = { electronPlatformName: 'darwin', appOutDir: path.join(paths.output, 'mac-arm64') };
  await config.afterPack(context);
  fs.appendFileSync(path.join(paths.resources, 'local-runtime/bun'), 'corrupt');
  await expect(config.afterPack(context)).rejects.toThrow('checksum mismatch');
  await expect(config.afterPack({ electronPlatformName: 'win32' })).rejects.toThrow('matching desktop packaging');
});

test('macOS ZIP checksum is architecture-specific and rejects missing or ambiguous artifacts', () => {
  const paths = buildPaths(root, 'darwin', 'arm64'); fs.mkdirSync(paths.output, { recursive: true });
  const file = 'Lush-0.2.0-macos-arm64.zip';
  expect(() => writeChecksums(paths.output, 'darwin', 'arm64')).toThrow('exactly one');
  fs.writeFileSync(path.join(paths.output, file), 'not an actual macOS bundle');
  fs.writeFileSync(path.join(paths.output, 'Lush-0.2.0-macos-x64.zip'), 'other architecture');
  expect(writeChecksums(paths.output, 'darwin', 'arm64')).toEqual([file]);
  expect(fs.readFileSync(path.join(paths.output, 'SHA256SUMS.txt'), 'utf8')).toMatch(new RegExp(`^[a-f0-9]{64}  ${file.replaceAll('.', '\\.')}\\n$`));
  fs.writeFileSync(path.join(paths.output, 'Lush-old-macos-arm64.zip'), 'stale');
  expect(() => writeChecksums(paths.output, 'darwin', 'arm64')).toThrow('exactly one');
});

test('packaged macOS selects private runtime paths instead of PATH Bun and CI never publishes or signs', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src/ui/desktop/main.js'), 'utf8');
  expect(main).toContain("path.join(process.resourcesPath, 'local-runtime')");
  expect(main).toContain("bun: path.join(runtimeRoot, 'bun')");
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/macos-desktop.yml'), 'utf8');
  expect(workflow).toContain('runner: macos-15');
  expect(workflow).toContain('runner: macos-15-intel');
  expect(workflow).toContain('uses: ./.github/workflows/remote-payload.yml');
  expect(workflow).toContain('needs: remote-payload');
  expect(workflow).toContain('contents: read');
  expect(workflow).not.toContain('contents: write');
  expect(workflow).not.toContain('secrets.');
  expect(workflow.indexOf('bun run desktop:build:mac')).toBeLessThan(workflow.indexOf('bun run desktop:verify:mac'));
  expect(workflow.indexOf('bun run desktop:verify:mac')).toBeLessThan(workflow.indexOf('actions/upload-artifact@v4'));
  expect(workflow).toContain('SHA256SUMS.txt');
});
