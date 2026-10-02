import { test, expect } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { createNoticeNotifier, initNoticeNotifications, notificationStatus, setNoticeNotifications, observeNotices, resetNoticeNotifier } from '../../src/ui/web/assets/notice-notifications.js';
import { readPref, setPref, resetPrefs, normalizeNoticeChannels, PREF_DEFS } from '../../src/ui/web/assets/prefs.js';

const notice = (id, status = 'open', kind = 'question') => ({ id, status, kind, title: `question ${id}`, created_at: String(id) });
const data = (notices, project = '/tmp/one') => ({ status: { project }, notices });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('notification observer: baseline, disabled, new decisions, dedupe, reconnect and project isolation', async () => {
  const sent = []; let enabled = false;
  const observe = createNoticeNotifier({ enabled: () => enabled, send: (row, project) => sent.push([row.id, project]) });
  observe(data([notice(1)]));
  observe(data([notice(2), notice(1)]));
  enabled = true;
  observe(data([notice(2), notice(1)]));
  observe(data([notice(6, 'open', 'plan'), notice(5, 'open', 'questionnaire'), notice(4, 'sent', 'info'), notice(3, 'answered'), notice(2)]));
  observe(data([notice(6), notice(5)]));
  observe(data([notice(1)], '/tmp/two'));
  observe(data([notice(2)], '/tmp/two'));
  await flush();
  expect(sent).toEqual([[6, '/tmp/one'], [5, '/tmp/one'], [2, '/tmp/two']]);
});

test('browser permission is opt-in, rejection safe, click opens records, toggling off keeps records untouched', async () => {
  const dom = installDom();
  const previous = globalThis.Notification;
  let permission = 'default', requests = 0; const banners = [];
  class FakeNotification {
    static get permission() { return permission; }
    static async requestPermission() { requests++; return permission; }
    constructor(title, options) { this.title = title; this.options = options; banners.push(this); }
    close() { this.closed = true; }
  }
  globalThis.Notification = FakeNotification;
  try {
    expect(readPref('noticeNotifications')).toBe(false);
    resetNoticeNotifier(); observeNotices(data([])); observeNotices(data([notice(1)])); await flush();
    expect(requests).toBe(0); expect(banners).toHaveLength(0);
    permission = 'denied'; expect(await setNoticeNotifications(true)).toBe(false);
    expect(notificationStatus()).toContain('未获授权');
    permission = 'granted'; expect(await setNoticeNotifications(true)).toBe(true);
    observeNotices(data([notice(2)])); await flush();
    expect(banners).toHaveLength(1);
    banners[0].onclick(); expect(dom.location.hash).toBe('#notices'); expect(banners[0].closed).toBe(true);
    observeNotices(data([notice(2)])); await flush(); expect(banners).toHaveLength(1);
    await setNoticeNotifications(false); observeNotices(data([notice(3)])); await flush();
    expect(banners).toHaveLength(1);
    // Reload never resends the currently open historical backlog.
    resetNoticeNotifier(); setPref('noticeNotifications', true); observeNotices(data([notice(3)])); await flush();
    expect(banners).toHaveLength(1);
    delete globalThis.Notification;
    expect(await setNoticeNotifications(true)).toBe(false);
    expect(notificationStatus()).toContain('不支持');
  } finally { if (previous === undefined) delete globalThis.Notification; else globalThis.Notification = previous; dom.restore(); }
});

test('lifecycle info observer includes new unread only, never historical/read backlog', async () => {
  const sent = [];
  const info = (id, extra = {}) => ({ ...notice(id, 'sent', 'info'), task_id: 4, source_event_id: id + 100, read_at: null, ...extra });
  const observe = createNoticeNotifier({ enabled: () => true, send: row => sent.push(row.id) });
  observe(data([info(1)]));
  observe(data([info(2), info(3, { read_at: 'already read' }), info(4, { source_event_id: null }), info(5, { source_event_id: -1 })]));
  observe(data([info(2)]));
  observe(data([info(6)], '/tmp/two'));
  observe(data([info(7)], '/tmp/two'));
  await flush(); expect(sent).toEqual([2, 7]);
});

test('browser lifecycle notice click preserves source project path and uses a numeric Notice route', async () => {
  const dom = installDom(); const previous = globalThis.Notification; const banners = [];
  class FakeNotification {
    static permission = 'granted';
    constructor(_title, options) { this.options = options; banners.push(this); }
    close() { this.closed = true; }
  }
  globalThis.Notification = FakeNotification;
  try {
    setPref('noticeNotifications', true); dom.location.pathname = '/p/abcdef0123456789/';
    resetNoticeNotifier(); observeNotices(data([]));
    observeNotices(data([{ ...notice(100, 'sent', 'info'), task_id: 4, source_event_id: 100, read_at: null }]));
    await flush(); expect(banners).toHaveLength(1);
    banners[0].onclick(); expect(dom.location.hash).toBe('#notice-100');
    dom.location.pathname = '/p/1111111111111111/';
    banners[0].onclick(); expect(dom.location.href).toBe('/p/abcdef0123456789/#notice-100');
  } finally { if (previous === undefined) delete globalThis.Notification; else globalThis.Notification = previous; dom.restore(); }
});

test('desktop preference restores independently of origin and reset disables native channel', async () => {
  const dom = installDom(); let saved = true; const sent = [];
  dom.window.lushDesktop = {
    async notificationSettings(enabled) { if (enabled !== undefined) saved = enabled; return { enabled: saved }; },
    async notifyNotice(payload) { sent.push(payload); return true; },
  };
  try {
    await initNoticeNotifications(); expect(readPref('noticeNotifications')).toBe(true);
    resetNoticeNotifier(); observeNotices(data([])); observeNotices(data([notice(1)])); await flush();
    expect(sent).toHaveLength(1);
    resetPrefs(); await flush(); expect(saved).toBe(false);
  } finally { dom.restore(); }
});

test('noticeChannels defaults/normalization/reset and unavailable localStorage preserve client choices', () => {
  const dom = installDom();
  try {
    expect(readPref('noticeNotifications')).toBe(false);
    expect(readPref('noticeChannels')).toEqual(normalizeNoticeChannels());
    localStorage.setItem(PREF_DEFS.noticeChannels.key, '{broken');
    expect(readPref('noticeChannels')).toEqual(normalizeNoticeChannels());
    localStorage.setItem(PREF_DEFS.noticeChannels.key, JSON.stringify({ idle: { banner: false, system: 'false' }, failed: null, future: { banner: false } }));
    expect(readPref('noticeChannels')).toEqual({ idle: { banner: false, system: true }, analysis: { banner: true, system: true }, failed: { banner: true, system: true } });
    const storage = globalThis.localStorage;
    globalThis.localStorage = { getItem() { throw Error('private'); }, setItem() { throw Error('private'); }, removeItem() { throw Error('private'); } };
    setPref('noticeChannels', { failed: { banner: false, system: false } });
    expect(readPref('noticeChannels').failed).toEqual({ banner: false, system: false });
    resetPrefs(); expect(readPref('noticeChannels')).toEqual(normalizeNoticeChannels());
    globalThis.localStorage = storage;
  } finally { dom.restore(); }
});

test('classification/channel observer filtering consumes disabled notices without replay; decisions and unknown classes stay enabled', async () => {
  const dom = installDom(), sent = [];
  try {
    const info = (id, type) => ({ ...notice(id, 'sent', 'info'), task_id: 4, source_event_id: id + 100, read_at: null, lifecycle_type: type });
    const observe = createNoticeNotifier({ enabled: () => true, send: row => sent.push(row.id) });
    setPref('noticeChannels', { idle: { system: false }, analysis: { system: false }, failed: { system: false } });
    observe(data([info(1, 'idle')]));
    observe(data([info(2, 'idle'), info(3, 'analysis'), info(4, 'failed'), info(5, 'future'), info(6, null), notice(7)]));
    await flush(); expect(sent).toEqual([5, 6, 7]);
    setPref('noticeChannels', normalizeNoticeChannels());
    observe(data([info(2, 'idle'), info(3, 'analysis'), info(4, 'failed'), info(8, 'analysis')]));
    await flush(); expect(sent).toEqual([5, 6, 7, 8]);
    // Banner-only preference never suppresses OS notifications.
    setPref('noticeChannels', { failed: { banner: false, system: true } });
    observe(data([info(9, 'failed')])); await flush(); expect(sent.at(-1)).toBe(9);
    observe(data([info(10, 'failed')]));
    setPref('noticeChannels', { failed: { system: false } });
    await flush(); expect(sent).not.toContain(10);
  } finally { dom.restore(); }
});

test('deliver rechecks channels after a cross-tab lock wait and desktop preferences restore without writeback', async () => {
  const dom = installDom(), sent = [], writes = [];
  let channels = normalizeNoticeChannels({ failed: { banner: false, system: false } });
  const previousNavigator = globalThis.navigator;
  let deliver;
  globalThis.navigator = { locks: { request: async (_key, run) => { deliver = run; } } };
  dom.window.lushDesktop = {
    async notificationSettings() { return { enabled: true }; },
    async noticePreferences(value) { if (value !== undefined) { channels = value; writes.push(value); } return channels; },
    async notifyNotice(payload) { sent.push(payload); return true; },
  };
  try {
    await initNoticeNotifications();
    expect(readPref('noticeChannels').failed).toEqual({ banner: false, system: false });
    expect(writes).toEqual([]);
    setPref('noticeChannels', { failed: { banner: true, system: true } }); await flush();
    expect(channels.failed).toEqual({ banner: true, system: true });
    resetNoticeNotifier(); observeNotices(data([]));
    const row = { ...notice(200, 'sent', 'info'), source_event_id: 200, task_id: 4, read_at: null, lifecycle_type: 'failed' };
    observeNotices(data([row])); await flush(); expect(deliver).toBeFunction();
    setPref('noticeChannels', { failed: { system: false } }); await deliver();
    expect(sent).toEqual([]);
    resetPrefs(); await flush(); expect(channels).toEqual(normalizeNoticeChannels());
    delete dom.window.lushDesktop.noticePreferences;
    setPref('noticeChannels', { idle: { banner: false } }); await initNoticeNotifications();
    expect(readPref('noticeChannels').idle.banner).toBe(false);
  } finally { globalThis.navigator = previousNavigator; dom.restore(); }
});

test('late desktop restoration from another Host cannot overwrite or write back the new Host settings', async () => {
  const dom = installDom(); let finishOld; const writes = [];
  const current = normalizeNoticeChannels({ analysis: { banner: false } });
  dom.window.lushDesktop = {
    async notificationSettings() { await new Promise(resolve => { finishOld = resolve; }); return { enabled: true }; },
    async noticePreferences(value) { if (value !== undefined) writes.push(['old', value]); return normalizeNoticeChannels(); },
  };
  try {
    const oldInit = initNoticeNotifications();
    dom.window.lushDesktop = {
      async notificationSettings(value) { if (value !== undefined) writes.push(['new-global', value]); return { enabled: false }; },
      async noticePreferences(value) { if (value !== undefined) writes.push(['new-channels', value]); return current; },
    };
    await initNoticeNotifications(); finishOld(); await oldInit;
    expect(readPref('noticeNotifications')).toBe(false); expect(readPref('noticeChannels')).toEqual(current);
    expect(writes).toEqual([]);
  } finally { dom.restore(); }
});
