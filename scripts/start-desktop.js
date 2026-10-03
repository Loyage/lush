import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { desktopPayloadWarning } from './prepare-desktop.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const warning = desktopPayloadWarning(root);
if (warning) console.warn(warning);
try {
  const electron = createRequire(import.meta.url)('electron');
  const result = spawnSync(electron, [root, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) { console.error(`无法启动 Electron：${error.message}`); process.exitCode = 1; }
