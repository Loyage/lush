import fs from 'node:fs';
import path from 'node:path';
import { check, isPlainObject, LushError } from './types.js';
import { DEFAULT_INPUT_ROUTES, normalizeInputRoutes } from './input-routes.js';

/**
 * 项目级「运行设置」：两条并发上限、三条调用 / 拆解限额 + 快速路由前缀表。
 *
 * 与 AgentSettings 同风格：值存在 <home>/settings.json，0600，临时文件加 rename 原子替换，
 * 读时校验 uid / symlink / 大小 / 字段。区别是运行设置是**热更新**的——写盘成功后调用方
 * 把有效值同步进内存并重新 kick，所以调高并发、放宽超时不需要重启 daemon。
 *
 * 有效值 = 存储值 ?? 环境默认值（LUSH_CONCURRENCY / LUSH_CONTROL_CONCURRENCY /
 * LUSH_CALL_TIMEOUT / LUSH_TASK_CALLS / LUSH_MAX_DEPTH 的启动值）；
 * 未被覆盖的键不写进文件，也不用假值填充。
 */
export const RUNTIME_SETTINGS_KEYS = ['concurrency', 'control_concurrency', 'call_timeout', 'task_call_limit', 'max_depth', 'input_routes'];
export const RUNTIME_SETTINGS_LIMITS = {
  concurrency: { env: 'LUSH_CONCURRENCY', fallback: 4, max: 64 },
  control_concurrency: { env: 'LUSH_CONTROL_CONCURRENCY', fallback: 2, max: 16 },
  call_timeout: { env: 'LUSH_CALL_TIMEOUT', fallback: 900, max: 86400 },
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
    if (STRUCTURED_KEYS.has(key)) { stored[key] = normalizeInputRoutes(entry, `${file}.${key}`); continue; }
    check(Number.isInteger(entry) && entry >= 1 && entry <= RUNTIME_SETTINGS_LIMITS[key].max, integerLimit(key, file));
    stored[key] = entry;
  }
  return stored;
}

export class RuntimeSettings {
  constructor(config) {
    this.config = config;
    this.file = path.join(config.home, 'settings.json');
    // 环境默认值由 Config 在读取设置文件之前校验好（LUSH_* 非法仍然在构造时抛错）。
    this.defaults = {
      concurrency: config.concurrencyDefault,
      control_concurrency: config.controlConcurrencyDefault,
      call_timeout: config.timeoutDefault,
      task_call_limit: config.maxCallsDefault,
      max_depth: config.maxDepthDefault,
      input_routes: DEFAULT_INPUT_ROUTES.map(route => ({ ...route })),
    };
  }

  /** 文件里被显式覆盖的键；不存在的文件是空对象，不是「全默认值」。 */
  readStored() {
    if (!fs.existsSync(this.file)) return {};
    const stat = fs.lstatSync(this.file);
    check(!stat.isSymbolicLink() && stat.isFile() && stat.uid === process.getuid(), `unsafe runtime settings file: ${this.file}`);
    check((stat.mode & 0o077) === 0, `${this.file} must only be readable by its owner (chmod 600)`);
    check(stat.size <= MAX_FILE_BYTES, `runtime settings file is too large: ${this.file}`);
    let value;
    try { value = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { throw new LushError(`invalid JSON in runtime settings file: ${this.file}`); }
    return normalizeRuntimeSettings(value, this.file);
  }

  /** 稳定读模型：每个键给出生效值、环境默认值与是否被设置文件覆盖，外加文件路径。 */
  get() {
    const stored = this.readStored();
    const model = { file: this.file };
    for (const key of RUNTIME_SETTINGS_KEYS) {
      const overridden = Object.hasOwn(stored, key);
      model[key] = { value: copySetting(key, overridden ? stored[key] : this.defaults[key]),
        default: copySetting(key, this.defaults[key]), overridden };
    }
    return model;
  }

  /**
   * 部分更新：patch 里出现的键才动，null 表示清除该键、回退环境默认。
   * 先校验再写盘，非法值既不生效也不落盘；成功返回最新读模型。
   */
  save(patch) {
    check(isPlainObject(patch), 'runtime settings patch must be an object');
    check(Object.keys(patch).every(key => RUNTIME_SETTINGS_KEYS.includes(key)), 'runtime settings patch has an unknown field');
    const merged = { ...this.readStored() };
    for (const key of RUNTIME_SETTINGS_KEYS) {
      if (!Object.hasOwn(patch, key)) continue;
      if (patch[key] === null) delete merged[key];
      else merged[key] = patch[key];
    }
    const stored = normalizeRuntimeSettings(merged, this.file);
    this.write({ version: 1, ...stored });
    return this.get();
  }

  write(body) {
    const serialized = JSON.stringify(body, null, 2) + '\n';
    check(Buffer.byteLength(serialized) <= MAX_FILE_BYTES, 'runtime settings file is too large');
    fs.mkdirSync(this.config.home, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
