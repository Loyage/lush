import { test, expect } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { until } from '../helpers.js';
import { readPref, setPref } from '../../src/ui/web/assets/prefs.js';
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };

test('cached notification authorization never starts Host observation before authoritative preferences succeed', async () => {
  const world = makeWorld(), pending = deferred(), calls = [];
  const dom = installDom({ fetch: (url, options) => {
    calls.push(String(url)); return String(url) === '/api/host/preferences' ? pending.promise : world.fetchImpl(url, options);
  } });
  try {
    setPref('noticeNotifications', true);
    const { boot } = await import('../../src/ui/web/assets/app.js'); await boot();
    expect(calls.some(url => url.startsWith('/api/host/inbox'))).toBe(false);
    pending.resolve(await world.fetchImpl('/api/host/preferences'));
    await until(() => calls.some(url => url.startsWith('/api/host/inbox')));
    await (await import('../../src/ui/web/assets/global-notice-notifications.js')).refreshGlobalNotices();
    expect(readPref('noticeNotifications')).toBe(false);
    expect(calls.some(url => url.startsWith('/api/overview'))).toBe(false);
  } finally { dom.restore(); }
});

test('failed initial preference read leaves reminders gated until an explicit successful reread', async () => {
  const world = makeWorld(), calls = []; let fail = true;
  const dom = installDom({ fetch: (url, options) => {
    calls.push(String(url));
    return String(url) === '/api/host/preferences' && fail ? Response.json({ error: 'Host offline' }, { status: 503 }) : world.fetchImpl(url, options);
  } });
  try {
    setPref('noticeNotifications', true); const { boot } = await import('../../src/ui/web/assets/app.js'); await boot();
    const { devicePreferencesStatus, refreshDevicePreferences } = await import('../../src/ui/web/assets/prefs.js');
    await until(() => devicePreferencesStatus().error);
    expect(calls.some(url => url.startsWith('/api/host/inbox'))).toBe(false);
    fail = false; await refreshDevicePreferences(); await until(() => calls.some(url => url.startsWith('/api/host/inbox')));
    await (await import('../../src/ui/web/assets/global-notice-notifications.js')).refreshGlobalNotices();
    expect(readPref('noticeNotifications')).toBe(false);
  } finally { dom.restore(); }
});

test('detached boot, delayed preference reply and old global timers cannot observe or repaint a replacement document', async () => {
  const firstWorld = makeWorld(), pending = deferred(), oldCalls = [];
  firstWorld.state.devicePreferences.values.noticeNotifications = true;
  const first = installDom({ fetch: (url, options) => {
    oldCalls.push(String(url)); return String(url) === '/api/host/preferences' ? pending.promise : firstWorld.fetchImpl(url, options);
  } });
  let replacement;
  try {
    const { boot } = await import('../../src/ui/web/assets/app.js'); await boot();
    const oldPreferences = first.intervalFor(5000), oldAutomation = first.intervalFor(3000);
    const secondWorld = makeWorld(), newCalls = [];
    replacement = installDom({ fetch: (url, options) => { newCalls.push(String(url)); return secondWorld.fetchImpl(url, options); } });
    await boot(); await until(() => newCalls.some(url => url.startsWith('/api/host/inbox')));
    await (await import('../../src/ui/web/assets/global-notice-notifications.js')).refreshGlobalNotices();
    const count = newCalls.length;
    await oldPreferences(); await oldAutomation();
    pending.resolve(await firstWorld.fetchImpl('/api/host/preferences')); await Promise.resolve(); await Promise.resolve();
    expect(newCalls.length).toBe(count); expect(oldCalls.some(url => url.startsWith('/api/host/inbox'))).toBe(false);
    expect(readPref('noticeNotifications')).toBe(false); expect(replacement.node('detail').dataset.view).toBe('projects');
    expect(replacement.intervalFor(1500)).toBeUndefined();
  } finally { replacement?.restore(); first.restore(); }
});
