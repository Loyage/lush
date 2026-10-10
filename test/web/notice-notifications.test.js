import { test, expect } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { createNoticeNotifier, notificationStatus, setNoticeNotifications, observeNotices, resetNoticeNotifier } from '../../src/ui/web/assets/notice-notifications.js';
import { DEVICE_PREF_NAMES, readPref, setPref, resetPrefs, normalizeNoticeChannels, PREF_DEFS } from '../../src/ui/web/assets/prefs.js';

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

test('device switch and browser permission are separate; grants remain opt-in and records untouched', async () => {
  let revision = 0, values;
  const dom = installDom({ fetch: async (path, options) => {
    expect(String(path)).toBe('/api/host/preferences');
    if (options?.method === 'POST') { values = { ...values, ...JSON.parse(options.body).patch }; revision++; }
    return new Response(JSON.stringify({ version: 1, revision: `r${revision}`, values }));
  } });
  values = Object.fromEntries(DEVICE_PREF_NAMES.map(name => [name, readPref(name)]));
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
    permission = 'denied'; expect(await setNoticeNotifications(true)).toBe(true);
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
    expect(await setNoticeNotifications(true)).toBe(true);
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

test('noticeChannels defaults/normalization/reset and unavailable localStorage preserve client choices', () => {
  const dom = installDom();
  try {
    expect(readPref('noticeNotifications')).toBe(false);
    expect(readPref('noticeChannels')).toEqual(normalizeNoticeChannels());
    localStorage.setItem(PREF_DEFS.noticeChannels.key, '{broken');
    expect(readPref('noticeChannels')).toEqual(normalizeNoticeChannels());
    localStorage.setItem(PREF_DEFS.noticeChannels.key, JSON.stringify({ idle: { banner: false, system: 'false' }, failed: null, future: { banner: false } }));
    expect(readPref('noticeChannels')).toEqual({ created: { banner: true, system: true }, idle: { banner: false, system: true }, analysis: { banner: true, system: true }, failed: { banner: true, system: true } });
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

test('browser delivery rechecks channels after a cross-tab lock wait and deduplicates across page reloads', async () => {
  const dom = installDom(), sent = [];
  const previousNavigator = globalThis.navigator, previousNotification = globalThis.Notification;
  let deliver;
  globalThis.navigator = { locks: { request: async (_key, run) => { deliver = run; } } };
  globalThis.Notification = class {
    static permission = 'granted';
    constructor(title, options) { sent.push({ title, options }); }
  };
  try {
    setPref('noticeNotifications', true);
    resetNoticeNotifier(); observeNotices(data([]));
    const row = { ...notice(200, 'sent', 'info'), source_event_id: 200, task_id: 4, read_at: null, lifecycle_type: 'failed' };
    observeNotices(data([row])); await flush(); expect(deliver).toBeFunction();
    setPref('noticeChannels', { failed: { system: false } }); await deliver();
    expect(sent).toEqual([]);
    setPref('noticeChannels', normalizeNoticeChannels());
    const fresh = { ...row, id: 201 };
    observeNotices(data([fresh])); await flush(); await deliver();
    expect(sent).toHaveLength(1);
    resetNoticeNotifier(); observeNotices(data([])); observeNotices(data([fresh]));
    await flush(); await deliver(); expect(sent).toHaveLength(1);
    resetPrefs(); expect(readPref('noticeNotifications')).toBe(false);
    expect(readPref('noticeChannels')).toEqual(normalizeNoticeChannels());
  } finally {
    globalThis.navigator = previousNavigator;
    if (previousNotification === undefined) delete globalThis.Notification; else globalThis.Notification = previousNotification;
    dom.restore();
  }
});
