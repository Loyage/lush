import path from 'node:path';
import os from 'node:os';
import { launcherStateDir } from '../host/registry.js';
import { digest } from '../administrator/paths.js';
export { digest, sameSecret, assertPrivateDirectory, ensurePrivateDirectory, assertPrivateFile, readControlSecret, writePrivateJSON } from '../administrator/paths.js';
export const deviceValetHome = (env = process.env) => path.join(launcherStateDir(env), 'shared', 'device-valet');
export function deviceValetPaths(home = deviceValetHome()) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('absolute device Valet home required');
  home = path.resolve(home);
  const socketDir = path.join(os.tmpdir(), `lush-${process.getuid()}`);
  return { home, database: path.join(home, 'device-valet.sqlite'), control: path.join(home, 'control.key'), descriptor: path.join(home, 'runtime.json'), socketDir,
    socket: path.join(socketDir, `device-valet-${digest(home).slice(0,24)}.sock`) };
}
