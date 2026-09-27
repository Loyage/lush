import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { check } from '../core/types.js';

const STATE_FILE = 'launcher.json';
const STATE_VERSION = 2;

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

function emptyState() { return { version: STATE_VERSION, last_project: null, projects: [] }; }

/**
 * 全局启动器状态：只是界面元数据（已登记路径、顺序、最后打开），不复制 Task 或 `.lush` 数据。
 * 读 v1 老文件时把它的 `last_project` 提升成登记项——旧 Web 进程留下的选择仍然可恢复，
 * 不重写任何项目的 `.lush`，也不丢用户已经打开过的目录。
 */
export function readLauncherState(env = process.env) {
  let value;
  try { value = JSON.parse(fs.readFileSync(launcherStateFile(env), 'utf8')); } catch { return emptyState(); }
  if (!value || typeof value !== 'object') return emptyState();
  const last = typeof value.last_project === 'string' && path.isAbsolute(value.last_project) ? value.last_project : null;
  const projects = [];
  for (const entry of Array.isArray(value.projects) ? value.projects : []) {
    if (typeof entry !== 'string' || !path.isAbsolute(entry) || projects.includes(entry)) continue;
    projects.push(entry);
  }
  if (last && !projects.includes(last)) projects.push(last);
  return { version: STATE_VERSION, last_project: last, projects };
}

function writeState(value, env) {
  const dir = safeStateDir(env);
  const file = path.join(dir, STATE_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally { fs.rmSync(temporary, { force: true }); }
  return value;
}

/** 记下最后打开的项目；同时把它登记进项目列表（首次选择即登记）。 */
export function writeLauncherState(project, env = process.env) {
  const state = readLauncherState(env);
  const projects = state.projects.includes(project) ? state.projects : [...state.projects, project];
  return writeState({ version: STATE_VERSION, last_project: project, projects }, env);
}

/** 从列表移除：只删入口并（由调用方）断开连接，不停止 daemon；停 daemon 走显式项目命令。 */
export function removeLauncherProject(project, env = process.env) {
  const state = readLauncherState(env);
  return writeState({ version: STATE_VERSION,
    last_project: state.last_project === project ? null : state.last_project,
    projects: state.projects.filter(entry => entry !== project) }, env);
}

/**
 * 项目路由 ID：由 canonical 路径派生，同一路径稳定、不同路径几乎不可能撞车，也不需要额外的映射文件。
 * 它是 URL 里的不透明身份；服务端只用它去已登记集合里反查路径，URL 片段本身永远不会被当文件路径使用。
 */
export function projectRouteId(project) {
  return createHash('sha256').update(String(project)).digest('hex').slice(0, 16);
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
