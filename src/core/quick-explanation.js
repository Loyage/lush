import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { check, isPlainObject, LushError } from './types.js';
import { validId, safeText } from '../agent/connections-utils.js';

export const DEFAULT_EXPLANATION_PROMPT = '请用简洁中文解释用户选中的文字：先说明它是什么意思，再解释必要的背景、原理及对用户的意义。默认 3–6 句，复杂内容可用短列表。区分原文事实、背景知识和推测；资料不足时明确说明不知道，不要编造上下文。';
export const EXPLANATION_PROVIDERS = new Set(['openai-compatible', 'deepseek', 'openrouter', 'zai']);
const MAX_BYTES = 65536;
const invalid = () => new LushError('快捷解释配置或私有文件无效');
const verify = value => { if (!value) throw invalid(); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const owner = stat => typeof process.getuid === 'function' && stat.uid === process.getuid();
const fields = value => check(isPlainObject(value) && Object.keys(value).every(key => ['connection_id', 'model', 'prompt'].includes(key)), '快捷解释配置字段无效');

function normalized(value) {
  fields(value);
  const connection_id = value.connection_id == null || value.connection_id === '' ? null : value.connection_id;
  check(connection_id === null || validId(connection_id), '请选择有效的模型来源');
  const model = value.model == null || value.model === '' ? '' : safeText(value.model, '解释模型', 256);
  check(value.prompt == null || typeof value.prompt === 'string', '解释 Prompt 必须是文字');
  const prompt = value.prompt?.trim() || DEFAULT_EXPLANATION_PROMPT;
  check(prompt.length <= 8192, '解释 Prompt 最多 8192 字');
  return { connection_id, model, prompt };
}

/** Project-only settings. No secrets, no inherited Agent configuration or network probes. */
export class QuickExplanationSettings {
  constructor(config) { this.config = config; }
  location(create = false) {
    verify(process.platform !== 'win32' && typeof this.config?.home === 'string' && path.isAbsolute(this.config.home));
    const home = path.resolve(this.config.home);
    if (!fs.existsSync(home)) { if (!create) return null; fs.mkdirSync(home, { mode: 0o700 }); }
    const stat = fs.lstatSync(home);
    verify(stat.isDirectory() && !stat.isSymbolicLink() && owner(stat) && (stat.mode & 0o777) === 0o700 && fs.realpathSync(home) === home);
    return { home, stat, file: path.join(home, 'quick-explanation.json') };
  }
  read() {
    let fd;
    try {
      const loc = this.location(); if (!loc) return normalized({});
      try { fd = fs.openSync(loc.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
      catch (error) { if (error.code === 'ENOENT') return normalized({}); throw error; }
      const stat = fs.fstatSync(fd);
      verify(stat.isFile() && owner(stat) && (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.size <= MAX_BYTES);
      const text = fs.readFileSync(fd, 'utf8'), after = fs.fstatSync(fd);
      verify(Buffer.byteLength(text) <= MAX_BYTES && same(stat, after) && stat.size === after.size && stat.mtimeMs === after.mtimeMs
        && same(stat, fs.lstatSync(loc.file)) && same(loc.stat, this.location().stat));
      const data = JSON.parse(text);
      verify(isPlainObject(data) && data.version === 1);
      const { version, ...profile } = data;
      return normalized(profile);
    } catch { throw invalid(); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  preview(patch) { fields(patch); return normalized({ ...this.read(), ...patch }); }
  save(profile) {
    const value = normalized(profile);
    let loc, temporary, fd;
    try {
      loc = this.location(true); this.read();
      const text = JSON.stringify({ version: 1, ...value }, null, 2) + '\n'; verify(Buffer.byteLength(text) <= MAX_BYTES);
      temporary = path.join(loc.home, `.quick-explanation-${randomUUID()}.tmp`);
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      this.read(); verify(same(loc.stat, this.location().stat));
      fs.renameSync(temporary, loc.file); temporary = null;
      return value;
    } catch { throw invalid(); }
    finally { if (fd !== undefined) fs.closeSync(fd); if (temporary) { try { fs.unlinkSync(temporary); } catch {} } }
  }
}
