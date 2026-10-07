import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.js';
import { configurationHome, scopedConfiguration, configurationScope, normalizeConfigurationScope,
  ensureConfigurationDirectory, acquireConfigurationLock, withConfigurationWriteLock } from '../src/core/device-config.js';

function fixture() {
  const root = temp(), config = { project: root, home: path.join(root, '.lush'), deviceHome: path.join(root, 'device', 'shared'),
    env: { LUSH_PROJECT: root, LUSH_HOME: path.join(root, '.lush') } };
  return { root, config, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('scoped storage preserves project identity, environment and the original config', () => {
  const f = fixture();
  try {
    expect(configurationHome(f.config)).toBe(f.config.home);
    expect(configurationHome(f.config, 'device')).toBe(f.config.deviceHome);
    const scoped = scopedConfiguration(f.config, 'device');
    expect(scoped.home).toBe(f.config.deviceHome);
    expect(scoped.project).toBe(f.root);
    expect(scoped.env.LUSH_HOME).toBe(f.config.home);
    expect(scoped.deviceHome).toBeNull();
    expect(f.config.home).toBe(f.config.env.LUSH_HOME);
    expect(configurationScope(f.config, 'project', 'device')).toEqual({ selected: 'project', source: 'device',
      device_home: f.config.deviceHome, project_home: f.config.home, project_override: false });
    expect(() => normalizeConfigurationScope('all')).toThrow();
    expect(() => configurationHome({ home: f.config.home }, 'device')).toThrow();
  } finally { f.close(); }
});

test('private configuration roots refuse symlinks and unsafe modes', () => {
  const f = fixture();
  try {
    const home = ensureConfigurationDirectory(f.config, 'device');
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    fs.chmodSync(home, 0o755);
    expect(() => ensureConfigurationDirectory(f.config, 'device')).toThrow();
    fs.chmodSync(home, 0o700);
    const alias = path.join(f.root, 'alias'); fs.symlinkSync(home, alias);
    expect(() => ensureConfigurationDirectory({ home: alias })).toThrow();
    expect(() => ensureConfigurationDirectory({ home: path.join(alias, 'must-not-create') })).toThrow();
    expect(fs.existsSync(path.join(home, 'must-not-create'))).toBe(false);
    const dangling = path.join(f.root, 'dangling'); fs.symlinkSync(path.join(f.root, 'missing'), dangling);
    expect(() => ensureConfigurationDirectory({ home: path.join(dangling, 'must-not-create') })).toThrow();
    expect(fs.existsSync(path.join(f.root, 'missing'))).toBe(false);
  } finally { f.close(); }
});

test('cross-instance lock is exclusive and sync errors release only owned locks', () => {
  const f = fixture();
  try {
    const lock = acquireConfigurationLock(f.config, 'device');
    expect(() => acquireConfigurationLock({ ...f.config }, 'device')).toThrow('busy');
    lock.assert(); lock.release(); lock.release();
    expect(() => withConfigurationWriteLock(f.config, 'device', () => { throw new Error('expected'); })).toThrow('expected');
    expect(withConfigurationWriteLock(f.config, 'device', () => 42)).toBe(42);
  } finally { f.close(); }
});

test('async writes retain locks through settlement and release rejected operations', async () => {
  const f = fixture();
  try {
    let finish;
    const write = withConfigurationWriteLock(f.config, 'device', () => new Promise(resolve => { finish = resolve; }));
    expect(() => acquireConfigurationLock(f.config, 'device')).toThrow('busy');
    finish('saved'); expect(await write).toBe('saved');
    await expect(withConfigurationWriteLock(f.config, 'device', async () => { throw new Error('expected'); })).rejects.toThrow('expected');
    const lock = acquireConfigurationLock(f.config, 'device'); lock.release();
  } finally { f.close(); }
});
