import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PREFERENCE_DEFAULTS, readDevicePreferences, saveDevicePreferences } from '../src/core/device-preferences.js';
import { acquireConfigurationLock } from '../src/core/device-config.js';
import { DeviceAutomationSettings } from '../src/core/device-automation.js';
import { temp } from './helpers.js';

function fixture() {
  const root = temp(), config = { home: path.join(root, 'project', '.lush'), deviceHome: path.join(root, 'device', 'shared') };
  return { root, config, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('preferences are device-authoritative, private and backend revisions prevent stale cache overwrites', () => {
  const f = fixture();
  try {
    const initial = readDevicePreferences(f.config);
    expect(initial).toMatchObject({ version: 1, values: PREFERENCE_DEFAULTS });
    expect(initial.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(f.config.deviceHome)).toBe(false);
    initial.values.noticeChannels.created.system = false;
    expect(readDevicePreferences(f.config).values.noticeChannels.created.system).toBe(true);
    const next = saveDevicePreferences(f.config, { theme: 'dark', polling: 'power', sidebarSort: 'id' }, initial.revision);
    expect(next.revision).not.toBe(initial.revision);
    expect(() => saveDevicePreferences(f.config, { theme: 'light' }, initial.revision)).toThrow('revision changed');
    const other = { ...f.config, home: path.join(f.root, 'another-project', '.lush') };
    expect(readDevicePreferences(other)).toEqual(next);
    expect(fs.existsSync(f.config.home)).toBe(false);
    expect(fs.statSync(f.config.deviceHome).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(f.config.deviceHome, 'preferences.json')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(f.config.deviceHome)).toEqual(['preferences.json']);
    const value = JSON.parse(fs.readFileSync(path.join(f.config.deviceHome, 'preferences.json')));
    expect(value).toEqual({ version: 1, values: { theme: 'dark', polling: 'power', sidebarSort: 'id' } });
  } finally { f.close(); }
});

test('whitelisted preferences reject malformed data and coordinate with the shared settings lock', () => {
  const f = fixture();
  try {
    const before = readDevicePreferences(f.config);
    for (const patch of [{ project: '/elsewhere' }, { theme: 'invalid' }, { markdown: 1 },
      { noticeChannels: { created: { banner: false, system: true } } }, { sidebarSort: 'alphabetical' }, null])
      expect(() => saveDevicePreferences(f.config, patch, before.revision)).toThrow();
    expect(fs.existsSync(f.config.deviceHome)).toBe(false);
    const lock = acquireConfigurationLock(f.config, 'device');
    try { expect(() => saveDevicePreferences(f.config, { markdown: false }, before.revision)).toThrow('busy'); }
    finally { lock.release(); }
    expect(fs.readdirSync(f.config.deviceHome)).toEqual([]);
    const channels = structuredClone(before.values.noticeChannels); channels.failed.system = false;
    const next = saveDevicePreferences(f.config, { noticeChannels: channels }, before.revision);
    expect(next.values.noticeChannels.failed.system).toBe(false);
    expect(next.values.noticeChannels.created.banner).toBe(true);
  } finally { f.close(); }
});

test('unsafe preference files, aliases, hardlinks, broad modes and corrupt JSON fail closed without repair', () => {
  for (const kind of ['root-mode', 'root-link', 'file-mode', 'file-link', 'hardlink', 'corrupt', 'oversized', 'unknown']) {
    const f = fixture();
    try {
      const initial = readDevicePreferences(f.config); saveDevicePreferences(f.config, { theme: 'dark' }, initial.revision);
      const file = path.join(f.config.deviceHome, 'preferences.json');
      const external = path.join(f.root, 'external'); fs.writeFileSync(external, 'PRIVATE DO NOT READ', { mode: 0o600 });
      if (kind === 'root-mode') fs.chmodSync(f.config.deviceHome, 0o755);
      if (kind === 'root-link') { const moved = f.config.deviceHome + '-original'; fs.renameSync(f.config.deviceHome, moved); fs.symlinkSync(moved, f.config.deviceHome); }
      if (kind === 'file-mode') fs.chmodSync(file, 0o644);
      if (kind === 'file-link' || kind === 'hardlink') { fs.unlinkSync(file); kind === 'file-link' ? fs.symlinkSync(external, file) : fs.linkSync(external, file); }
      if (kind === 'corrupt') fs.writeFileSync(file, 'PRIVATE INVALID JSON');
      if (kind === 'oversized') fs.writeFileSync(file, 'x'.repeat(16385));
      if (kind === 'unknown') fs.writeFileSync(file, JSON.stringify({ version: 1, values: { secret: 'PRIVATE' } }));
      expect(() => readDevicePreferences(f.config)).toThrow();
      expect(() => saveDevicePreferences(f.config, { theme: 'light' }, initial.revision)).toThrow();
      expect(fs.readFileSync(external, 'utf8')).toBe('PRIVATE DO NOT READ');
    } finally { f.close(); }
  }
});

test('preferences and device automation share the final policy-write lock but keep independent revisions', () => {
  const f = fixture();
  try {
    const automation = new DeviceAutomationSettings(f.config);
    const before = readDevicePreferences(f.config), policy = automation.get();
    automation.withPolicy(() => {
      expect(() => saveDevicePreferences(f.config, { theme: 'dark' }, before.revision)).toThrow('busy');
    });
    expect(readDevicePreferences(f.config)).toEqual(before);
    const changed = saveDevicePreferences(f.config, { theme: 'dark' }, before.revision);
    expect(automation.get()).toEqual(policy);
    automation.save({ auto_select: { enabled: true } }, policy.revision);
    expect(readDevicePreferences(f.config)).toEqual(changed);
    const lock = acquireConfigurationLock(f.config, 'device');
    try {
      expect(() => automation.save({ auto_select: { enabled: false } }, automation.get().revision)).toThrow('busy');
    } finally { lock.release(); }
    expect(automation.get().auto_select.enabled).toBe(true);
  } finally { f.close(); }
});

test('cross-process preference saves cannot both publish against the same revision', async () => {
  const f = fixture();
  try {
    const before = readDevicePreferences(f.config), module = path.resolve('src/core/device-preferences.js');
    const children = ['dark', 'light'].map(theme => Bun.spawn([process.execPath, '--eval', `
      import {saveDevicePreferences} from ${JSON.stringify(module)};
      try { saveDevicePreferences(${JSON.stringify(f.config)}, {theme:${JSON.stringify(theme)}}, ${JSON.stringify(before.revision)}); console.log('saved'); }
      catch { console.log('rejected'); }
    `], { stdout: 'pipe', stderr: 'pipe' }));
    const results = await Promise.all(children.map(async child => ({ code: await child.exited,
      out: (await new Response(child.stdout).text()).trim(), err: await new Response(child.stderr).text() })));
    expect(results.map(row => row.code)).toEqual([0, 0]); expect(results.map(row => row.err)).toEqual(['', '']);
    expect(results.map(row => row.out).sort()).toEqual(['rejected', 'saved']);
    expect(['dark', 'light']).toContain(readDevicePreferences(f.config).values.theme);
    expect(fs.readdirSync(f.config.deviceHome)).toEqual(['preferences.json']);
  } finally { f.close(); }
});
