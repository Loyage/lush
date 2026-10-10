import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { configurationHome, configurationScope, settingsConfigurationScope, withConfigurationWriteLock } from './device-config.js';
import { check, isPlainObject, LushError } from './types.js';
import { DEFAULT_INPUT_ROUTES, normalizeInputRoutes } from './input-routes.js';

/**
 * 设备默认 / 项目覆盖的运行设置：并发、调用限额、进度开关与历史路由表。
 *
 * 值存在所选作用域的 settings.json，0600，跨进程锁 + 原子替换，
 * 读时校验 uid / symlink / 大小 / 字段。区别是运行设置是**热更新**的——写盘成功后调用方
 * 把有效值同步进内存并重新 kick，所以调高并发、放宽超时不需要重启 daemon。
 *
 * 项目有效值 = 项目存储值 ?? 设备存储值 ?? 环境默认值（LUSH_CONCURRENCY / LUSH_CONTROL_CONCURRENCY /
 * LUSH_CALL_TIMEOUT / LUSH_TASK_CALLS / LUSH_MAX_DEPTH 的启动值）；
 * progress_reporting 为布尔开关，默认 true；未被覆盖的键不写进文件，也不用假值填充。
 */
export const RUNTIME_SETTINGS_KEYS = ['concurrency', 'control_concurrency', 'call_timeout', 'task_call_limit', 'max_depth', 'progress_reporting', 'input_routes'];
export const RUNTIME_SETTINGS_LIMITS = {
  concurrency: { env: 'LUSH_CONCURRENCY', fallback: 8, max: 64 },
  control_concurrency: { env: 'LUSH_CONTROL_CONCURRENCY', fallback: 2, max: 16 },
  call_timeout: { env: 'LUSH_CALL_TIMEOUT', fallback: 10800, max: 86400 },
  task_call_limit: { env: 'LUSH_TASK_CALLS', fallback: 24, max: 1000 },
  max_depth: { env: 'LUSH_MAX_DEPTH', fallback: 8, max: 64 },
};
/** 非整数字段：值本身是结构化的（快速路由前缀表），由 normalizeInputRoutes 负责校验。 */
const STRUCTURED_KEYS = new Set(['input_routes']);
const MAX_FILE_BYTES = 8 * 1024;

function integerLimit(key, file) {
  const { max } = RUNTIME_SETTINGS_LIMITS[key];
  return `${key}${file ? ` in ${file}` : ''} must be an integer from 1 to ${max}`;
}

/** 数组型设置按值拷贝返回，避免调用方改到 RuntimeSettings 内部的默认值。 */
function copySetting(key, value) {
  return STRUCTURED_KEYS.has(key) ? value.map(route => ({ ...route })) : value;
}

/** 校验并归一化一份存储内容：只保留被显式覆盖的键；null 视为未覆盖（清除该键）。 */
export function normalizeRuntimeSettings(value, file = 'runtime settings') {
  check(isPlainObject(value), `${file} must be an object`);
  if (value.version !== undefined) check(value.version === 1, `${file} must use version 1`);
  check(Object.keys(value).every(key => key === 'version' || RUNTIME_SETTINGS_KEYS.includes(key)),
    `${file} has an unknown field`);
  const stored = {};
  for (const key of RUNTIME_SETTINGS_KEYS) {
    const entry = value[key];
    if (entry === undefined || entry === null) continue;
    if (key === 'progress_reporting') {
      check(typeof entry === 'boolean', `${key} in ${file} must be a boolean`);
      stored[key] = entry; continue;
    }
    if (STRUCTURED_KEYS.has(key)) { stored[key] = normalizeInputRoutes(entry, `${file}.${key}`); continue; }
    check(Number.isInteger(entry) && entry >= 1 && entry <= RUNTIME_SETTINGS_LIMITS[key].max, integerLimit(key, file));
    stored[key] = entry;
  }
  return stored;
}

export class RuntimeSettings {
  constructor(config) {
    this.config = config;
    this.file = path.join(configurationHome(config, settingsConfigurationScope(config)), 'settings.json');
    // 环境默认值由 Config 在读取设置文件之前校验好（LUSH_* 非法仍然在构造时抛错）。
    this.defaults = {
      concurrency: config.concurrencyDefault,
      control_concurrency: config.controlConcurrencyDefault,
      call_timeout: config.timeoutDefault,
      task_call_limit: config.maxCallsDefault,
      max_depth: config.maxDepthDefault,
      progress_reporting: true,
      input_routes: DEFAULT_INPUT_ROUTES.map(route => ({ ...route })),
    };
  }

  /** 文件里被显式覆盖的键；不存在的文件是空对象，不是「全默认值」。 */
  readStored(scope = 'project') {
    const home = configurationHome(this.config, scope), file = path.join(home, 'settings.json');
    let root;
    try { root = fs.lstatSync(home); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    check(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid()
      && !(root.mode & 0o022) && (scope !== 'device' || !(root.mode & 0o077))
      && fs.realpathSync(home) === home, 'unsafe runtime settings directory');
    let fd;
    try {
      let published;
      try { published = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
      check(!published.isSymbolicLink(), `unsafe runtime settings file: ${file}`);
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      check(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1, `unsafe runtime settings file: ${file}`);
      check((stat.mode & 0o077) === 0, `${file} must only be readable by its owner (chmod 600)`);
      check(stat.size <= MAX_FILE_BYTES, `runtime settings file is too large: ${file}`);
      const text = fs.readFileSync(fd, 'utf8'), after = fs.fstatSync(fd), current = fs.lstatSync(file), currentRoot = fs.lstatSync(home);
      check(Buffer.byteLength(text) <= MAX_FILE_BYTES && stat.ino === after.ino && stat.dev === after.dev
        && stat.size === after.size && stat.mtimeMs === after.mtimeMs && stat.ino === current.ino && stat.dev === current.dev
        && root.ino === currentRoot.ino && root.dev === currentRoot.dev && fs.realpathSync(home) === home,
      `runtime settings file changed: ${file}`);
      let value;
      try { value = JSON.parse(text); } catch { throw new LushError(`invalid JSON in runtime settings file: ${file}`); }
      return normalizeRuntimeSettings(value, file);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  /** 稳定读模型：每个键给出生效值、环境默认值与是否被设置文件覆盖，外加文件路径。 */
  get(scope) {
    scope = settingsConfigurationScope(this.config, scope);
    const stored = this.readStored(scope);
    const model = { file: path.join(configurationHome(this.config, scope), 'settings.json') };
    const sources = new Set();
    for (const key of RUNTIME_SETTINGS_KEYS) {
      const overridden = Object.hasOwn(stored, key);
      const inherited = this.defaults[key];
      const source = overridden ? scope : 'default';
      sources.add(source);
      model[key] = { value: copySetting(key, overridden ? stored[key] : inherited),
        default: copySetting(key, inherited), overridden, source };
    }
    model.configuration_scope = configurationScope(this.config, scope,
      sources.size === 1 ? [...sources][0] : 'mixed', scope === 'project' && Object.keys(stored).length > 0);
    return model;
  }

  /**
   * 部分更新：patch 里出现的键才动，null 表示清除该键、回退环境默认。
   * 先校验再写盘，非法值既不生效也不落盘；成功返回最新读模型。
   */
  save(patch, scope) {
    scope = settingsConfigurationScope(this.config, scope);
    check(isPlainObject(patch), 'runtime settings patch must be an object');
    check(Object.keys(patch).every(key => RUNTIME_SETTINGS_KEYS.includes(key)), 'runtime settings patch has an unknown field');
    return withConfigurationWriteLock(this.config, scope, lock => {
      const merged = { ...this.readStored(scope) };
      for (const key of RUNTIME_SETTINGS_KEYS) {
        if (!Object.hasOwn(patch, key)) continue;
        if (patch[key] === null) delete merged[key];
        else merged[key] = patch[key];
      }
      const stored = normalizeRuntimeSettings(merged, this.file);
      this.write({ version: 1, ...stored }, scope, lock);
      return this.get(scope);
    });
  }

  write(body, scope, lock = null) {
    scope = settingsConfigurationScope(this.config, scope);
    if (!lock) return withConfigurationWriteLock(this.config, scope, held => this.write(body, scope, held));
    const serialized = JSON.stringify(body, null, 2) + '\n';
    check(Buffer.byteLength(serialized) <= MAX_FILE_BYTES, 'runtime settings file is too large');
    const file = path.join(configurationHome(this.config, scope), 'settings.json');
    this.readStored(scope);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' });
      lock.assert(); this.readStored(scope);
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
