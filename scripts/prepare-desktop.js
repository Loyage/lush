import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_DIR } from './build-remote.js';
import { REMOTE_RESOURCE_FILES, verifyDesktopRemotePayload } from './desktop-remote-payload.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function destination(root) {
  const directory = path.join(path.resolve(root), BUILD_DIR);
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Payload destination must not be a symlink: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return directory;
}

/** The caller chooses a trusted artifact. Hashes establish integrity, not publisher trust. */
export function prepareDesktopPayload(root = ROOT, { payloadDir, replace = false } = {}) {
  if (!payloadDir) throw new Error('Usage: bun run desktop:prepare /path/to/trusted-payload [--replace]');
  const manifest = verifyDesktopRemotePayload(root, payloadDir);
  const directory = destination(root);
  if (path.resolve(payloadDir) === directory) return { directory, manifest };
  if (fs.existsSync(directory)) {
    if (!replace) {
      verifyDesktopRemotePayload(root, directory, { stagedDir: payloadDir });
      return { directory, manifest };
    }
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('Payload destination is not a directory');
  }
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(directory), 'payload-import-'));
  let backup = null;
  try {
    for (const name of REMOTE_RESOURCE_FILES) fs.copyFileSync(path.join(payloadDir, name), path.join(temporary, name));
    verifyDesktopRemotePayload(root, temporary, { stagedDir: payloadDir });
    if (fs.existsSync(directory)) {
      backup = `${temporary}-previous`;
      fs.renameSync(directory, backup);
    }
    try { fs.renameSync(temporary, directory); }
    catch (error) { if (backup) fs.renameSync(backup, directory); throw error; }
    if (backup) fs.rmSync(backup, { recursive: true, force: true });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  return { directory, manifest };
}

export function desktopPayloadWarning(root = ROOT) {
  try { verifyDesktopRemotePayload(root, path.join(root, BUILD_DIR)); return null; }
  catch (error) {
    return `SSH 自动部署运行包尚未就绪：${error.message}\n请从可信的同源码 CI 运行下载 lush-remote-payload，解压后执行 bun run desktop:prepare /path/to/payload（替换旧生成物时显式加 --replace）。\n不会自动下载或在 Mac / Windows 构建 Linux 程序。本地与“远程 Host”入口仍可使用。详见 docs/deployment/desktop-build-agent.md。`;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 1 || args.length > 2 || args[0].startsWith('--') || (args[1] && args[1] !== '--replace')) throw new Error('Usage: bun run desktop:prepare DIR [--replace]');
    const result = prepareDesktopPayload(ROOT, { payloadDir: args[0], replace: args[1] === '--replace' });
    console.log(`Prepared Linux x64 / ARM64 payloads (${result.manifest.fingerprint}): ${result.directory}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
