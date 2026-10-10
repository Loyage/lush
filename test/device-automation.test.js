import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { DeviceAutomationSettings } from '../src/core/device-automation.js';
import { temp, env } from './helpers.js';

function setup() {
  const root = temp(), home = path.join(root, 'shared');
  const config = { home: path.join(root, 'project-home'), deviceHome: home };
  return { root, home, config, settings: new DeviceAutomationSettings(config),
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
const auto = (settings, enabled) => settings.save({ auto_select: { enabled } }, settings.get().revision);

test('device automation reads exact defaults without initializing storage or importing project policy', () => {
  const f = setup();
  try {
    fs.mkdirSync(f.config.home, { mode: 0o700 });
    fs.writeFileSync(path.join(f.config.home, 'automation.json'), '{"auto_select":{"enabled":true}}');
    const value = f.settings.get();
    expect(value).toEqual({ version: 1, revision: expect.any(String), auto_select: { enabled: false },
      completion_defaults: { enabled: false, level: 'merge' } });
    expect(f.settings.get()).toEqual(value);
    expect(Object.keys(value)).toEqual(['version', 'revision', 'auto_select', 'completion_defaults']);
    expect(fs.existsSync(f.home)).toBe(false);
    expect(f.config.home).toBe(path.join(f.root, 'project-home'));
    expect(() => new DeviceAutomationSettings({ home: 'relative' })).toThrow('unavailable');
  } finally { f.close(); }
});

test('partial device policy saves preserve the other policy and use private atomic storage', () => {
  const f = setup();
  try {
    const first = auto(f.settings, true);
    const second = f.settings.save({ completion_defaults: { level: 'archive' } }, first.revision);
    expect(second).toMatchObject({ auto_select: { enabled: true }, completion_defaults: { enabled: false, level: 'archive' } });
    const third = f.settings.save({ completion_defaults: { enabled: true }, auto_select: { enabled: false } }, second.revision);
    expect(third).toMatchObject({ auto_select: { enabled: false }, completion_defaults: { enabled: true, level: 'archive' } });
    expect(new DeviceAutomationSettings({ home: f.home }).get()).toEqual(third);
    expect(fs.statSync(f.home).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(f.home, 'automation.json')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(f.home)).toEqual(['automation.json']);
    expect(third).not.toHaveProperty('generation');
  } finally { f.close(); }
});

test('malformed policy patches are rejected before making a directory', () => {
  const f = setup();
  try {
    const revision = f.settings.get().revision;
    for (const patch of [null, [], {}, { enabled: true }, { auto_select: null }, { auto_select: {} },
      { auto_select: { enabled: 1 } }, { auto_select: { enabled: true, target: 'all' } },
      { completion_defaults: { enabled: 'true' } }, { completion_defaults: { level: 'off' } },
      { completion_defaults: {} }, { completion_defaults: { authorization: 'private' } }])
      expect(() => f.settings.save(patch, revision)).toThrow();
    expect(() => f.settings.save({ auto_select: { enabled: true } }, null)).toThrow('revision');
    expect(fs.existsSync(f.home)).toBe(false);
  } finally { f.close(); }
});

test('shared revision rejects stale, concurrent, ABA and same-value authorization edits', async () => {
  const f = setup(), other = new DeviceAutomationSettings(f.config);
  try {
    const initial = f.settings.get();
    const results = await Promise.allSettled([
      Promise.resolve().then(() => f.settings.save({ auto_select: { enabled: true } }, initial.revision)),
      Promise.resolve().then(() => other.save({ completion_defaults: { enabled: true } }, initial.revision)),
    ]);
    expect(results.map(value => value.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1].reason.message).toContain('revision changed');
    const enabled = f.settings.get(), same = auto(other, true);
    expect(same.revision).not.toBe(enabled.revision);
    const disabled = auto(other, false);
    expect(disabled.revision).not.toBe(initial.revision);
    expect(() => f.settings.save({ auto_select: { enabled: true } }, initial.revision)).toThrow('revision changed');
    expect(fs.readdirSync(f.home)).toEqual(['automation.json']);
  } finally { f.close(); }
});

test('policy callbacks and close writes share one lock, release on throw and never hold across async work', () => {
  const f = setup(), other = new DeviceAutomationSettings(f.config);
  try {
    auto(f.settings, true);
    const before = other.get();
    const result = f.settings.withPolicy(value => {
      expect(value).toEqual(before);
      expect(() => other.save({ auto_select: { enabled: false } }, before.revision)).toThrow('busy');
      expect(fs.existsSync(path.join(f.home, '.settings-write.lock'))).toBe(true);
      return 'committed under enabled authorization';
    });
    expect(result).toBe('committed under enabled authorization');
    expect(fs.existsSync(path.join(f.home, '.settings-write.lock'))).toBe(false);
    expect(auto(other, false).auto_select.enabled).toBe(false);
    expect(() => f.settings.withPolicy(() => { throw new Error('test failure'); })).toThrow('test failure');
    expect(fs.existsSync(path.join(f.home, '.settings-write.lock'))).toBe(false);
    expect(() => f.settings.withPolicy(async () => {})).toThrow('synchronous');
    expect(() => f.settings.withPolicy(() => Promise.resolve())).toThrow('synchronous');
    expect(fs.existsSync(path.join(f.home, '.settings-write.lock'))).toBe(false);
  } finally { f.close(); }
});

test('unknown existing locks are never removed or stolen', () => {
  const f = setup();
  try {
    auto(f.settings, true);
    const file = path.join(f.home, '.settings-write.lock');
    fs.mkdirSync(file, { mode: 0o700 });
    const before = fs.statSync(file);
    expect(() => auto(f.settings, false)).toThrow('busy');
    expect(fs.statSync(file).ino).toBe(before.ino);
    expect(f.settings.get().auto_select.enabled).toBe(true);
  } finally { f.close(); }
});

for (const kind of ['invalid-json', 'unknown-field', 'wrong-version', 'public-file', 'symlink', 'hardlink', 'oversized'])
  test(`unsafe or corrupted ${kind} configuration is fail-closed, never repaired or exposed`, () => {
    const f = setup();
    try {
      const initial = f.settings.get(); auto(f.settings, true);
      const file = path.join(f.home, 'automation.json');
      if (kind === 'invalid-json') fs.writeFileSync(file, '{secret raw invalid data');
      if (kind === 'unknown-field') {
        const value = JSON.parse(fs.readFileSync(file)); value.secret = 'private content'; fs.writeFileSync(file, JSON.stringify(value));
      }
      if (kind === 'wrong-version') {
        const value = JSON.parse(fs.readFileSync(file)); value.version = 2; fs.writeFileSync(file, JSON.stringify(value));
      }
      if (kind === 'public-file') fs.chmodSync(file, 0o644);
      if (kind === 'oversized') fs.writeFileSync(file, 'private'.repeat(10000));
      if (kind === 'symlink' || kind === 'hardlink') {
        const source = path.join(f.root, 'other.json'); fs.renameSync(file, source);
        if (kind === 'symlink') fs.symlinkSync(source, file);
        else fs.linkSync(source, file);
      }
      const original = fs.readFileSync(file, 'utf8');
      expect(() => f.settings.get()).toThrow('unavailable or invalid');
      try { f.settings.get(); } catch (error) { expect(error.message).not.toContain('secret'); expect(error.message).not.toContain('private content'); }
      expect(() => f.settings.save({ auto_select: { enabled: false } }, initial.revision)).toThrow('unavailable or invalid');
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
      expect(fs.existsSync(path.join(f.home, '.settings-write.lock'))).toBe(false);
    } finally { f.close(); }
  });

test('unsafe roots are rejected without following or changing their permissions', () => {
  const f = setup();
  try {
    fs.mkdirSync(f.home, { mode: 0o755 }); fs.chmodSync(f.home, 0o755);
    expect(() => f.settings.get()).toThrow('unavailable or invalid');
    expect(() => auto(f.settings, true)).toThrow();
    expect(fs.statSync(f.home).mode & 0o777).toBe(0o755);
    fs.rmdirSync(f.home); fs.mkdirSync(path.join(f.root, 'destination'), { mode: 0o700 });
    fs.symlinkSync(path.join(f.root, 'destination'), f.home);
    expect(() => f.settings.get()).toThrow('unavailable or invalid');
    expect(() => f.settings.save({ auto_select: { enabled: true } }, 'revision')).toThrow();
    expect(fs.readdirSync(path.join(f.root, 'destination'))).toEqual([]);
  } finally { f.close(); }
});

test('the authorization lock excludes writes from an independent process, not only same-process instances', async () => {
  const f = setup(); let process;
  try {
    auto(f.settings, true);
    const module = path.resolve('src/core/device-automation.js');
    process = Bun.spawn([Bun.which('bun'), '--eval', `
      import { DeviceAutomationSettings } from ${JSON.stringify(module)};
      const settings = new DeviceAutomationSettings({ home: process.env.TEST_DEVICE_HOME });
      settings.withPolicy(() => {
        console.log('locked');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      });
    `], { env: env({ TEST_DEVICE_HOME: f.home }), stdout: 'pipe', stderr: 'pipe' });
    const reader = process.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('locked');
    expect(() => auto(f.settings, false)).toThrow('busy');
    expect(await process.exited).toBe(0);
    await reader.cancel();
    expect(auto(f.settings, false).auto_select.enabled).toBe(false);
    expect(fs.existsSync(path.join(f.home, '.settings-write.lock'))).toBe(false);
  } finally { if (process && process.exitCode === null) { process.kill(); await process.exited; } f.close(); }
}, 10000);
