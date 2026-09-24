import fs from 'node:fs';
import path from 'node:path';
import { check, isPlainObject, LushError } from './types.js';

/**
 * 项目级「快速介绍」模型配置：选中文字后直接用 OpenAI 兼容接口问一次模型，不经过 Agent。
 *
 * 与 AgentSettings / RuntimeSettings 同风格：值存在 <home>/quick-intro.json，0600，临时文件加 rename
 * 原子替换，读时校验 uid / symlink / 大小 / 字段。这里**没有环境默认值**：没配置就是没配置，
 * 调用方据此提示用户去设置里填写，而不是偷偷回退到某个 Agent。
 *
 * 只保存三样东西：OpenAI 兼容的 base_url（调用 {base_url}/chat/completions）、model、api_key。
 * api_key 可以留空（本地 Ollama / vLLM 常不需要鉴权）；API Key 只写不显，读模型只给出是否已保存与尾号提示。
 */
const FIELDS = ['base_url', 'model', 'api_key'];
const MAX_FILE_BYTES = 16 * 1024;
const MAX_BASE_URL = 2048;
const MAX_MODEL = 256;
const MAX_KEY = 4096;

function text(value, name, max) {
  check(typeof value === 'string', `${name} must be text`);
  check(value.length <= max, `${name} is too long`);
  return value.trim();
}

/** base URL 只接受 http(s)，去掉尾部斜杠与末尾的 /chat/completions，避免拼出重复路径。 */
export function normalizeBaseUrl(value) {
  const raw = text(value, 'base_url', MAX_BASE_URL);
  check(raw, 'base_url must not be empty');
  let url;
  try { url = new URL(raw); }
  catch { throw new LushError('base_url must be a valid URL'); }
  check(['http:', 'https:'].includes(url.protocol), 'base_url must start with http:// or https://');
  check(!url.username && !url.password, 'base_url must not contain credentials');
  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/chat/completions')) pathname = pathname.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

/** 记录文件的读写与校验；调用方用 resolve() 拿完整密钥，用 get() 拿可下发给浏览器的读模型。 */
export class QuickIntroSettings {
  constructor(config) {
    this.config = config;
    this.file = path.join(config.home, 'quick-intro.json');
  }

  readStored() {
    if (!fs.existsSync(this.file)) return {};
    const stat = fs.lstatSync(this.file);
    check(!stat.isSymbolicLink() && stat.isFile() && stat.uid === process.getuid(), `unsafe quick-intro settings file: ${this.file}`);
    check((stat.mode & 0o077) === 0, `${this.file} must only be readable by its owner (chmod 600)`);
    check(stat.size <= MAX_FILE_BYTES, `quick-intro settings file is too large: ${this.file}`);
    let value;
    try { value = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { throw new LushError(`invalid JSON in quick-intro settings file: ${this.file}`); }
    check(isPlainObject(value), 'quick-intro settings must be an object');
    check(value.version === undefined || value.version === 1, 'quick-intro settings version must be 1');
    check(Object.keys(value).every(key => key === 'version' || FIELDS.includes(key)), 'quick-intro settings has an unknown field');
    const stored = {};
    if (value.base_url !== undefined && value.base_url !== null && value.base_url !== '') stored.base_url = normalizeBaseUrl(value.base_url);
    if (value.model !== undefined && value.model !== null && value.model !== '') stored.model = text(value.model, 'model', MAX_MODEL);
    if (value.api_key !== undefined && value.api_key !== null && value.api_key !== '') stored.api_key = text(value.api_key, 'api_key', MAX_KEY);
    return stored;
  }

  /** 下发给浏览器的读模型：密钥只报告是否已保存与尾号。 */
  get() {
    const stored = this.readStored();
    const key = stored.api_key || '';
    return {
      file: this.file,
      base_url: stored.base_url || '',
      model: stored.model || '',
      has_key: Boolean(key),
      key_hint: key ? `••••${key.slice(-4)}` : '',
      // 本地服务可以不要 Key，所以「可调用」只要求地址与模型；调用时没有 Key 就不带 Authorization。
      ready: Boolean(stored.base_url && stored.model),
    };
  }

  /** daemon 内部调用用：带完整密钥，绝不下发给浏览器。 */
  resolve() {
    const stored = this.readStored();
    return { base_url: stored.base_url || '', model: stored.model || '', api_key: stored.api_key || '' };
  }

  /** 部分更新：未出现的键保持原值，null 清除该键。先校验再写盘，非法值既不生效也不落盘。 */
  save(patch) {
    check(isPlainObject(patch), 'quick-intro settings patch must be an object');
    check(Object.keys(patch).every(key => FIELDS.includes(key)), 'quick-intro settings patch has an unknown field');
    const merged = { ...this.readStored() };
    for (const key of FIELDS) {
      if (!Object.hasOwn(patch, key)) continue;
      const value = patch[key];
      if (value === null || value === '') delete merged[key];
      else if (key === 'base_url') merged[key] = normalizeBaseUrl(value);
      else if (key === 'model') merged[key] = text(value, 'model', MAX_MODEL);
      else merged[key] = text(value, 'api_key', MAX_KEY);
    }
    this.write({ version: 1, ...merged });
    return this.get();
  }

  write(body) {
    const serialized = JSON.stringify(body, null, 2) + '\n';
    check(Buffer.byteLength(serialized) <= MAX_FILE_BYTES, 'quick-intro settings file is too large');
    fs.mkdirSync(this.config.home, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
