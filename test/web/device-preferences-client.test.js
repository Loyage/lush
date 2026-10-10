import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installDom } from '../dom-stub.js';
import * as prefs from '../../src/ui/web/assets/prefs.js';

let dom, values, revision, calls, handle;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const model = () => ({ version: 1, revision, values: structuredClone(values) });
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
beforeEach(() => {
  calls = []; revision = 'r1';
  dom = installDom({ fetch: async (path, options) => {
    calls.push({ path: String(path), options });
    if (handle) return handle(String(path), options);
    if (options?.method === 'POST') {
      const { patch, expected_revision } = JSON.parse(options.body);
      if (expected_revision !== revision) return json({ error: '版本冲突' }, 409);
      values = { ...values, ...patch }; revision = `r${Number(revision.slice(1)) + 1}`;
    }
    return json(model());
  } });
  handle = null; prefs.resetPrefs();
  values = Object.fromEntries(prefs.DEVICE_PREF_NAMES.map(name => [name, prefs.readPref(name)]));
});
afterEach(() => dom.restore());

test('startup reads authoritative values without writing old cache back', async () => {
  prefs.setPref('theme', 'dark'); values.theme = 'light';
  await prefs.refreshDevicePreferences();
  expect(prefs.readPref('theme')).toBe('light');
  expect(prefs.devicePreferencesStatus()).toEqual({ ready: true, saving: false, error: '', revision: 'r1' });
  expect(calls).toHaveLength(1); expect(calls[0].path).toBe('/api/host/preferences'); expect(calls[0].options).toBeUndefined();
});

test('explicit device writes use root Host and revision from either project', async () => {
  dom.location.pathname = '/p/1111111111111111/';
  await prefs.refreshDevicePreferences();
  expect(await prefs.saveDevicePreference('sidebarSort', 'id')).toBe('id');
  dom.location.pathname = '/p/2222222222222222/';
  expect(prefs.readPref('sidebarSort')).toBe('id');
  expect(JSON.parse(calls[1].options.body)).toEqual({ patch: { sidebarSort: 'id' }, expected_revision: 'r1' });
  expect(calls.every(call => call.path === '/api/host/preferences')).toBe(true);
  await expect(prefs.saveDevicePreference('collapsed', new Set())).rejects.toThrow('不是设备偏好');
});

test('GET begun before an acknowledged write cannot undo the ACK', async () => {
  await prefs.refreshDevicePreferences(); const old = model(), gate = deferred();
  handle = async (_path, options) => {
    if (!options) return gate.promise;
    values.theme = 'dark'; revision = 'r2'; return json(model());
  };
  const read = prefs.refreshDevicePreferences();
  await prefs.saveDevicePreference('theme', 'dark'); gate.resolve(json(old)); await read;
  expect(prefs.readPref('theme')).toBe('dark'); expect(prefs.devicePreferencesStatus().revision).toBe('r2');
});

test('writes serialize and use the preceding ACK revision', async () => {
  await prefs.refreshDevicePreferences();
  await Promise.all([prefs.saveDevicePreference('theme', 'dark'), prefs.saveDevicePreference('polling', 'power')]);
  const posts = calls.filter(call => call.options?.method === 'POST');
  expect(posts.map(call => JSON.parse(call.options.body).expected_revision)).toEqual(['r1', 'r2']);
  expect(prefs.readPref('theme')).toBe('dark'); expect(prefs.readPref('polling')).toBe('power');
});

test('conflicting write is not retried or declared saved; explicit reread reconciles', async () => {
  await prefs.refreshDevicePreferences(); values.theme = 'light'; revision = 'r2';
  await expect(prefs.saveDevicePreference('theme', 'dark')).rejects.toThrow('版本冲突');
  expect(prefs.readPref('theme')).toBe('system'); expect(prefs.devicePreferencesStatus().error).toContain('版本冲突');
  expect(calls.filter(call => call.options?.method === 'POST')).toHaveLength(1);
  await prefs.refreshDevicePreferences(); expect(prefs.readPref('theme')).toBe('light'); expect(prefs.devicePreferencesStatus().error).toBe('');
});

test('malformed snapshot is validated as a whole and preserves cache', async () => {
  prefs.setPref('theme', 'dark');
  handle = () => json({ version: 1, revision: 'bad', values: { ...values, theme: 'light', noticeNotifications: 'yes' } });
  await expect(prefs.refreshDevicePreferences()).rejects.toThrow('有效值');
  expect(prefs.readPref('theme')).toBe('dark'); expect(prefs.devicePreferencesStatus().ready).toBe(false);
});

test('JSON object order is not treated as a changed or invalid channel value', async () => {
  values.noticeChannels = Object.fromEntries(Object.entries(values.noticeChannels).reverse().map(([key, value]) => [key, { system: value.system, banner: value.banner }]));
  await prefs.refreshDevicePreferences(); expect(prefs.devicePreferencesStatus().ready).toBe(true);
});

test('reset saves only device defaults and preserves scoped work state and legacy files', async () => {
  dom.location.pathname = '/p/1111111111111111/'; prefs.setPref('collapsed', new Set(['tasks']));
  localStorage.setItem('lush.sidebarSort:1111111111111111', 'updated');
  await prefs.saveDevicePreference('theme', 'dark'); const saved = await prefs.resetDevicePreferences();
  expect(saved.theme).toBe('system'); expect([...prefs.readPref('collapsed')]).toEqual(['tasks']);
  expect(localStorage.getItem('lush.sidebarSort:1111111111111111')).toBe('updated');
  const patch = JSON.parse(calls.at(-1).options.body).patch;
  expect(Object.keys(patch)).toEqual(prefs.DEVICE_PREF_NAMES); expect(patch.collapsed).toBeUndefined();
});

test('sync lifecycle is read-only and storage hints fetch authority instead of trusting local values', async () => {
  const dispose = prefs.startDevicePreferencesSync({ interval: 100000 });
  await prefs.refreshDevicePreferences(); values.theme = 'dark'; revision = 'r2';
  await dom.fire('storage', { key: 'lush.device-preferences-revision', newValue: 'attacker' });
  await prefs.refreshDevicePreferences(); dispose();
  expect(prefs.readPref('theme')).toBe('dark'); expect(calls).toHaveLength(2); expect(calls.every(call => !call.options)).toBe(true);
});

test('another tab updating shared cache cannot suppress this page authoritative change notification', async () => {
  await prefs.refreshDevicePreferences();
  const painted = [], dispose = prefs.onPrefChange('theme', value => painted.push(value));
  try {
    values.theme = 'dark'; revision = 'r2';
    localStorage.setItem(prefs.THEME_KEY, 'dark'); // Other tab wrote the cache before this page receives the revision hint.
    expect(prefs.readPref('theme')).toBe('dark'); expect(painted).toEqual([]);
    await prefs.refreshDevicePreferences(); expect(painted).toEqual(['dark']);
    await prefs.refreshDevicePreferences(); expect(painted).toEqual(['dark']);
    // A cache-only mutation is also reconciled even when the backend snapshot is unchanged.
    localStorage.setItem(prefs.THEME_KEY, 'light');
    await prefs.refreshDevicePreferences(); expect(painted).toEqual(['dark', 'dark']);
    expect(calls.every(call => !call.options)).toBe(true);
  } finally { dispose(); }
});

test('status subscribers see pending and settled saves without changing user work state', async () => {
  const statuses = [], dispose = prefs.onDevicePreferences(status => statuses.push(status));
  await prefs.saveDevicePreference('reduceMotion', true); dispose();
  expect(statuses.some(status => status.saving)).toBe(true);
  expect(statuses.at(-1)).toEqual({ ready: true, saving: false, error: '', revision: 'r2' });
});
