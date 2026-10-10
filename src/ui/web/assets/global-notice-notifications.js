import { api } from './api.js';
import { onPrefChange, pollingIntervals, readPref } from './prefs.js';
import { noticeChannelEnabled, unreadNotice } from './notice-kind.js';
import { inboxProjectHref, inboxIdentity, inboxNotificationKey, pendingNotice, validateInboxItem, validateInboxPage } from './global-inbox-model.js';

/** Legacy projections keep the existing key; real source identities distinguish reused records. */
export async function sendGlobalNotification(item, { isCurrent = () => true } = {}) {
  validateInboxItem(item);
  const enabled = () => isCurrent() && readPref('noticeNotifications') && noticeChannelEnabled(item.notice, 'system');
  if (!enabled() || !item.online) return;
  const key = inboxNotificationKey(item);
  const run = () => {
    if (!enabled() || !globalThis.Notification || globalThis.isSecureContext === false || Notification.permission !== 'granted') return;
    try { if (localStorage.getItem(key)) return; } catch { /* private browsing */ }
    const notification = new Notification(`Lush · ${item.project_name}`, { body: item.notice.title.slice(0, 500), tag: key });
    const target = inboxProjectHref(item.project_id, item.notice.id);
    notification.onclick = () => {
      // Keep both the global workbench and any project's unsubmitted input intact.
      globalThis.window?.open?.(target, '_blank', 'noopener');
      notification.close();
    };
    try { localStorage.setItem(key, '1'); } catch { /* OS tag and this observer's baseline still deduplicate */ }
  };
  if (globalThis.navigator?.locks?.request) await navigator.locks.request(key, run);
  else run();
}

/**
 * Two complete paginated reads (open + unread), in bounded batches, rather than a 200-row snapshot
 * or a repeated scan of answered history. Counts are published only after both scans finish.
 * Each source establishes its own first-load baseline; new registrations never burst old notices.
 */
export function createGlobalNoticeObserver({
  onSummary = () => {}, read = api, send = sendGlobalNotification, enabled = () => readPref('noticeNotifications'),
  now = () => Date.now(), setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout,
  intervalMs = () => Math.max(3000, pollingIntervals().snapshot), pageBudget = 3, timeoutMs = 12000,
} = {}) {
  if (!Number.isInteger(pageBudget) || pageBudget < 1 || pageBudget > 10
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('全局提醒的读取边界无效');
  const sources = new Map(), baselines = new Map(), deliveries = new Map();
  let disposed = false, timer = null, deliveryTimer = null, delivering = 0, scan = null, stepping = false, requestController = null;
  let errors = 0, generation = 0, lastSummary = { open: 0, unread: 0, complete: false, projects: [] };
  const clearTimer = () => { if (timer !== null) cancel(timer); timer = null; };
  const emit = summary => { lastSummary = summary; if (!disposed) { try { onSummary(summary); } catch { /* A detached chrome callback cannot invalidate source facts. */ } } return summary; };
  const summary = complete => {
    let open = 0, unread = 0;
    const projects = [];
    for (const source of sources.values()) {
      // Uninitialized/incomplete new sources do not contribute pretend zero/full counts.
      if (source.loaded) for (const item of source.items.values()) {
        if (pendingNotice(item.notice)) open++;
        if (unreadNotice(item.notice)) unread++;
      }
      projects.push({ ...source.model, complete: Boolean(source.loaded && source.model.complete),
        open: source.loaded ? [...source.items.values()].filter(item => pendingNotice(item.notice)).length : null,
        unread: source.loaded ? [...source.items.values()].filter(item => unreadNotice(item.notice)).length : null });
    }
    return { open, unread, complete: Boolean(complete && projects.every(project => project.online && project.complete)), projects };
  };
  const later = (delay, action) => { clearTimer(); if (!disposed) timer = schedule(() => { timer = null; void action(); }, delay); };
  async function readPage(url) {
    const controller = new AbortController(); requestController = controller;
    let timeout, onAbort;
    try {
      return validateInboxPage(await Promise.race([
        read(url, { signal: controller.signal }),
        new Promise((_, reject) => {
          onAbort = () => { cancel(timeout); reject(new DOMException('全局收件箱读取已取消', 'AbortError')); };
          timeout = schedule(() => { reject(new Error('全局收件箱读取超时')); controller.abort(); }, timeoutMs);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]));
    } finally {
      cancel(timeout); if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      if (requestController === controller) requestController = null;
    }
  }
  function begin(baseline) {
    let resolve, reject;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Timer-driven failures are handled below; callers of refresh still receive the rejection.
    done.catch(() => {});
    return { statusIndex: 0, cursor: null, cursors: new Set(), items: new Map(), projects: [], sourceComplete: new Map(), complete: true,
      suppress: baseline, generation, done, resolve, reject };
  }
  function drainDeliveries() {
    deliveryTimer = null;
    if (disposed) return;
    while (delivering < 4 && deliveries.size) {
      const [key, delivery] = deliveries.entries().next().value; deliveries.delete(key);
      const { item, generation: authorization } = delivery;
      const isCurrent = () => !disposed && authorization === generation && enabled()
        && sources.get(item.project_id)?.model.online && sources.get(item.project_id)?.model.complete
        && sources.get(item.project_id)?.items.has(key)
        && noticeChannelEnabled(item.notice, 'system');
      if (!isCurrent()) continue;
      delivering++;
      void Promise.resolve().then(() => isCurrent() ? send(item, { isCurrent }) : null).catch(error => {
        if (isCurrent()) emit({ ...lastSummary, notification_error: `系统提醒发送失败：${error.message}` });
      }).finally(() => {
        delivering--;
        if (!disposed && deliveries.size && deliveryTimer === null) deliveryTimer = schedule(drainDeliveries, 20);
      });
    }
  }
  function finish(current) {
    const allowed = new Set(current.projects.map(source => source.id));
    for (const id of [...sources.keys()]) if (!allowed.has(id)) { sources.delete(id); baselines.delete(id); }
    const sends = [];
    for (const row of current.projects) {
      const model = { ...row, complete: row.complete && current.sourceComplete.get(row.id) !== false };
      const previous = sources.get(model.id);
      const items = new Map([...current.items].filter(([, item]) => item.project_id === model.id));
      if (!model.complete || !model.online) {
        sources.set(model.id, { model, loaded: previous?.loaded || model.complete, items: previous?.loaded ? previous.items : items });
        continue;
      }
      const epochs = new Set([...items.values()].map(item => item.notice.sync_epoch).filter(Boolean));
      if (epochs.size > 1) throw new Error('来源数据库代际在分页中变化，需重新完整读取');
      const epoch = epochs.values().next().value;
      sources.set(model.id, { model, loaded: true, items });
      let baseline = baselines.get(model.id);
      const initial = !baseline || Boolean(epoch && baseline.epoch && epoch !== baseline.epoch);
      if (initial) {
        baseline = { high: 0, epoch, started: Math.floor(now() / 1000) * 1000, seen: new Set(), retired: new Set() };
        baselines.set(model.id, baseline);
      }
      if (epoch) baseline.epoch = epoch;
      for (const key of baseline.seen) if (!items.has(key)) baseline.retired.add(key);
      // Bound retired identities, not the active/full count. A later page's update revision
      // cannot mask a new record created between the open and unread reads.
      while (baseline.retired.size > 4096) baseline.retired.delete(baseline.retired.values().next().value);
      for (const [key, item] of items) {
        const n = item.notice;
        const fresh = !baseline.seen.has(key) && (n.sync_identity ? !baseline.retired.has(key)
          : n.id > baseline.high || Date.parse(n.created_at) >= baseline.started);
        if (!initial && !current.suppress && current.generation === generation && fresh && enabled() && noticeChannelEnabled(item.notice, 'system')) sends.push(item);
        baseline.seen.add(key);
      }
      for (const item of items.values()) baseline.high = Math.max(baseline.high, item.notice.id);
      for (const key of items.keys()) baseline.retired.delete(key);
      // Stable sync identities detect recreation even with unchanged ID/time. Revision-only
      // changes keep the same key; legacy records keep their original high-water boundary.
      baseline.seen = new Set(items.keys()); baseline.started = Math.floor(now() / 1000) * 1000;
    }
    errors = 0;
    const result = emit(summary(current.complete));
    // A delayed cross-tab lock must not block source refresh/counts. At most four sends wait;
    // each rechecks the latest active record as well as authorization before delivery.
    for (const item of sends) deliveries.set(inboxIdentity(item), { item, generation: current.generation });
    if (deliveryTimer === null) drainDeliveries();
    return result;
  }
  async function step() {
    if (disposed || stepping || !scan) return;
    stepping = true; const current = scan;
    try {
      for (let count = 0; count < pageBudget && current.statusIndex < 2 && !disposed; count++) {
        const status = ['open', 'unread'][current.statusIndex];
        const query = `/api/host/inbox?status=${status}&limit=30${current.cursor === null ? '' : `&before=${encodeURIComponent(current.cursor)}`}`;
        const page = await readPage(query);
        if (disposed || scan !== current) return;
        for (const item of page.items) if (pendingNotice(item.notice) || unreadNotice(item.notice)) {
          const n = item.notice;
          // Summaries/delivery do not retain question bodies or stored answers. The inbox reads those on demand.
          current.items.set(inboxIdentity(item), { ...item, notice: { id: n.id, task_id: n.task_id,
            task_worker_number: n.task_worker_number, kind: n.kind, status: n.status, title: n.title,
            body: '', created_at: n.created_at, source_event_id: n.source_event_id, lifecycle_type: n.lifecycle_type,
            read_at: n.read_at, answer_source: n.answer_source, sync_identity: n.sync_identity,
            sync_revision: n.sync_revision, sync_epoch: n.sync_epoch } });
        }
        // Every response's roster is authoritative for access; never retain a removed source.
        current.projects = page.projects; current.complete &&= page.complete;
        for (const source of page.projects) current.sourceComplete.set(source.id,
          (current.sourceComplete.get(source.id) ?? true) && source.complete && source.online);
        if (page.has_more) {
          if (current.cursors.has(`${status}:${page.cursor}`)) throw new Error('收件箱分页游标未推进，未将局部记录冒充全量');
          current.cursors.add(`${status}:${page.cursor}`); current.cursor = page.cursor;
        } else { current.statusIndex++; current.cursor = null; }
      }
      if (disposed || scan !== current) return;
      if (current.statusIndex < 2) {
        emit({ ...lastSummary, complete: false });
        later(20, step);
      } else {
        const value = await finish(current);
        if (disposed || scan !== current) return;
        scan = null; current.resolve(value);
        later(typeof intervalMs === 'function' ? intervalMs() : intervalMs, () => refresh().catch(() => {}));
      }
    } catch (error) {
      if (disposed || scan !== current) return;
      errors++;
      for (const source of sources.values()) source.model = { ...source.model, online: false, error: 'Host 收件箱暂时不可达，保留最后确认记录' };
      emit({ ...summary(false), error: `全局事项读取失败：${error.message}` });
      scan = null; current.reject(error);
      later(Math.min(60000, 3000 * 2 ** Math.min(errors, 4)), () => refresh().catch(() => {}));
    } finally { stepping = false; }
  }
  function refresh({ baseline = false } = {}) {
    if (disposed) return Promise.reject(new Error('全局提醒观察已停止'));
    if (scan) { if (baseline) scan.suppress = true; return scan.done; }
    clearTimer(); scan = begin(baseline); void step(); return scan.done;
  }
  function rebaseline() {
    generation++; deliveries.clear();
    if (scan) scan.suppress = true;
    // Keep counts/baselines, but establish a fresh authorization boundary before sending again.
    void refresh({ baseline: true }).catch(() => {});
  }
  const removePref = onPrefChange('noticeNotifications', rebaseline);
  const removeChannels = onPrefChange('noticeChannels', rebaseline);
  const storage = event => { if (!event?.key || ['lush.noticeNotifications', 'lush.noticeChannels'].includes(event.key)) rebaseline(); };
  globalThis.addEventListener?.('storage', storage);
  return { refresh, summary: () => lastSummary,
    dispose() {
      if (disposed) return;
      disposed = true; generation++; clearTimer();
      if (deliveryTimer !== null) cancel(deliveryTimer); deliveryTimer = null; deliveries.clear();
      requestController?.abort();
      scan?.reject(new DOMException('全局提醒观察已停止', 'AbortError')); scan = null;
      removePref(); removeChannels(); globalThis.removeEventListener?.('storage', storage);
    } };
}

let activeObserver = null;
export function startGlobalNoticeObserver(options = {}) {
  activeObserver?.dispose();
  const observer = activeObserver = createGlobalNoticeObserver(options);
  void observer.refresh({ baseline: true }).catch(() => {});
  return () => { observer.dispose(); if (activeObserver === observer) activeObserver = null; };
}
/** Explicit user/ACK refresh is read-only and does not burst historical system notifications. */
export function refreshGlobalNotices() { return activeObserver ? activeObserver.refresh({ baseline: true }) : Promise.resolve(null); }
