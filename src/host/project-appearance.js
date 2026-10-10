import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { check, isPlainObject } from '../core/types.js';
import { acquireConfigurationLock, validateConfigurationDirectory } from '../core/device-config.js';
import { launcherStateDir } from './registry.js';
import { PROJECT_COLORS } from '../ui/web/assets/project-colors.js';

const FILE = 'appearance.json';
const MAX_BYTES = 4096;
const THEMES = new Set(['system', 'light', 'dark']);
const COLORS = new Set(PROJECT_COLORS.map(color => color.id));
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const revisionValid = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

function projectConfiguration(project) {
  check(typeof process.getuid === 'function' && typeof project === 'string' && path.isAbsolute(project), 'unsafe project appearance directory');
  let stat;
  try { stat = fs.lstatSync(project); } catch { throw new Error('project appearance directory is unavailable'); }
  check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && fs.realpathSync(project) === project, 'unsafe project appearance directory');
  return { home: path.join(project, '.lush') };
}

function validateAppearance(value) {
  check(isPlainObject(value) && Object.keys(value).length === 4
    && Object.keys(value).every(key => ['version', 'theme', 'color', 'revision'].includes(key))
    && value.version === 1 && THEMES.has(value.theme) && COLORS.has(value.color) && revisionValid(value.revision),
  'invalid project appearance configuration');
  return { version: 1, theme: value.theme, color: value.color, revision: value.revision };
}

export function validateAppearanceUpdate(body) {
  check(isPlainObject(body), 'project appearance body must be an object');
  if (Object.hasOwn(body, 'initialize')) {
    check(Object.keys(body).length === 1 && body.initialize === true, 'project appearance initialization accepts only initialize:true');
    return { initialize: true };
  }
  check([2, 3].includes(Object.keys(body).length) && Object.keys(body).every(key => ['theme', 'color', 'expected_revision'].includes(key))
    && (!Object.hasOwn(body, 'theme') || THEMES.has(body.theme)) && COLORS.has(body.color) && revisionValid(body.expected_revision),
  'project appearance requires color and expected_revision; unknown fields and agent tokens are not accepted');
  // Legacy clients may echo the retained theme, but cannot change it (#411).
  return { color: body.color, expected_revision: body.expected_revision,
    ...(Object.hasOwn(body, 'theme') ? { theme: body.theme } : {}) };
}

function safeFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.size <= MAX_BYTES;
}

/** Read-only: a missing .lush or appearance file stays missing. Never load daemon facts. */
export function readProjectAppearance(project) {
  const config = projectConfiguration(project);
  if (!validateConfigurationDirectory(config)) return null;
  const root = fs.lstatSync(config.home), file = path.join(config.home, FILE);
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('project appearance cannot be read'); }
  check(safeFile(before), 'unsafe project appearance file');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    check(safeFile(opened) && same(before, opened), 'project appearance file changed');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(fd);
    check(length <= MAX_BYTES && length === after.size && same(opened, after)
      && opened.size === after.size && opened.mtimeMs === after.mtimeMs && opened.ctimeMs === after.ctimeMs
      && same(after, fs.lstatSync(file)), 'project appearance file changed');
    projectConfiguration(project);
    validateConfigurationDirectory(config, 'project', true);
    check(same(root, fs.lstatSync(config.home)), 'project appearance directory changed');
    let value;
    try { value = JSON.parse(buffer.subarray(0, length).toString('utf8')); }
    catch { throw new Error('invalid project appearance configuration'); }
    return validateAppearance(value);
  } catch (error) {
    // Never expose the raw file contents, parse diagnostics or filesystem errors.
    if (/^(unsafe|invalid|project appearance)/.test(error.message)) throw error;
    throw new Error('project appearance cannot be read');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function locked(config, fn) {
  // Reuse the existing private-root lock discipline. A crash leaves a visible busy
  // lock, never an automatically stolen lock or a replayed write.
  const lock = acquireConfigurationLock(config);
  try { lock.assert(); return fn(lock); }
  finally { lock.release(); }
}

function writeAppearance(project, current, next, lock) {
  const config = projectConfiguration(project), file = path.join(config.home, FILE);
  const temporary = path.join(config.home, `.appearance-${process.pid}-${randomBytes(16).toString('hex')}.tmp`);
  let fd, owned;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    owned = fs.fstatSync(fd);
    fs.writeFileSync(fd, JSON.stringify(next) + '\n');
    fs.fsyncSync(fd);
    const written = fs.fstatSync(fd);
    check(safeFile(written), 'unsafe project appearance temporary file');
    fs.closeSync(fd); fd = undefined;
    lock.assert();
    projectConfiguration(project);
    check(readProjectAppearance(project)?.revision === current?.revision, 'project appearance changed; reload and retry');
    lock.assert();
    check(same(written, fs.lstatSync(temporary)), 'project appearance temporary file changed');
    fs.renameSync(temporary, file);
    const dir = fs.openSync(config.home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    return next;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    // Do not follow a replaced root or delete an unknown file during cleanup.
    lock.assert();
    try {
      const leftover = fs.lstatSync(temporary);
      check(owned && same(owned, leftover), 'project appearance temporary file changed');
      fs.unlinkSync(temporary);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** Caller supplies only its registered, whitelist-filtered canonical projects. */
export function saveProjectAppearance(project, body, { projects = [project], env = process.env } = {}) {
  const update = validateAppearanceUpdate(body);
  const config = projectConfiguration(project);
  const existing = readProjectAppearance(project);
  if (update.initialize && existing) return existing;
  if (!update.initialize) check(existing && existing.revision === update.expected_revision, 'project appearance revision conflict; reload and retry');
  // Allocation and explicit changes coordinate across Host processes on this device.
  // The project lock additionally protects revision checks across different Host roots.
  return locked({ home: launcherStateDir(env) }, globalLock => locked(config, projectLock => {
    globalLock.assert();
    const current = readProjectAppearance(project);
    if (update.initialize && current) return current;
    let theme = update.theme, color = update.color;
    if (update.initialize) {
      const counts = new Map(PROJECT_COLORS.map(color => [color.id, 0]));
      for (const peer of new Set(projects)) {
        if (peer === project) continue;
        // Offline/missing registered directories aren't scanned or initialized.
        try { fs.lstatSync(peer); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const appearance = readProjectAppearance(peer);
        if (appearance) counts.set(appearance.color, counts.get(appearance.color) + 1);
      }
      color = PROJECT_COLORS.reduce((best, entry) => counts.get(entry.id) < counts.get(best) ? entry.id : best, PROJECT_COLORS[0].id);
      theme = 'system';
    } else {
      check(current && current.revision === update.expected_revision, 'project appearance revision conflict; reload and retry');
      check(!Object.hasOwn(update, 'theme') || update.theme === current.theme, 'project themes are inactive; use device preferences');
      theme = current.theme;
    }
    globalLock.assert();
    return writeAppearance(project, current, { version: 1, theme, color, revision: randomBytes(16).toString('hex') }, projectLock);
  }));
}
