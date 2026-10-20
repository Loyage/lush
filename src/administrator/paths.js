import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { launcherStateDir } from '../host/registry.js';
import { check } from '../core/types.js';

export const administratorHome = (env = process.env) => path.join(launcherStateDir(env), 'shared', 'administrator');
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export function sameSecret(left, right) {
  return typeof left === 'string' && typeof right === 'string' && timingSafeEqual(Buffer.from(digest(left), 'hex'), Buffer.from(digest(right), 'hex'));
}
export function administratorPaths(home = administratorHome()) {
  check(typeof home === 'string' && path.isAbsolute(home), 'absolute administrator home required');
  home = path.resolve(home);
  const socketDir = path.join(os.tmpdir(), `lush-${process.getuid()}`);
  return { home, database: path.join(home, 'administrator.sqlite'), control: path.join(home, 'control.key'),
    descriptor: path.join(home, 'runtime.json'), socketDir,
    socket: path.join(socketDir, `administrator-${digest(home).slice(0, 24)}.sock`) };
}
export function assertPrivateDirectory(dir) {
  const stat = fs.lstatSync(dir);
  check(!stat.isSymbolicLink() && stat.isDirectory() && stat.uid === process.getuid()
    && (stat.mode & 0o077) === 0 && fs.realpathSync(dir) === path.resolve(dir), 'unsafe administrator directory');
  return stat;
}
export function ensurePrivateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return assertPrivateDirectory(dir);
}
export function assertPrivateFile(file, { missing = false, socket = false } = {}) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
  check(!stat.isSymbolicLink() && (socket ? stat.isSocket() : stat.isFile() && stat.nlink === 1)
    && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'unsafe administrator private file');
  return stat;
}
export function readControlSecret(paths, create = false) {
  assertPrivateDirectory(paths.home);
  const stat = assertPrivateFile(paths.control, { missing: true });
  if (!stat) {
    check(create, 'administrator control credential is unavailable');
    fs.writeFileSync(paths.control, `${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
  }
  const fd = fs.openSync(paths.control, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    check(opened.isFile() && opened.nlink === 1 && opened.uid === process.getuid() && (opened.mode & 0o077) === 0 && opened.size <= 128,
      'unsafe administrator control credential');
    const secret = fs.readFileSync(fd, 'utf8').trim();
    check(/^[A-Za-z0-9_-]{43}$/.test(secret), 'invalid administrator control credential');
    return secret;
  } finally { fs.closeSync(fd); }
}
export function writePrivateJSON(file, value) {
  assertPrivateDirectory(path.dirname(file));
  assertPrivateFile(file, { missing: true });
  const temporary = `${file}.${randomBytes(10).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
