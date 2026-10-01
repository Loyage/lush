import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { listPackage, statFile, extractFile, uncache } from '@electron/asar';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Generated output stays in ignored node_modules, never in a project's .lush directory.
export const BUILD_DIR = 'node_modules/lush-desktop-build';
export const APP_FILES = Object.freeze([
  'src/ui/desktop/main.js',
  'src/ui/desktop/runtime.js',
  'src/ui/desktop/connections.js',
  'src/ui/desktop/preload.cjs',
  'src/ui/desktop/connection-preload.cjs',
  'src/ui/desktop/connection.html',
  'src/ui/desktop/connection.js',
  'src/ui/desktop/connection.css',
  'src/ui/web/assets/help.js',
]);
const MANIFEST_KEYS = ['name', 'version', 'description', 'type', 'main'];

export function buildPaths(root = ROOT) {
  const work = path.join(root, BUILD_DIR);
  return { work, app: path.join(work, 'app'), output: path.join(work, 'dist'),
    archive: path.join(work, 'dist', 'win-unpacked', 'resources', 'app.asar') };
}

function rejectSymlink(file) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`Build path must not be a symlink: ${file}`);
}

/** Copy an explicit allowlist, with a new manifest containing no CLI/bin/dependencies or credentials. */
export function stageDesktop(root = ROOT) {
  const paths = buildPaths(root);
  for (const part of ['node_modules', BUILD_DIR, `${BUILD_DIR}/app`, `${BUILD_DIR}/dist`]) rejectSymlink(path.join(root, part));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('Invalid desktop version');
  const manifest = Object.fromEntries(MANIFEST_KEYS.map(key => [key, pkg[key]]));
  if (manifest.main !== './src/ui/desktop/main.js' || manifest.type !== 'module') throw new Error('Unexpected Electron entry point');
  fs.rmSync(paths.app, { recursive: true, force: true });
  fs.mkdirSync(paths.app, { recursive: true });
  fs.writeFileSync(path.join(paths.app, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of APP_FILES) {
    const source = path.resolve(root, file);
    if (fs.realpathSync(source) !== source || !fs.statSync(source).isFile()) throw new Error(`Unsafe desktop source: ${file}`);
    const target = path.join(paths.app, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return paths;
}

/** Fail closed when a new static module dependency has not been reviewed for inclusion. */
export function validateStage(app) {
  const allowed = new Set(APP_FILES);
  for (const file of APP_FILES.filter(value => /\.(?:js|cjs)$/.test(value))) {
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
export function verifyArchive(archive, app) {
  validateStage(app);
  uncache(archive); // Re-read headers when the same output path was rebuilt in this process.
  const expected = new Set(['package.json', ...APP_FILES]);
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
  for (const file of APP_FILES) {
    if (!extractFile(archive, file).equals(fs.readFileSync(path.join(app, file)))) throw new Error(`Packaged file differs from staged source: ${file}`);
  }
  if (fs.existsSync(`${archive}.unpacked`)) throw new Error('Unexpected app.asar.unpacked directory');
  return [...actual].sort();
}

export function builderConfig(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const paths = buildPaths(root);
  return {
    appId: 'dev.lush.desktop', productName: 'Lush', electronVersion: pkg.devDependencies.electron,
    directories: { app: paths.app, output: paths.output },
    files: ['package.json', ...APP_FILES], asar: true, npmRebuild: false,
    forceCodeSigning: false, publish: null,
    artifactName: 'Lush-${version}-windows-${arch}-setup.${ext}',
    win: { target: [{ target: 'nsis', arch: ['x64'] }], requestedExecutionLevel: 'asInvoker' },
    nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
      createDesktopShortcut: false, createStartMenuShortcut: true, shortcutName: 'Lush' },
    afterPack: async context => {
      if (context.electronPlatformName !== 'win32') throw new Error('Only Windows desktop packaging is supported');
      verifyArchive(path.join(context.appOutDir, 'resources', 'app.asar'), paths.app);
    },
  };
}

export function writeChecksums(output) {
  const installers = fs.readdirSync(output).filter(file => /^Lush-.*-windows-x64-setup\.exe$/.test(file)).sort();
  if (installers.length !== 1) throw new Error('Expected exactly one Windows x64 NSIS installer');
  const checksum = installers.map(file => `${createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex')}  ${file}`).join('\n');
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${checksum}\n`);
  return installers;
}

async function main(mode) {
  const paths = buildPaths();
  if (mode === '--stage') { stageDesktop(); console.log(`Desktop application staged: ${paths.app}`); return; }
  if (mode === '--verify') {
    const entries = verifyArchive(paths.archive, paths.app);
    writeChecksums(paths.output);
    console.log(`Verified ${entries.length} application files; installer checksum written.`); return;
  }
  if (mode === '--build') {
    if (process.platform !== 'win32') throw new Error('Run desktop:build:win on Windows (or use the Windows CI workflow); Linux staging is not a Windows runtime verification.');
    stageDesktop(); validateStage(paths.app);
    fs.rmSync(paths.output, { recursive: true, force: true });
    // electron-builder runs under Node, not Bun; the installed application uses Electron's own runtime.
    const child = spawnSync('node', [fileURLToPath(import.meta.url), '--builder'], {
      cwd: ROOT, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`electron-builder failed (${child.status ?? child.signal})`);
    verifyArchive(paths.archive, paths.app); writeChecksums(paths.output);
    console.log(`Unsigned Windows x64 NSIS installer: ${paths.output}`); return;
  }
  if (mode === '--builder' && process.platform === 'win32') {
    const { build, Platform, Arch } = await import('electron-builder');
    await build({ targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config: builderConfig(), publish: 'never' }); return;
  }
  throw new Error('Usage: bun scripts/build-desktop.js --stage|--build|--verify');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
