import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { listPackage, statFile, extractFile, uncache } from '@electron/asar';
import { DESKTOP_PAYLOAD_DIR, REMOTE_RESOURCE_FILES, stageDesktopRemotePayload, verifyDesktopRemotePayload } from './desktop-remote-payload.js';
import { LOCAL_RUNTIME_DIR, stageDesktopLocalRuntime, verifyDesktopLocalRuntime } from './desktop-local-runtime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Generated output stays in ignored node_modules, never in a project's .lush directory.
export const BUILD_DIR = 'node_modules/lush-desktop-build';
export const APP_FILES = Object.freeze([
  'src/ui/desktop/main.js',
  'src/ui/desktop/runtime.js',
  'src/ui/desktop/connections.js',
  'src/ui/desktop/ssh.js',
  'src/ui/desktop/ssh-config.js',
  'src/ui/desktop/ssh-scripts.js',
  'src/ui/desktop/ssh-payload.js',
  'src/ui/desktop/preload.cjs',
  'src/ui/desktop/connection-preload.cjs',
  'src/ui/desktop/connection.html',
  'src/ui/desktop/connection.js',
  'src/ui/desktop/connection.css',
  'src/ui/web/assets/help.js',
]);
const MANIFEST_KEYS = ['name', 'version', 'description', 'type', 'main'];

export function desktopFiles(platform = 'win32') {
  if (!['win32', 'darwin'].includes(platform)) throw new Error('Only Windows and macOS desktop packaging is supported');
  return platform === 'darwin' ? [...APP_FILES, 'src/ui/desktop/local-host.js'] : [...APP_FILES];
}

export function buildPaths(root = ROOT, platform = 'win32', arch = platform === 'darwin' ? process.arch : 'x64') {
  desktopFiles(platform);
  if (!['x64', 'arm64'].includes(arch) || (platform === 'win32' && arch !== 'x64')) throw new Error('Unsupported desktop architecture');
  const work = path.join(root, BUILD_DIR), output = path.join(work, 'dist');
  const resources = platform === 'win32' ? path.join(output, 'win-unpacked', 'resources')
    : path.join(output, arch === 'arm64' ? 'mac-arm64' : 'mac', 'Lush.app', 'Contents', 'Resources');
  return { work, app: path.join(work, 'app'), output, resources, archive: path.join(resources, 'app.asar') };
}

function rejectSymlink(file) {
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Build path must not be a symlink: ${file}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Copy an explicit allowlist, with a new manifest containing no CLI/bin/dependencies or credentials. */
export function stageDesktop(root = ROOT, platform = 'win32') {
  const files = desktopFiles(platform);
  const paths = buildPaths(root, platform);
  for (const part of ['node_modules', BUILD_DIR, `${BUILD_DIR}/app`, `${BUILD_DIR}/dist`]) rejectSymlink(path.join(root, part));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('Invalid desktop version');
  const manifest = Object.fromEntries(MANIFEST_KEYS.map(key => [key, pkg[key]]));
  if (manifest.main !== './src/ui/desktop/main.js' || manifest.type !== 'module') throw new Error('Unexpected Electron entry point');
  fs.rmSync(paths.app, { recursive: true, force: true });
  fs.mkdirSync(paths.app, { recursive: true });
  fs.writeFileSync(path.join(paths.app, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of files) {
    const source = path.resolve(root, file);
    if (fs.realpathSync(source) !== source || !fs.statSync(source).isFile()) throw new Error(`Unsafe desktop source: ${file}`);
    const target = path.join(paths.app, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return paths;
}

/** Fail closed when a new static module dependency has not been reviewed for inclusion. */
export function validateStage(app, platform = 'win32') {
  const files = desktopFiles(platform), allowed = new Set(files);
  for (const file of files.filter(value => /\.(?:js|cjs)$/.test(value))) {
    const text = fs.readFileSync(path.join(app, file), 'utf8');
    const imports = text.matchAll(/(?:\bfrom\s*|\bimport\s*|\brequire\(\s*)['"]([^'"]+)['"]/g);
    for (const [, specifier] of imports) {
      if (specifier === 'electron' || specifier.startsWith('node:')) continue;
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (!specifier.startsWith('.') || !allowed.has(dependency)) throw new Error(`Unpackaged static dependency: ${file} -> ${specifier}`);
    }
  }
}

/** An independent archive check, used by afterPack and CI before uploading any installer. */
export function verifyArchive(archive, app, platform = 'win32') {
  const files = desktopFiles(platform);
  validateStage(app, platform);
  uncache(archive); // Re-read headers when the same output path was rebuilt in this process.
  const expected = new Set(['package.json', ...files]);
  const actual = new Set();
  for (const entry of listPackage(archive, {})) {
    const file = entry.replaceAll('\\', '/').replace(/^\//, '');
    const stat = statFile(archive, file, false);
    if (stat.link || stat.unpacked) throw new Error(`Linked or unpacked application entry: ${file}`);
    if (!stat.files) actual.add(file);
  }
  if (actual.size !== expected.size || [...actual].some(file => !expected.has(file))) {
    throw new Error(`Unexpected application archive contents: ${[...actual].join(', ')}`);
  }
  const manifest = JSON.parse(extractFile(archive, 'package.json').toString());
  const staged = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
  for (const key of MANIFEST_KEYS) if (manifest[key] !== staged[key]) throw new Error(`Unexpected packaged manifest: ${key}`);
  for (const key of ['dependencies', 'devDependencies', 'bin', 'exports', 'scripts']) if (manifest[key]) throw new Error(`Unexpected packaged manifest: ${key}`);
  for (const file of files) {
    if (!extractFile(archive, file).equals(fs.readFileSync(path.join(app, file)))) throw new Error(`Packaged file differs from staged source: ${file}`);
  }
  if (fs.existsSync(`${archive}.unpacked`)) throw new Error('Unexpected app.asar.unpacked directory');
  return [...actual].sort();
}

export function builderConfig(root = ROOT, platform = 'win32', arch = platform === 'darwin' ? process.arch : 'x64') {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const paths = buildPaths(root, platform, arch), files = desktopFiles(platform);
  return {
    appId: 'dev.lush.desktop', productName: 'Lush', electronVersion: pkg.devDependencies.electron,
    directories: { app: paths.app, output: paths.output },
    files: ['package.json', ...files], asar: true, npmRebuild: false,
    extraResources: [
      { from: path.join(root, DESKTOP_PAYLOAD_DIR), to: 'remote-payload', filter: [...REMOTE_RESOURCE_FILES] },
      ...(platform === 'darwin' ? [{ from: path.join(root, LOCAL_RUNTIME_DIR), to: 'local-runtime', filter: ['**/*'] }] : []),
    ],
    forceCodeSigning: false, publish: null,
    artifactName: platform === 'darwin' ? 'Lush-${version}-macos-${arch}.${ext}' : 'Lush-${version}-windows-${arch}-setup.${ext}',
    mac: { target: [{ target: 'zip', arch: [arch] }], identity: null, notarize: false, hardenedRuntime: false, category: 'public.app-category.developer-tools' },
    win: { target: [{ target: 'nsis', arch: ['x64'] }], requestedExecutionLevel: 'asInvoker' },
    nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
      createDesktopShortcut: false, createStartMenuShortcut: true, shortcutName: 'Lush' },
    afterPack: async context => {
      if (context.electronPlatformName !== platform) throw new Error('Only Windows and macOS matching desktop packaging is supported');
      const resources = platform === 'darwin' ? path.join(context.appOutDir, 'Lush.app', 'Contents', 'Resources') : path.join(context.appOutDir, 'resources');
      verifyArchive(path.join(resources, 'app.asar'), paths.app, platform);
      verifyDesktopRemotePayload(root, path.join(resources, 'remote-payload'), { stagedDir: path.join(root, DESKTOP_PAYLOAD_DIR) });
      if (platform === 'darwin') verifyDesktopLocalRuntime(root, path.join(resources, 'local-runtime'), { arch, stagedDir: path.join(root, LOCAL_RUNTIME_DIR) });
    },
  };
}

export function writeChecksums(output, platform = 'win32', arch = platform === 'darwin' ? process.arch : 'x64') {
  desktopFiles(platform);
  if (!['x64', 'arm64'].includes(arch) || (platform === 'win32' && arch !== 'x64')) throw new Error('Unsupported desktop architecture');
  const pattern = platform === 'darwin' ? new RegExp(`^Lush-.*-macos-${arch}\\.zip$`) : /^Lush-.*-windows-x64-setup\.exe$/;
  const installers = fs.readdirSync(output).filter(file => pattern.test(file)).sort();
  if (installers.length !== 1) throw new Error('Expected exactly one matching desktop artifact');
  const checksum = installers.map(file => `${createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex')}  ${file}`).join('\n');
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${checksum}\n`);
  return installers;
}

async function main(args) {
  const mode = args.shift();
  let platform = 'win32', arch = 'x64', bun = process.execPath;
  while (args.length) {
    const key = args.shift(), value = args.shift();
    if (!value || !['--platform', '--arch', '--bun'].includes(key)) throw new Error('Expected --platform, --arch or --bun with a value');
    if (key === '--platform') { platform = value; arch = platform === 'darwin' ? process.arch : 'x64'; }
    if (key === '--arch') arch = value;
    if (key === '--bun') bun = value;
  }
  const paths = buildPaths(ROOT, platform, arch);
  const verify = (smoke = false) => {
    const entries = verifyArchive(paths.archive, paths.app, platform);
    verifyDesktopRemotePayload(ROOT, path.join(paths.resources, 'remote-payload'), { stagedDir: path.join(ROOT, DESKTOP_PAYLOAD_DIR) });
    if (platform === 'darwin') verifyDesktopLocalRuntime(ROOT, path.join(paths.resources, 'local-runtime'), { arch, stagedDir: path.join(ROOT, LOCAL_RUNTIME_DIR), smoke });
    writeChecksums(paths.output, platform, arch);
    return entries;
  };
  if (mode === '--stage' || mode === '--build') {
    if (platform === 'darwin' && (process.platform !== platform || process.arch !== arch)) throw new Error('macOS local runtime builds require the native target platform and architecture');
    if (mode === '--build' && process.platform !== platform) throw new Error('Build on the target Windows / macOS platform, or use its CI workflow');
    stageDesktop(ROOT, platform); validateStage(paths.app, platform); stageDesktopRemotePayload(ROOT);
    if (platform === 'darwin') stageDesktopLocalRuntime(ROOT, { bun, arch });
    if (mode === '--stage') { console.log(`Desktop application and verified runtimes staged: ${paths.app}`); return; }
    fs.rmSync(paths.output, { recursive: true, force: true });
    // electron-builder runs under Node, not Bun; the installed application uses Electron's own runtime.
    const child = spawnSync('node', [fileURLToPath(import.meta.url), '--builder', '--platform', platform, '--arch', arch], {
      cwd: ROOT, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`electron-builder failed (${child.status ?? child.signal})`);
    verify(platform === 'darwin');
    console.log(`Unsigned ${platform} ${arch} desktop artifact: ${paths.output}`); return;
  }
  if (mode === '--verify') {
    const entries = verify(platform === 'darwin');
    console.log(`Verified ${entries.length} application files and runtime resources; artifact checksum written.`); return;
  }
  if (mode === '--builder' && process.platform === platform) {
    const { build, Platform, Arch } = await import('electron-builder');
    const target = platform === 'darwin' ? Platform.MAC : Platform.WINDOWS;
    await build({ targets: target.createTarget([platform === 'darwin' ? 'zip' : 'nsis'], arch === 'arm64' ? Arch.arm64 : Arch.x64), config: builderConfig(ROOT, platform, arch), publish: 'never' }); return;
  }
  throw new Error('Usage: bun run scripts/build-desktop.js --stage|--build|--verify [--platform win32|darwin] [--arch x64|arm64] [--bun PATH]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
