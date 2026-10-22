import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PREFERENCE_DEFAULTS, readDevicePreferences, saveDevicePreferences } from '../src/core/device-preferences.js';
import { temp } from './helpers.js';

test('preferences are device-authoritative, private and backend revisions prevent stale cache overwrites', () => {
  const root = temp(), config = { home: path.join(root, 'project', '.lush'), deviceHome: path.join(root, 'device', 'shared') };
  try {
    const initial = readDevicePreferences(config);
    expect(initial).toMatchObject({ version: 1, values: PREFERENCE_DEFAULTS });
    expect(fs.existsSync(config.deviceHome)).toBe(false);
    const next = saveDevicePreferences(config, { theme: 'dark', polling: 'power', sidebarSort: 'id' }, initial.revision);
    expect(next.revision).not.toBe(initial.revision);
    expect(() => saveDevicePreferences(config, { theme: 'light' }, initial.revision)).toThrow('revision changed');
    expect(readDevicePreferences({ ...config, home: path.join(root, 'another-project', '.lush') })).toEqual(next);
    expect(fs.existsSync(config.home)).toBe(false);
    expect(fs.statSync(config.deviceHome).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(config.deviceHome, 'preferences.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(path.join(config.deviceHome, 'preferences.json')))).toEqual({
      version: 1, values: { theme: 'dark', polling: 'power', sidebarSort: 'id' },
    });
    // A historical four-category preference stays readable without rewriting its private file.
    const file = path.join(config.deviceHome, 'preferences.json');
    const legacy = Object.fromEntries(['created', 'idle', 'analysis', 'failed'].map(type => [type, { banner: false, system: false }]));
    fs.writeFileSync(file, JSON.stringify({ version: 1, values: { noticeChannels: legacy } }));
    const original = fs.readFileSync(file, 'utf8'), restored = readDevicePreferences(config);
    expect(restored.values.noticeChannels.idle).toEqual({ banner: false, system: false });
    expect(restored.values.noticeChannels.reported).toEqual({ banner: true, system: true });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    const channels = { ...restored.values.noticeChannels, reported: { banner: false, system: true } };
    const changed = saveDevicePreferences(config, { noticeChannels: channels }, restored.revision);
    const olderClient = saveDevicePreferences(config, { noticeChannels: legacy }, changed.revision);
    expect(olderClient.values.noticeChannels.reported).toEqual(channels.reported);
    expect(() => saveDevicePreferences(config, { noticeChannels: { ...channels, reported: { banner: 'off', system: true } } }, olderClient.revision)).toThrow();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
