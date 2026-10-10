import fs from 'node:fs';
import path from 'node:path';
import { check } from './types.js';

export function normalizeConfigurationScope(scope = 'project') {
  check(scope === 'project' || scope === 'device', 'configuration scope must be device or project');
  return scope;
}

/** Public technical settings have one authority. Raw project selection below is migration-only. */
export function settingsConfigurationScope(config, scope) {
  if (scope !== undefined) normalizeConfigurationScope(scope);
  if (config?.deviceHome) {
    check(scope !== 'project', 'project configuration overrides are no longer supported; use device settings');
    return 'device';
  }
  // Explicitly rooted Host services and isolated legacy fixtures have a single local storage root.
  return scope ?? 'project';
}

/** Storage selection never changes project identity or LUSH_HOME. Minimal legacy configs stay local. */
export function configurationHome(config, scope = 'project') {
  normalizeConfigurationScope(scope);
  const home = scope === 'device' ? config?.deviceHome : config?.home;
  check(typeof home === 'string' && path.isAbsolute(home), `${scope} configuration directory is unavailable`);
  return path.resolve(home);
}

export function scopedConfiguration(config, scope = 'project') {
  return { ...config, home: configurationHome(config, scope), deviceHome: null };
}

export function configurationScope(config, scope = 'project', source = 'default', projectOverride = false) {
  normalizeConfigurationScope(scope);
  check(['device', 'project', 'default', 'mixed'].includes(source), 'invalid configuration source');
  return { selected: scope, source, device_home: config?.deviceHome || null,
    project_home: config?.project ? config.home : null, project_override: Boolean(projectOverride) };
}

/** Document-level inheritance metadata; call only after its validated reader has succeeded. */
export function documentConfigurationScope(config, scope = 'project', file) {
  normalizeConfigurationScope(scope);
  const projectOverride = Boolean(config?.project && fs.existsSync(path.join(config.home, file)));
  const device = Boolean(config?.deviceHome && fs.existsSync(path.join(config.deviceHome, file)));
  return configurationScope(config, scope, scope === 'project' && projectOverride ? 'project' : device ? 'device' : 'default', projectOverride);
}

const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const privateDirectory = stat => typeof process.getuid === 'function' && stat.isDirectory()
  && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700;

/** Read-only validation for a shared service: an absent root is not initialized by opening settings. */
export function validateConfigurationDirectory(config, scope = 'project', required = false) {
  const home = configurationHome(config, scope);
  check(process.platform !== 'win32', 'private configuration storage is unsupported on this platform');
  let stat;
  try { stat = fs.lstatSync(home); }
  catch (error) { if (error.code === 'ENOENT' && !required) return false; throw error; }
  check(privateDirectory(stat) && fs.realpathSync(home) === home, 'unsafe private configuration directory');
  return true;
}

/** Refuse unsafe pre-existing roots rather than silently repairing permissions or following aliases. */
export function ensureConfigurationDirectory(config, scope = 'project') {
  const home = configurationHome(config, scope);
  check(process.platform !== 'win32', 'private configuration storage is unsupported on this platform');
  // Check the nearest existing ancestor before recursive mkdir can follow an alias or dangling link.
  let ancestor = home, existing;
  for (;;) {
    try { existing = fs.lstatSync(ancestor); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); }
  }
  check(existing.isDirectory() && !existing.isSymbolicLink() && fs.realpathSync(ancestor) === ancestor,
    'unsafe private configuration directory');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(home);
  check(privateDirectory(stat) && fs.realpathSync(home) === home, 'unsafe private configuration directory');
  return home;
}

/** Cross-process lock. Unknown/stale locks are never stolen or replayed automatically. */
export function acquireConfigurationLock(config, scope = 'project', name = 'settings-write') {
  check(['settings-write', 'migration', 'packages'].includes(name), 'invalid configuration lock');
  const home = ensureConfigurationDirectory(config, scope), parent = fs.lstatSync(home);
  const file = path.join(home, `.${name}.lock`);
  try { fs.mkdirSync(file, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('configuration is busy; retry after the current operation');
    throw new Error('private configuration lock unavailable');
  }
  const original = fs.lstatSync(file);
  const assert = () => {
    let current, root;
    try { current = fs.lstatSync(file); root = fs.lstatSync(home); }
    catch { throw new Error('private configuration lock changed'); }
    check(privateDirectory(current) && privateDirectory(root) && same(original, current) && same(parent, root)
      && fs.realpathSync(home) === home, 'private configuration lock changed');
  };
  let released = false;
  return { assert, release() {
    if (released) return;
    assert(); fs.rmdirSync(file); released = true;
  } };
}

export function withConfigurationWriteLock(config, scope, fn) {
  const lock = acquireConfigurationLock(config, scope);
  try {
    lock.assert();
    const value = fn(lock);
    if (value && typeof value.then === 'function') return Promise.resolve(value).finally(() => lock.release());
    lock.release(); return value;
  } catch (error) {
    try { lock.release(); } catch { /* Do not remove a replaced lock. */ }
    throw error;
  }
}
