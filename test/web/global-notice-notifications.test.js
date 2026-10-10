import { test, expect } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { createGlobalNoticeObserver, sendGlobalNotification, startGlobalNoticeObserver, refreshGlobalNotices } from '../../src/ui/web/assets/global-notice-notifications.js';
import { setPref, normalizeNoticeChannels } from '../../src/ui/web/assets/prefs.js';
import { inboxMatches, inboxNotificationKey } from '../../src/ui/web/assets/global-inbox-model.js';

const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb';
const token = digit => String(digit).repeat(32), EPOCH = 'e'.repeat(32);
const sync = (identity, revision, epoch = EPOCH) => ({ sync_identity: token(identity), sync_revision: revision, sync_epoch: epoch });
const row = (projectId = A, id = 1, extra = {}) => ({ project_id: projectId, project_name: `项目 ${projectId[0]}`, project: `/tmp/${projectId}`,
  online: true, checked_at: '2026-10-09T10:00:00Z', notice: { id, task_id: 10, task_worker_number: 'W162', kind: 'question', status: 'open',
    title: `问题 ${id}`, body: '问题正文', created_at: `2026-10-09T10:${String(Math.floor(id / 60) % 60).padStart(2, '0')}:${String(id % 60).padStart(2, '0')}.000Z`, ...extra } });
const project = (id = A, extra = {}) => ({ id, name: `项目 ${id[0]}`, online: true, complete: true, checked_at: '2026-10-09T11:00:00Z', error: null, ...extra });
const info = (projectId, id, type = 'failed') => row(projectId, id, { kind: 'info', status: 'sent', source_event_id: id + 20, lifecycle_type: type, read_at: null });
const microtasks = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function clock() {
  let next = 0; const timers = new Map();
  return { timers, schedule(fn, ms) { const id = ++next; timers.set(id, { fn, ms }); return id; }, cancel(id) { timers.delete(id); },
    async fire(ms) { const found = [...timers].find(([, value]) => value.ms === ms); if (!found) return false;
      timers.delete(found[0]); found[1].fn(); await microtasks(); return true; } };
}
async function completeScan(observer, timer, options) {
  const done = observer.refresh(options); await microtasks();
  for (let i = 0; i < 100 && await timer.fire(20); i++) {}
  return done;
}
function backend(state) {
  const calls = [];
  return { calls, read: async url => {
    calls.push(url); if (state.error) throw new Error(state.error);
    const params = new URL(url, 'http://localhost').searchParams, status = params.get('status'), limit = Number(params.get('limit'));
    const before = params.get('before'), at = before ? Number(before.slice(before.indexOf(':') + 1)) : 0;
    const rows = state.rows.filter(item => inboxMatches(item, status));
    const items = rows.slice(at, at + limit), has_more = at + limit < rows.length;
    return { version: 1, items, cursor: has_more ? `${status}:${at + limit}` : null, has_more, complete: state.complete ?? true, projects: state.projects };
  } };
}
function observeFixture(state, options = {}) {
  const timer = clock(), server = backend(state), sent = [], summaries = [];
  const observer = createGlobalNoticeObserver({ read: server.read, send: async item => sent.push([item.project_id, item.notice.id]), enabled: () => true,
    onSummary: value => summaries.push(value), now: () => Date.parse('2026-10-09T09:00:00Z'),
    setTimeout: timer.schedule, clearTimeout: timer.cancel, ...options });
  return { observer, timer, server, sent, summaries };
}

test('independent source baselines suppress first-load/new-registration backlog and send only new open or unread items', async () => {
  const dom = installDom(); const state = { rows: [row(A, 1)], projects: [project(A)] }, fixture = observeFixture(state);
  try {
    let result = await completeScan(fixture.observer, fixture.timer);
    expect(result.open).toBe(1); expect(result.complete).toBe(true); expect(fixture.sent).toEqual([]);
    state.rows = [row(A, 2), row(B, 99), row(A, 1)]; state.projects.push(project(B));
    result = await completeScan(fixture.observer, fixture.timer);
    expect(result.open).toBe(3); expect(fixture.sent).toEqual([[A, 2]]);
    state.rows.push(info(B, 100), row(A, 3, { status: 'answered', answer_source: 'lush' }), row(A, 4, { kind: 'info', status: 'sent', source_event_id: null }));
    result = await completeScan(fixture.observer, fixture.timer);
    expect(result.unread).toBe(1); expect(fixture.sent).toEqual([[A, 2], [B, 100]]);
    await completeScan(fixture.observer, fixture.timer); expect(fixture.sent).toHaveLength(2);
    expect(fixture.server.calls.every(url => /status=(open|unread)/.test(url) && url.includes('limit=30'))).toBe(true);
  } finally { fixture.observer.dispose(); expect(fixture.timer.timers.size).toBe(0); dom.restore(); }
});

test('counts consume all pages beyond 200 records in bounded batches and remain explicitly incomplete while loading', async () => {
  const dom = installDom(); const state = { rows: Array.from({ length: 251 }, (_, i) => row(i % 2 ? A : B, i + 1)), projects: [project(A), project(B)] };
  state.rows.push(...Array.from({ length: 111 }, (_, i) => info(B, i + 300)));
  const fixture = observeFixture(state, { pageBudget: 1 });
  try {
    const done = fixture.observer.refresh(); await microtasks();
    expect(fixture.server.calls).toHaveLength(1); expect(fixture.observer.summary().complete).toBe(false);
    for (let i = 0; i < 20 && await fixture.timer.fire(20); i++) {}
    const result = await done;
    expect(result.open).toBe(251); expect(result.unread).toBe(111); expect(result.complete).toBe(true);
    expect(fixture.server.calls).toHaveLength(13); expect(fixture.sent).toEqual([]);
    expect(fixture.summaries.slice(0, -1).every(value => value.complete === false)).toBe(true);
  } finally { fixture.observer.dispose(); dom.restore(); }
});

test('disabled/category-filtered records are consumed; reenabling explicitly rebaselines rather than replaying history', async () => {
  const dom = installDom(); let enabled = false;
  const state = { rows: [row(A, 1)], projects: [project(A)] }, fixture = observeFixture(state, { enabled: () => enabled });
  try {
    await completeScan(fixture.observer, fixture.timer);
    state.rows.push(row(A, 2)); await completeScan(fixture.observer, fixture.timer); expect(fixture.sent).toEqual([]);
    enabled = true; setPref('noticeNotifications', true); await microtasks();
    for (let i = 0; i < 10 && await fixture.timer.fire(20); i++) {}
    await completeScan(fixture.observer, fixture.timer); expect(fixture.sent).toEqual([]);
    setPref('noticeChannels', { failed: { system: false } }); await microtasks();
    state.rows.push(info(A, 3)); await completeScan(fixture.observer, fixture.timer); expect(fixture.sent).toEqual([]);
    setPref('noticeChannels', normalizeNoticeChannels()); await microtasks();
    for (let i = 0; i < 10 && await fixture.timer.fire(20); i++) {}
    await completeScan(fixture.observer, fixture.timer); expect(fixture.sent).toEqual([]);
    state.rows.push(row(A, 4)); await completeScan(fixture.observer, fixture.timer); expect(fixture.sent).toEqual([[A, 4]]);
  } finally { fixture.observer.dispose(); dom.restore(); }
});

test('offline source retains last complete counts with stale status, new incomplete sources never contribute full counts', async () => {
  const dom = installDom(); const state = { rows: [row(A, 1), info(B, 2)], projects: [project(A), project(B)] }, fixture = observeFixture(state);
  try {
    await completeScan(fixture.observer, fixture.timer);
    state.projects = [project(A), project(B, { online: false, complete: false, error: '项目离线' })]; state.rows = [row(A, 3)]; state.complete = false;
    let result = await completeScan(fixture.observer, fixture.timer);
    expect(result.open).toBe(1); expect(result.unread).toBe(1); expect(result.complete).toBe(false);
    expect(result.projects.find(project => project.id === B).online).toBe(false);
    state.projects.push(project('cccccccccccccccc', { complete: false })); state.rows.push(row('cccccccccccccccc', 50));
    result = await completeScan(fixture.observer, fixture.timer);
    expect(result.open).toBe(1); expect(result.projects.at(-1).open).toBeNull();
    // Removal/permission changes remove both stale counts and source baselines.
    state.projects = [project(A)]; state.rows = [row(A, 3)]; state.complete = true;
    result = await completeScan(fixture.observer, fixture.timer); expect(result.unread).toBe(0); expect(result.projects).toHaveLength(1);
  } finally { fixture.observer.dispose(); dom.restore(); }
});

test('Host failure keeps known stale results, rejects explicit refresh and backs off without dropping records', async () => {
  const dom = installDom(); const state = { rows: [row(A, 1)], projects: [project(A)] }, fixture = observeFixture(state);
  try {
    await completeScan(fixture.observer, fixture.timer); state.error = '连接断开';
    await expect(completeScan(fixture.observer, fixture.timer)).rejects.toThrow('连接断开');
    expect(fixture.observer.summary().open).toBe(1); expect(fixture.observer.summary().complete).toBe(false);
    expect(fixture.observer.summary().projects[0].online).toBe(false);
    expect([...fixture.timer.timers.values()].some(timer => timer.ms === 6000)).toBe(true);
    delete state.error; state.rows.push(row(A, 2)); await completeScan(fixture.observer, fixture.timer, { baseline: true }); expect(fixture.sent).toEqual([]);
  } finally { fixture.observer.dispose(); dom.restore(); }
});

test('refresh requests are single-flight, disposal aborts reads and removes timers/listeners including preference callbacks', async () => {
  const dom = installDom(); const timer = clock(); let calls = 0, signal;
  const observer = createGlobalNoticeObserver({ read: async (_url, options) => { calls++; signal = options.signal; return new Promise(() => {}); },
    setTimeout: timer.schedule, clearTimeout: timer.cancel });
  try {
    const first = observer.refresh(), second = observer.refresh(); expect(first).toBe(second); expect(calls).toBe(1);
    expect(dom.listeners.storage).toHaveLength(1);
    observer.dispose(); await expect(first).rejects.toThrow('已停止'); await microtasks();
    expect(signal.aborted).toBe(true); expect(timer.timers.size).toBe(0); expect(dom.listeners.storage).toHaveLength(0);
    setPref('noticeNotifications', true); await dom.fire('storage', { key: 'lush.noticeNotifications' }); expect(calls).toBe(1);
    await expect(observer.refresh()).rejects.toThrow('已停止');
  } finally { observer.dispose(); dom.restore(); }
});

test('a repeating pagination cursor and timeout never report truncated results as complete', async () => {
  const dom = installDom(), timer = clock();
  const observer = createGlobalNoticeObserver({ read: async () => ({ version: 1, items: [row(A)], projects: [project(A)], has_more: true, cursor: 'same', complete: true }),
    setTimeout: timer.schedule, clearTimeout: timer.cancel });
  try { await expect(observer.refresh()).rejects.toThrow('游标未推进'); expect(observer.summary().complete).toBe(false); }
  finally { observer.dispose(); }
  const timed = createGlobalNoticeObserver({ read: async () => new Promise(() => {}), timeoutMs: 50, setTimeout: timer.schedule, clearTimeout: timer.cancel });
  try {
    const done = timed.refresh(); await timer.fire(50); await expect(done).rejects.toThrow('读取超时'); expect(timed.summary().complete).toBe(false);
  } finally { timed.dispose(); dom.restore(); }
});

test('incomplete metadata at any page prevents optimistic full counts even if a later response completes indexing', async () => {
  const dom = installDom(), timer = clock(); let requests = 0;
  const observer = createGlobalNoticeObserver({ read: async () => ({ version: 1, items: [row(A)], cursor: null, has_more: false,
    complete: ++requests !== 1, projects: [project(A, { complete: requests !== 1 })] }), setTimeout: timer.schedule, clearTimeout: timer.cancel });
  try {
    const result = await completeScan(observer, timer);
    expect(result.complete).toBe(false); expect(result.open).toBe(0); expect(result.projects[0].open).toBeNull();
    const next = await completeScan(observer, timer); expect(next.open).toBe(1); expect(next.complete).toBe(true);
  } finally { observer.dispose(); dom.restore(); }
});

test('lower reused IDs with a fresh creation time are recognized without replaying old resurfaced pages', async () => {
  const dom = installDom(); let time = Date.parse('2026-10-09T12:00:00Z');
  const state = { rows: [row(A, 100)], projects: [project(A)] }, fixture = observeFixture(state, { now: () => time });
  try {
    await completeScan(fixture.observer, fixture.timer);
    time += 1000; state.rows = [row(A, 1, { created_at: '2026-10-09T12:00:01.000Z' })];
    await completeScan(fixture.observer, fixture.timer); expect(fixture.sent).toEqual([[A, 1]]);
    time += 1000; state.rows = [row(A, 2, { created_at: '2026-10-09T10:00:00Z' })];
    await completeScan(fixture.observer, fixture.timer); expect(fixture.sent).toHaveLength(1);
  } finally { fixture.observer.dispose(); dom.restore(); }
});

test('real sync identity detects a reused lower ID with unchanged timestamp; revisions alone never renotify', async () => {
  const dom = installDom(), oldTime = '2026-10-09T10:00:00Z';
  const state = { rows: [row(A, 20, { ...sync(1, 10), created_at: oldTime }), row(A, 7, { ...sync(2, 11), created_at: oldTime })], projects: [project(A)] };
  const fixture = observeFixture(state, { now: () => Date.parse('2026-10-09T12:00:00Z') });
  try {
    await completeScan(fixture.observer, fixture.timer); expect(fixture.sent).toEqual([]);
    state.rows[1] = row(A, 7, { ...sync(3, 12), created_at: oldTime });
    await completeScan(fixture.observer, fixture.timer); expect(fixture.sent).toEqual([[A, 7]]);
    state.rows[1] = row(A, 7, { ...sync(3, 13), created_at: oldTime });
    await completeScan(fixture.observer, fixture.timer); expect(fixture.sent).toHaveLength(1);
    // An old consumed record resurfacing with a lower change sequence must not replay.
    state.rows = [state.rows[0]]; await completeScan(fixture.observer, fixture.timer);
    state.rows.push(row(A, 7, { ...sync(2, 11), created_at: oldTime })); await completeScan(fixture.observer, fixture.timer);
    expect(fixture.sent).toHaveLength(1);
  } finally { fixture.observer.dispose(); dom.restore(); }
});

test('a later unread update cannot mask a new synced question created between the two paginated reads', async () => {
  const dom = installDom(), oldTime = '2026-10-09T10:00:00Z';
  const lifecycle = info(A, 21); lifecycle.notice = { ...lifecycle.notice, ...sync(2, 11), created_at: oldTime };
  const state = { rows: [row(A, 20, { ...sync(1, 10), created_at: oldTime }), lifecycle], projects: [project(A)] };
  const server = backend(state); let born = false;
  const fixture = observeFixture(state, { now: () => Date.parse('2026-10-09T12:00:00Z'), read: async url => {
    if (born && url.includes('status=unread')) {
      state.rows[1].notice.sync_revision = 50;
      state.rows.push(row(A, 7, { ...sync(3, 12), created_at: oldTime })); born = false;
    }
    return server.read(url);
  } });
  try {
    await completeScan(fixture.observer, fixture.timer);
    born = true; await completeScan(fixture.observer, fixture.timer); expect(fixture.sent).toEqual([]);
    await completeScan(fixture.observer, fixture.timer); expect(fixture.sent).toEqual([[A, 7]]);
  } finally { fixture.observer.dispose(); dom.restore(); }
});

test('an optional source identity without revision still distinguishes integer/date reuse without fabricating metadata', async () => {
  const dom = installDom();
  const original = row(A, 7, { sync_identity: token(1), created_at: '2026-10-09T08:00:00Z' });
  const state = { rows: [original], projects: [project(A)] }, delivered = [];
  const fixture = observeFixture(state, { send: async item => delivered.push(item) });
  try {
    await completeScan(fixture.observer, fixture.timer);
    state.rows = [row(A, 7, { sync_identity: token(2), created_at: original.notice.created_at })];
    await completeScan(fixture.observer, fixture.timer);
    expect(delivered).toHaveLength(1); expect(delivered[0].notice.sync_identity).toBe(token(2));
    expect(delivered[0].notice.sync_revision).toBeUndefined(); expect(delivered[0].notice.sync_epoch).toBeUndefined();
  } finally { fixture.observer.dispose(); dom.restore(); }
});

test('database epoch changes rebaseline restored history and a mixed-epoch pagination never supplies full counts', async () => {
  const dom = installDom(), state = { rows: [row(A, 7, sync(1, 10))], projects: [project(A)] }, fixture = observeFixture(state);
  try {
    await completeScan(fixture.observer, fixture.timer);
    const nextEpoch = 'f'.repeat(32); state.rows = [row(A, 7, sync(2, 1, nextEpoch))];
    const restored = await completeScan(fixture.observer, fixture.timer); expect(restored.open).toBe(1); expect(fixture.sent).toEqual([]);
    state.rows.push(row(A, 8, sync(3, 2, nextEpoch))); await completeScan(fixture.observer, fixture.timer);
    expect(fixture.sent).toEqual([[A, 8]]);
    state.rows.push(info(A, 9)); state.rows.at(-1).notice = { ...state.rows.at(-1).notice, ...sync(4, 20) };
    await expect(completeScan(fixture.observer, fixture.timer)).rejects.toThrow('数据库代际');
    expect(fixture.observer.summary().complete).toBe(false); expect(fixture.observer.summary().open).toBe(2); expect(fixture.observer.summary().unread).toBe(0);
  } finally { fixture.observer.dispose(); dom.restore(); }
});

test('lock-delayed notification delivery stays bounded and does not hold counts or source refresh hostage', async () => {
  const dom = installDom(); const state = { rows: [row(A, 1)], projects: [project(A)] }, waiting = [], started = [];
  const fixture = observeFixture(state, { send: (item, controls) => {
    started.push(item.notice.id); return new Promise(resolve => waiting.push({ resolve, controls }));
  } });
  try {
    await completeScan(fixture.observer, fixture.timer);
    state.rows.push(...Array.from({ length: 12 }, (_, i) => row(A, i + 2)));
    let result = await completeScan(fixture.observer, fixture.timer);
    expect(result.open).toBe(13); expect(result.complete).toBe(true); expect(started).toHaveLength(4);
    // Answered/removed records make old lock callbacks ineligible even with the master still on.
    state.rows = [row(A, 1)]; result = await completeScan(fixture.observer, fixture.timer);
    expect(result.open).toBe(1); expect(waiting.every(job => !job.controls.isCurrent())).toBe(true);
    for (const job of waiting) job.resolve(); await microtasks();
    while (await fixture.timer.fire(20)) {} expect(started).toHaveLength(4);
  } finally { fixture.observer.dispose(); dom.restore(); }
});

test('delivery uses the existing canonical-source storage key, deduplicates across tabs and preserves project input on click', async () => {
  const dom = installDom(), saved = globalThis.Notification, previousNavigator = globalThis.navigator, banners = [], locks = [], opened = [];
  globalThis.Notification = class {
    static permission = 'granted';
    constructor(title, options) { this.title = title; this.options = options; banners.push(this); }
    close() { this.closed = true; }
  };
  globalThis.navigator = { locks: { request: async (key, action) => { locks.push(key); return action(); } } };
  dom.window.open = (...args) => opened.push(args);
  try {
    setPref('noticeNotifications', true); const record = row(B, 7);
    await Promise.all([sendGlobalNotification(record), sendGlobalNotification(record)]);
    expect(banners).toHaveLength(1); expect(locks[0]).toBe(`lush.notice-delivered:${record.project}:7:${record.notice.created_at}`);
    expect(banners[0].title).toBe('Lush · 项目 b');
    dom.location.pathname = `/p/${A}/`; dom.location.hash = '#worker-44'; banners[0].onclick();
    expect(opened).toEqual([[`/#inbox-notice-${B}-7`, '_blank', 'noopener']]); expect(dom.location.hash).toBe('#worker-44');
    dom.location.pathname = '/'; banners[0].onclick(); expect(dom.location.hash).toBe(`#inbox-notice-${B}-7`);
    expect(banners[0].closed).toBe(true);
  } finally { globalThis.navigator = previousNavigator; if (saved === undefined) delete globalThis.Notification; else globalThis.Notification = saved; dom.restore(); }
});

test('native cross-tab delivery distinguishes real reused records while revision changes share one delivered key', async () => {
  const dom = installDom(), saved = globalThis.Notification, previousNavigator = globalThis.navigator, banners = [], locks = [];
  globalThis.Notification = class { static permission = 'granted'; constructor(title, options) { banners.push({ title, options }); } };
  globalThis.navigator = { locks: { request: async (key, action) => { locks.push(key); return action(); } } };
  try {
    setPref('noticeNotifications', true); const original = row(A, 7, sync(1, 1)), reused = row(A, 7, sync(2, 3));
    localStorage.setItem(`lush.notice-delivered:${original.project}:7:${original.notice.created_at}`, '1');
    await Promise.all([sendGlobalNotification(original), sendGlobalNotification(original)]);
    await sendGlobalNotification(row(A, 7, sync(1, 2))); expect(banners).toHaveLength(1);
    await sendGlobalNotification(reused); expect(banners).toHaveLength(2);
    expect(locks[0]).toBe(inboxNotificationKey(original)); expect(locks.at(-1)).toBe(inboxNotificationKey(reused));
    expect(banners[0].options.tag).not.toBe(banners[1].options.tag);
    expect(locks[0].endsWith(`:sync:${token(1)}:${EPOCH}`)).toBe(true);
  } finally { globalThis.navigator = previousNavigator; if (saved === undefined) delete globalThis.Notification; else globalThis.Notification = saved; dom.restore(); }
});

test('lock-delayed delivery rechecks master/channel/disposal and never requests browser permission', async () => {
  const dom = installDom(), saved = globalThis.Notification, previousNavigator = globalThis.navigator; let run, sent = 0, requested = 0, alive = true;
  globalThis.Notification = class {
    static permission = 'granted'; static requestPermission() { requested++; }
    constructor() { sent++; }
  };
  globalThis.navigator = { locks: { request: async (_key, action) => { run = action; } } };
  try {
    setPref('noticeNotifications', true); await sendGlobalNotification(info(A, 7), { isCurrent: () => alive });
    alive = false; await run(); expect(sent).toBe(0);
    alive = true; await sendGlobalNotification(info(A, 8)); setPref('noticeChannels', { failed: { system: false } }); await run(); expect(sent).toBe(0);
    setPref('noticeChannels', normalizeNoticeChannels()); await sendGlobalNotification(row(A, 9)); setPref('noticeNotifications', false); await run(); expect(sent).toBe(0);
    expect(requested).toBe(0);
  } finally { globalThis.navigator = previousNavigator; if (saved === undefined) delete globalThis.Notification; else globalThis.Notification = saved; dom.restore(); }
});

test('exported observer lifecycle starts one reader and explicit global refresh joins rather than duplicates it', async () => {
  const dom = installDom(), state = { rows: [], projects: [project(A)] }, server = backend(state), timer = clock(), values = [];
  const dispose = startGlobalNoticeObserver({ read: server.read, onSummary: result => values.push(result), setTimeout: timer.schedule, clearTimeout: timer.cancel });
  try {
    await refreshGlobalNotices(); expect(server.calls).toHaveLength(2); expect(values.at(-1).complete).toBe(true);
    dispose(); expect(timer.timers.size).toBe(0); expect(await refreshGlobalNotices()).toBeNull();
  } finally { dispose(); dom.restore(); }
});
