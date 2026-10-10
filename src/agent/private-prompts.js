import fs from 'node:fs';
import path from 'node:path';
import { check } from '../core/types.js';
import { configurationHome, settingsConfigurationScope, withConfigurationWriteLock } from '../core/device-config.js';

export const PROMPT_SUPPLEMENT_TARGETS = Object.freeze(['common', 'agent', 'planner', 'coordinator', 'worker', 'research', 'verifier', 'merger', 'explainer', 'butler', 'manager']);
export const PRIVATE_PROMPT_MAX_BYTES = 65536;
const README = '# Lush agent customization\n\n`common.md` is appended to every role. `<role>.md` is appended only to that role.\nUse `lush agent prompt ROLE` to inspect the final composition.\n';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const identity = stat => ({ dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode });
const fileIdentity = stat => ({ ...identity(stat), nlink: stat.nlink, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
function statMaybe(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function directory(file) {
  const stat = statMaybe(file);
  if (!stat) return null;
  check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && (stat.mode & 0o777) === 0o700 && fs.realpathSync(file) === file, 'unsafe private Prompt directory');
  return identity(stat);
}
function directories(home) {
  check(process.platform !== 'win32' && typeof process.getuid === 'function', 'unsupported private Prompt storage');
  // Even absent roots must not hide a dangling symlink or aliased ancestor.
  let ancestor = home, stat;
  while (!(stat = statMaybe(ancestor))) ancestor = path.dirname(ancestor);
  check(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(ancestor) === ancestor, 'unsafe private Prompt ancestor');
  return { root: directory(home), agent: directory(path.join(home, 'agent')), ancestor, identity: identity(stat) };
}
function validFile(stat) {
  check(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.size <= PRIVATE_PROMPT_MAX_BYTES, 'unsafe private Prompt file');
}
function read(home, name) {
  const parents = directories(home), file = path.join(home, 'agent', name), before = statMaybe(file);
  if (!before) {
    check(same(parents, directories(home)), 'private Prompt directory changed');
    return null;
  }
  validFile(before);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd); validFile(opened);
    check(same(fileIdentity(before), fileIdentity(opened)), 'private Prompt file changed');
    const buffer = Buffer.alloc(PRIVATE_PROMPT_MAX_BYTES + 1); let length = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      length += count; check(length <= PRIVATE_PROMPT_MAX_BYTES, 'private Prompt file too large');
      if (!count) break;
    }
    const after = fs.fstatSync(fd), current = fs.lstatSync(file); validFile(after); validFile(current);
    check(same(fileIdentity(opened), fileIdentity(after)) && same(fileIdentity(after), fileIdentity(current))
      && after.size === length && same(parents, directories(home)), 'private Prompt file changed');
    return { body: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)), identity: fileIdentity(current) };
  } finally { fs.closeSync(fd); }
}

/** Private device supplement only; an absent file never initializes a directory. */
export function readPrivatePrompt(config, target) {
  check(PROMPT_SUPPLEMENT_TARGETS.includes(target), 'invalid private Prompt target');
  try { return read(configurationHome(config, settingsConfigurationScope(config)), `${target}.md`)?.body ?? null; }
  catch { throw new Error('private Prompt supplement cannot be safely read'); }
}

/** User-only CLI adapter validates authority before calling this create-only writer. */
export function initPrivatePrompts(config, role = null) {
  check(role === null || PROMPT_SUPPLEMENT_TARGETS.slice(1).includes(role), 'invalid private Prompt role');
  const scope = settingsConfigurationScope(config), home = configurationHome(config, scope);
  return withConfigurationWriteLock(config, scope, lock => {
    const dir = path.join(home, 'agent'), names = ['common.md', ...(role ? [`${role}.md`] : []), 'README.md'];
    try {
      // Validate all existing files before creating any, never repair a user's unsafe scene.
      const before = directories(home);
      const expected = new Map(names.map(name => [name, read(home, name)?.identity ?? null]));
      const existing = names.filter(name => expected.get(name) !== null);
      lock.assert(); check(same(before, directories(home)), 'private Prompt directory changed');
      if (!before.agent) fs.mkdirSync(dir, { mode: 0o700 });
      const parents = directories(home), created = [];
      for (const name of names) {
        lock.assert(); check(same(parents, directories(home)), 'private Prompt directory changed');
        const file = path.join(dir, name);
        if (existing.includes(name)) {
          check(same(expected.get(name), read(home, name)?.identity), 'private Prompt identity changed'); continue;
        }
        let fd;
        try {
          fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          const opened = fs.fstatSync(fd); validFile(opened);
          lock.assert(); check(same(parents, directories(home)) && same(identity(opened), identity(fs.lstatSync(file))), 'private Prompt identity changed');
          fs.writeFileSync(fd, name === 'README.md' ? README : ''); fs.fsyncSync(fd);
          const after = fs.fstatSync(fd); validFile(after);
          lock.assert(); check(same(parents, directories(home)) && same(fileIdentity(after), fileIdentity(fs.lstatSync(file))), 'private Prompt identity changed');
          expected.set(name, fileIdentity(after));
        } finally { if (fd !== undefined) fs.closeSync(fd); }
        read(home, name);
        if (name !== 'README.md') created.push(file);
      }
      const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      lock.assert(); check(same(parents, directories(home)), 'private Prompt directory changed');
      for (const name of names) check(same(expected.get(name), read(home, name)?.identity), 'private Prompt identity changed');
      return { scope: config.deviceHome ? 'device' : 'local', directory: dir, created,
        existing: existing.filter(name => name !== 'README.md').map(name => path.join(dir, name)), role };
    } catch { throw new Error('private Prompt initialization unavailable; check permissions and file identities'); }
  });
}
