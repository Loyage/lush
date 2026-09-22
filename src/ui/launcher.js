import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from '../core/types.js';

const STATE_FILE = 'launcher.json';

/** 全局启动器状态不属于任何项目，也不是 LUSH_HOME。 */
export function launcherStateDir(env = process.env, platform = process.platform, homedir = os.homedir()) {
  if (env.LUSH_GLOBAL_CONFIG) return path.resolve(env.LUSH_GLOBAL_CONFIG);
  if (platform === 'win32') return path.join(env.APPDATA || path.join(homedir, 'AppData', 'Roaming'), 'Lush');
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Application Support', 'Lush');
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir, '.config'), 'lush');
}

export function launcherStateFile(env = process.env) {
  return path.join(launcherStateDir(env), STATE_FILE);
}

function safeStateDir(env) {
  const dir = launcherStateDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  check(!stat.isSymbolicLink() && stat.isDirectory(), `unsafe global state directory: ${dir}`);
  if (typeof process.getuid !== 'function' || stat.uid === process.getuid()) fs.chmodSync(dir, 0o700);
  else throw new Error(`unsafe global state directory: ${dir}`);
  return dir;
}

export function readLauncherState(env = process.env) {
  try {
    const value = JSON.parse(fs.readFileSync(launcherStateFile(env), 'utf8'));
    if (!value || value.version !== 1 || typeof value.last_project !== 'string' || !path.isAbsolute(value.last_project)) return { version: 1, last_project: null };
    return { version: 1, last_project: value.last_project };
  } catch { return { version: 1, last_project: null }; }
}

export function writeLauncherState(project, env = process.env) {
  const dir = safeStateDir(env);
  const file = path.join(dir, STATE_FILE);
  const value = { version: 1, last_project: project };
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally { fs.rmSync(temporary, { force: true }); }
  return value;
}

/** 用户输入必须明确指向一个现存目录；`~` 只作为输入便利展开。 */
export function canonicalProjectPath(value, env = process.env, homedir = os.homedir()) {
  check(typeof value === 'string' && value.trim(), '请选择项目目录');
  const raw = value.trim();
  const expanded = raw === '~' ? homedir : raw.startsWith('~/') || raw.startsWith('~\\') ? path.join(homedir, raw.slice(2)) : raw;
  check(path.isAbsolute(expanded), '项目路径必须是绝对路径');
  let project;
  try { project = fs.realpathSync(expanded); } catch { throw new Error(`项目目录不存在：${expanded}`); }
  check(fs.statSync(project).isDirectory(), `项目路径不是目录：${project}`);
  return project;
}

/** 给无项目 Web 启动器使用的控制配置；home 只放启动器日志/进程状态，不冒充 LUSH_HOME。 */
export function launcherWebConfig(env = process.env) {
  const home = launcherStateDir(env);
  const childEnv = { ...env, LUSH_WEB_LAUNCHER: '1' };
  delete childEnv.LUSH_PROJECT;
  delete childEnv.LUSH_HOME;
  return { launcher: true, project: null, home, env: childEnv };
}
