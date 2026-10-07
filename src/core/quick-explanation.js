import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { check, isPlainObject, LushError } from './types.js';
import { validId, safeText } from '../agent/connections-utils.js';
import { configurationHome, configurationScope, normalizeConfigurationScope, withConfigurationWriteLock } from './device-config.js';

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
  location(create = false, scope = 'project') {
    verify(process.platform !== 'win32');
    const home = configurationHome(this.config, scope);
    if (!fs.existsSync(home)) { if (!create) return null; fs.mkdirSync(home, { mode: 0o700 }); }
    const stat = fs.lstatSync(home);
    verify(stat.isDirectory() && !stat.isSymbolicLink() && owner(stat) && (stat.mode & 0o777) === 0o700 && fs.realpathSync(home) === home);
    return { home, stat, file: path.join(home, 'quick-explanation.json') };
  }
  readLocal(scope = 'project') {
    let fd;
    try {
      const loc = this.location(false, scope); if (!loc) return null;
      try { fd = fs.openSync(loc.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
      catch (error) { if (error.code === 'ENOENT') {
        try { fs.lstatSync(loc.file); } catch (missing) { if (missing.code === 'ENOENT') return null; }
      } throw error; }
      const stat = fs.fstatSync(fd);
      verify(stat.isFile() && owner(stat) && (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.size <= MAX_BYTES);
      const text = fs.readFileSync(fd, 'utf8'), after = fs.fstatSync(fd);
      verify(Buffer.byteLength(text) <= MAX_BYTES && same(stat, after) && stat.size === after.size && stat.mtimeMs === after.mtimeMs
        && same(stat, fs.lstatSync(loc.file)) && same(loc.stat, this.location(false, scope).stat));
      const data = JSON.parse(text);
      verify(isPlainObject(data) && data.version === 1);
      const { version, ...profile } = data;
      return normalized(profile);
    } catch { throw invalid(); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  read(scope = 'project') {
    normalizeConfigurationScope(scope);
    const own = this.readLocal(scope);
    return own || (scope === 'project' && this.config.deviceHome ? this.readLocal('device') : null) || normalized({});
  }
  configurationScope(scope = 'project') {
    const own = this.readLocal(scope);
    const shared = !own && scope === 'project' && this.config.deviceHome ? this.readLocal('device') : null;
    return configurationScope(this.config, scope, own ? scope : shared ? 'device' : 'default', scope === 'project' && Boolean(own));
  }
  preview(patch, scope = 'project') { fields(patch); return normalized({ ...this.read(scope), ...patch }); }
  save(profile, scope = 'project') {
    const value = normalized(profile);
    try { return withConfigurationWriteLock(this.config, scope, lock => this.saveLocal(value, scope, lock)); }
    catch { throw invalid(); }
  }
  saveLocal(value, scope, lock) {
    let loc, temporary, fd;
    try {
      loc = this.location(true, scope); this.readLocal(scope);
      const text = JSON.stringify({ version: 1, ...value }, null, 2) + '\n'; verify(Buffer.byteLength(text) <= MAX_BYTES);
      temporary = path.join(loc.home, `.quick-explanation-${randomUUID()}.tmp`);
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      this.readLocal(scope); lock.assert(); verify(same(loc.stat, this.location(false, scope).stat));
      fs.renameSync(temporary, loc.file); temporary = null;
      return value;
    } catch { throw invalid(); }
    finally { if (fd !== undefined) fs.closeSync(fd); if (temporary) { try { fs.unlinkSync(temporary); } catch {} } }
  }
  clearOverride() {
    try {
      return withConfigurationWriteLock(this.config, 'project', lock => {
        this.readLocal(); const loc = this.location(); lock.assert(); fs.rmSync(loc.file, { force: true });
        return this.read();
      });
    } catch { throw invalid(); }
  }
}
