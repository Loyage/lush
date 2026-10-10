import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { check, isPlainObject } from './types.js';
import { acquireConfigurationLock, validateConfigurationDirectory } from './device-config.js';

const FILE = 'automation.json';
const MAX_BYTES = 16384;
const LEVELS = ['merge', 'accept', 'archive'];
const initial = () => ({ version: 1, generation: null, auto_select: { enabled: false },
  completion_defaults: { enabled: false, level: 'merge' } });
function object(value, keys, label) {
  check(isPlainObject(value) && Object.keys(value).every(key => keys.includes(key)), `invalid ${label} fields`);
}
function normalize(value) {
  object(value, ['version', 'generation', 'auto_select', 'completion_defaults'], 'device automation');
  check(value.version === 1 && (value.generation === null || (typeof value.generation === 'string'
    && /^[0-9a-f-]{36}$/.test(value.generation))), 'invalid device automation version');
  object(value.auto_select, ['enabled'], 'automatic selection');
  object(value.completion_defaults, ['enabled', 'level'], 'completion defaults');
  check(typeof value.auto_select.enabled === 'boolean', 'automatic selection enabled must be boolean');
  check(typeof value.completion_defaults.enabled === 'boolean', 'completion defaults enabled must be boolean');
  check(LEVELS.includes(value.completion_defaults.level), 'default completion level must be merge, accept or archive');
  return { version: 1, generation: value.generation, auto_select: { enabled: value.auto_select.enabled },
    completion_defaults: { enabled: value.completion_defaults.enabled, level: value.completion_defaults.level } };
}
function view(value) {
  return { version: 1, revision: createHash('sha256').update(JSON.stringify(value)).digest('base64url'),
    auto_select: { ...value.auto_select }, completion_defaults: { ...value.completion_defaults } };
}
function patchPolicy(value, patch) {
  object(patch, ['auto_select', 'completion_defaults'], 'device automation patch');
  check(Object.keys(patch).length > 0, 'device automation patch is empty');
  const next = { ...value, generation: randomUUID() };
  if (Object.hasOwn(patch, 'auto_select')) {
    object(patch.auto_select, ['enabled'], 'automatic selection patch');
    check(Object.keys(patch.auto_select).length === 1 && typeof patch.auto_select.enabled === 'boolean',
      'automatic selection enabled must be boolean');
    next.auto_select = { enabled: patch.auto_select.enabled };
  }
  if (Object.hasOwn(patch, 'completion_defaults')) {
    object(patch.completion_defaults, ['enabled', 'level'], 'completion defaults patch');
    check(Object.keys(patch.completion_defaults).length > 0, 'completion defaults patch is empty');
    if (Object.hasOwn(patch.completion_defaults, 'enabled'))
      check(typeof patch.completion_defaults.enabled === 'boolean', 'completion defaults enabled must be boolean');
    if (Object.hasOwn(patch.completion_defaults, 'level'))
      check(LEVELS.includes(patch.completion_defaults.level), 'default completion level must be merge, accept or archive');
    next.completion_defaults = { ...value.completion_defaults, ...patch.completion_defaults };
  }
  return normalize(next);
}
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
function validFile(stat) {
  return typeof process.getuid === 'function' && stat.isFile() && stat.uid === process.getuid()
    && (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.size <= MAX_BYTES;
}

/** A single device-user authorization document. No project policy is imported implicitly. */
export class DeviceAutomationSettings {
  constructor(config) {
    const home = config?.deviceHome || config?.home;
    check(typeof home === 'string' && path.isAbsolute(home), 'device automation directory is unavailable');
    // The low-level storage wrapper is not a Project and never alters Config.home / LUSH_HOME.
    this.config = { home: path.resolve(home), deviceHome: null, project: null };
    this.file = path.join(this.config.home, FILE);
  }

  read() {
    let fd;
    try {
      if (!validateConfigurationDirectory(this.config, 'project')) return initial();
      let original;
      try { original = fs.lstatSync(this.file); }
      catch (error) { if (error.code === 'ENOENT') return initial(); throw error; }
      check(validFile(original), 'unsafe automation file');
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(fd);
      check(validFile(opened) && same(original, opened), 'automation file changed');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      check(bytes <= MAX_BYTES && validFile(fs.fstatSync(fd)) && same(opened, fs.lstatSync(this.file)), 'automation file changed');
      return normalize(JSON.parse(buffer.subarray(0, bytes).toString('utf8')));
    } catch {
      throw new Error('device automation configuration is unavailable or invalid; inspect the private settings before continuing');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  /** Read-only: an absent device root remains absent. */
  get() { return view(this.read()); }

  /** Hold the same cross-process lock used by save until the final synchronous DB commit. */
  withPolicy(fn) {
    check(typeof fn === 'function' && fn.constructor?.name !== 'AsyncFunction', 'device policy callback must be synchronous');
    const lock = acquireConfigurationLock(this.config, 'project', 'settings-write');
    try {
      lock.assert();
      const result = fn(this.get());
      check(!result || typeof result.then !== 'function', 'device policy callback must be synchronous');
      lock.assert();
      return result;
    } finally { lock.release(); }
  }

  save(patch, expectedRevision) {
    // Validate a malformed request before creating a root or acquiring any authorization lock.
    patchPolicy(initial(), patch);
    check(typeof expectedRevision === 'string' && expectedRevision.length > 0 && expectedRevision.length <= 256,
      'device automation expected revision is required');
    return this.withPolicy(current => {
      check(current.revision === expectedRevision, 'device automation revision changed; reload before editing');
      const next = patchPolicy(this.read(), patch);
      const file = path.join(this.config.home, `.${FILE}.${randomUUID()}.tmp`);
      let fd;
      try {
        fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, JSON.stringify(next) + '\n');
        fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        // Refuse a changed/unsafe destination instead of silently replacing its provenance.
        try { check(validFile(fs.lstatSync(this.file)), 'unsafe automation destination'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        fs.renameSync(file, this.file);
        return view(next);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    });
  }
}
