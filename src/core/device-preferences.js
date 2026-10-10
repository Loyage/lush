import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { check, isPlainObject } from './types.js';
import { validateConfigurationDirectory, withConfigurationWriteLock } from './device-config.js';

const MAX_BYTES = 16384;
const TYPES = ['created', 'idle', 'analysis', 'failed'];
const CHANNELS = ['banner', 'system'];
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
export const PREFERENCE_DEFAULTS = freeze({
  markdown: true, theme: 'system', sidebarSort: 'smart', taskGraphMinimal: true,
  reduceMotion: false, polling: 'standard', toastDuration: 'standard', transcriptOrder: 'desc',
  noticeChannels: Object.fromEntries(TYPES.map(type => [type, { banner: true, system: true }])),
  noticeNotifications: false,
});
const ENUMS = { theme: ['system', 'light', 'dark'], sidebarSort: ['smart', 'updated', 'id'],
  polling: ['fast', 'standard', 'power'], toastDuration: ['short', 'standard', 'long'], transcriptOrder: ['asc', 'desc'] };
const keys = Object.keys(PREFERENCE_DEFAULTS);
const copy = value => JSON.parse(JSON.stringify(value));
const rootConfig = config => {
  const home = config?.deviceHome || config?.home;
  check(typeof home === 'string' && path.isAbsolute(home), 'device preference directory is unavailable');
  return { home: path.resolve(home) };
};
function fields(value, allowed) {
  check(isPlainObject(value) && Object.keys(value).every(key => allowed.includes(key)), 'invalid device preference fields');
}
function normalize(patch) {
  fields(patch, keys);
  const values = {};
  for (const key of keys) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (key === 'noticeChannels') {
      fields(value, TYPES);
      check(TYPES.every(type => Object.hasOwn(value, type)), 'notice channels must include every category');
      values[key] = Object.fromEntries(TYPES.map(type => {
        fields(value[type], CHANNELS);
        check(CHANNELS.every(channel => typeof value[type][channel] === 'boolean'), 'notice channels must be boolean');
        return [type, Object.fromEntries(CHANNELS.map(channel => [channel, value[type][channel]]))];
      }));
    } else if (ENUMS[key]) {
      check(ENUMS[key].includes(value), `invalid device preference ${key}`); values[key] = value;
    } else { check(typeof value === 'boolean', `device preference ${key} must be boolean`); values[key] = value; }
  }
  return values;
}
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
function load(config) {
  if (!validateConfigurationDirectory(config)) return {};
  const file = path.join(config.home, 'preferences.json'), root = fs.lstatSync(config.home);
  let fd;
  try {
    let published;
    try { published = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    check(!published.isSymbolicLink(), 'unsafe device preferences file');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600
      && stat.nlink === 1 && stat.size <= MAX_BYTES && same(stat, published), 'unsafe device preferences file');
    const source = fs.readFileSync(fd, 'utf8'), after = fs.fstatSync(fd);
    check(Buffer.byteLength(source) <= MAX_BYTES && same(stat, after) && stat.size === after.size && stat.mtimeMs === after.mtimeMs
      && same(stat, fs.lstatSync(file)) && same(root, fs.lstatSync(config.home)), 'device preferences changed while reading');
    validateConfigurationDirectory(config, 'project', true);
    const data = JSON.parse(source); fields(data, ['version', 'values']);
    check(data.version === 1, 'invalid device preferences version');
    return normalize(data.values);
  } catch { throw new Error('device preferences cannot be safely read'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function model(stored) {
  const values = { ...copy(PREFERENCE_DEFAULTS), ...stored };
  return { version: 1, revision: createHash('sha256').update(JSON.stringify(values)).digest('hex'), values };
}

/** Read-only authority; absent preferences do not create any directory or seed from a browser cache. */
export function readDevicePreferences(config) { return model(load(rootConfig(config))); }

/** User-authorized partial update; optimistic revision and the shared write lock prevent lost edits. */
export function saveDevicePreferences(config, patch, expectedRevision) {
  const selected = rootConfig(config), normalized = normalize(patch);
  check(typeof expectedRevision === 'string', 'device preference revision is required');
  return withConfigurationWriteLock(selected, 'project', lock => {
    const before = load(selected), current = model(before);
    check(current.revision === expectedRevision, 'device preference revision changed; reload before saving');
    const value = { ...before, ...normalized }, file = path.join(selected.home, 'preferences.json');
    const source = JSON.stringify({ version: 1, values: value }, null, 2) + '\n';
    check(Buffer.byteLength(source) <= MAX_BYTES, 'device preferences are too large');
    const temporary = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, source); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      lock.assert(); check(model(load(selected)).revision === current.revision, 'device preferences changed before publication');
      fs.renameSync(temporary, file);
      return model(value);
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
  });
}
