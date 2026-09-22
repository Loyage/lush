import { test, expect } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { createNoticeNotifier, initNoticeNotifications, notificationStatus, setNoticeNotifications, observeNotices, resetNoticeNotifier } from '../../src/ui/web/assets/notice-notifications.js';
import { readPref, setPref, resetPrefs } from '../../src/ui/web/assets/prefs.js';

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
