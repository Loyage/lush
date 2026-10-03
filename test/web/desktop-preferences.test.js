import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installDom } from '../dom-stub.js';
import { ConnectionStore } from '../../src/ui/desktop/connections.js';
import * as prefs from '../../src/ui/web/assets/prefs.js';
import { initNoticeNotifications } from '../../src/ui/web/assets/notice-notifications.js';

const PROJECT = 'aaaaaaaaaaaaaaaa', OTHER = 'bbbbbbbbbbbbbbbb';
function fixture() {
  const dom = installDom(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-ui-prefs-'));
  const store = new ConnectionStore(dir), listeners = new Set(), writes = [];
  dom.location.pathname = `/p/${PROJECT}/`; dom.location.origin = 'http://127.0.0.1:4001';
  const bridge = { mode: 'local',
    async readPreferences() { return store.uiPreferences(PROJECT); },
    async writePreference(name, value) { writes.push([name, value]); const snapshot = store.uiPreferences(PROJECT, { name, value }); for (const fn of listeners) fn(snapshot); return snapshot; },
    async resetPreferences() { writes.push(['reset']); const snapshot = store.uiPreferences(PROJECT, { reset: true }); for (const fn of listeners) fn(snapshot); return snapshot; },
    onPreferencesChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async notificationSettings(value) { if (value !== undefined) store.setEnabled('local', value); return { enabled: store.enabled('local') }; },
    async noticePreferences(value) { return store.noticePreferences('local', value); },
  };
  dom.window.lushDesktop = bridge;
  return { dom, dir, store, bridge, writes, listeners, close: async () => {
    delete dom.window.lushDesktop; await prefs.initDesktopPreferences(); dom.restore(); fs.rmSync(dir, { recursive: true, force: true });
  } };
}

test('desktop initialization restores without writeback, protects pending input from late reads, and ignores stale/foreign broadcasts', async () => {
  const f = fixture();
  try {
    f.store.uiPreferences(PROJECT, { name: 'theme', value: 'dark' });
    f.store.uiPreferences(PROJECT, { name: 'sidebarSort', value: 'updated' });
    f.store.uiPreferences(PROJECT, { name: 'taskGraphCollapsed', value: '[1,2]' });
    localStorage.setItem(prefs.THEME_KEY, 'light'); // No migration from even the current origin.
    let release;
    const snapshot = f.store.uiPreferences(PROJECT);
    f.bridge.readPreferences = () => new Promise(resolve => { release = resolve; });
    const loading = prefs.initDesktopPreferences();
    await Promise.resolve();
    prefs.setPref('polling', 'power');
    release(snapshot); await loading; await prefs.flushDesktopPreferences();
    expect(prefs.readPref('theme')).toBe('dark');
    expect(prefs.readPref('sidebarSort')).toBe('updated');
    expect([...prefs.readPref('taskGraphCollapsed')]).toEqual([1, 2]);
    expect(prefs.readPref('polling')).toBe('power');
    expect(f.writes).toEqual([['polling', 'power']]); // Never push defaults or read snapshots to disk.
    const current = f.store.uiPreferences(PROJECT);
    for (const fn of f.listeners) { fn({ ...snapshot, values: { theme: 'light' } }); fn({ ...current, project: OTHER, revision: 999, values: { theme: 'light' } }); }
    expect(prefs.readPref('theme')).toBe('dark');
    const changed = f.store.uiPreferences(PROJECT, { name: 'theme', value: 'light' });
    for (const fn of f.listeners) fn(changed);
    expect(prefs.readPref('theme')).toBe('light');
    expect(f.writes).toHaveLength(1);
    // A new origin + a new preload instance still reads the same stable host/project record.
    f.dom.location.origin = 'http://127.0.0.1:9002';
    f.dom.window.lushDesktop = { ...f.bridge, readPreferences: async () => f.store.uiPreferences(PROJECT) };
    await prefs.initDesktopPreferences();
    expect(prefs.readPref('polling')).toBe('power');
    expect([...prefs.readPref('taskGraphCollapsed')]).toEqual([1, 2]);
  } finally { await f.close(); }
});

test('per-key queued writes/reset preserve other projects; existing notification reset IPC remains independent', async () => {
  const f = fixture();
  try {
    f.store.uiPreferences(OTHER, { name: 'sidebarSort', value: 'id' });
    f.store.setEnabled('local', true); f.store.noticePreferences('local', { failed: { banner: false, system: false } });
    await prefs.initDesktopPreferences(); await initNoticeNotifications();
    prefs.setPref('theme', 'dark'); prefs.writePref('taskGraphCollapsed', new Set([1, 2]));
    prefs.resetPrefs(); prefs.setPref('markdown', false);
    await prefs.flushDesktopPreferences();
    // Notification handlers are their own async IPC; await their completion too.
    await Promise.resolve();
    expect(f.store.uiPreferences(PROJECT).values).toEqual({ markdown: '0' });
    expect(f.store.uiPreferences(OTHER).values).toEqual({ markdown: '0', sidebarSort: 'id' });
    expect(prefs.readPref('theme')).toBe('system'); expect(prefs.readPref('markdown')).toBe(false);
    expect([...prefs.readPref('taskGraphCollapsed')]).toEqual([]);
    expect(f.store.enabled('local')).toBe(false);
    expect(f.store.noticePreferences('local').failed).toEqual({ banner: true, system: true });
    expect(f.writes.some(([name]) => name.startsWith('notice'))).toBe(false);
    // A later main-process reset from another local window updates cached values without a writeback.
    const cleared = f.store.uiPreferences(OTHER, { reset: true });
    for (const fn of f.listeners) fn(f.store.uiPreferences(PROJECT));
    expect(cleared.values).toEqual({}); expect(prefs.readPref('markdown')).toBe(true);
  } finally { await f.close(); }
});

test('failed reads/writes preserve disk and session choices; remote/browser clients retain origin storage', async () => {
  const f = fixture();
  try {
    f.store.uiPreferences(PROJECT, { name: 'theme', value: 'dark' });
    await prefs.initDesktopPreferences();
    const file = path.join(f.dir, 'ui-preferences.json'), original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{broken');
    await prefs.initDesktopPreferences(); expect(prefs.readPref('theme')).toBe('dark');
    prefs.setPref('theme', 'light');
    const status = await prefs.flushDesktopPreferences();
    expect(status.error).not.toBe(''); expect(prefs.readPref('theme')).toBe('light');
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
    fs.writeFileSync(file, original);
    await prefs.initDesktopPreferences(); expect(prefs.readPref('theme')).toBe('light');
    prefs.setPref('theme', 'light'); await prefs.flushDesktopPreferences();
    expect(f.store.uiPreferences(PROJECT).values.theme).toBe('light');
    const count = f.writes.length;
    prefs.setPref('polling', 'fast'); // Queued old-page writes must not follow a change of renderer identity.
    f.dom.window.lushDesktop = { ...f.bridge, mode: 'remote', readPreferences: () => { throw new Error('must not be called'); } };
    localStorage.setItem(prefs.THEME_KEY, 'dark'); await prefs.initDesktopPreferences();
    expect(prefs.preferenceStorageStatus().desktop).toBe(false);
    expect(prefs.readPref('theme')).toBe('dark'); prefs.setPref('theme', 'system');
    await Promise.resolve();
    expect(localStorage.getItem(prefs.THEME_KEY)).toBe('system'); expect(f.writes).toHaveLength(count);
  } finally { await f.close(); }
});
