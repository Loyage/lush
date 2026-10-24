import { createHash } from 'node:crypto';
import { check, isPlainObject } from '../core/types.js';
import { projectRouteId } from './registry.js';
import { WEB_PUSH_VERSION, pushNoticeUrl } from '../shared/web-push-protocol.js';
import { PUSH_LIMITS, WebPushStore, pushOrigin } from './web-push-store.js';
import { normalizePushSubscription, pushEndpoint, sendWebPush } from './web-push-transport.js';
import { NOTICE_CATEGORIES } from '../ui/web/assets/notice-channels.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const HEX = /^[a-f0-9]{32}$/;
const LIFECYCLE_TYPES = new Set([null, ...NOTICE_CATEGORIES.map(category => category.id)]);
const MAX_AGE = 3600000;
const STATUS_BODIES = Object.freeze({ created: '有 Worker 等待开始，请打开 Lush 查看。',
  // The retained idle key includes historical task.idle and current delivery events.
  idle: 'Worker 状态已更新，请打开 Lush 查看。', analysis: '分析结果已就绪，请打开 Lush 查看。',
  failed: '工作出现异常，请打开 Lush 查看。', reported: '有新的 Agent 告知，请打开 Lush 查看。' });
const pending = notice => notice.status === 'open' && ['question', 'questionnaire', 'plan'].includes(notice.kind)
  || notice.kind === 'info' && notice.status === 'sent' && Number.isSafeInteger(notice.source_event_id)
    && notice.source_event_id > 0 && !notice.read_at;
const enabled = (prefs, notice) => prefs.noticeNotifications === true
  && (notice.kind !== 'info' || prefs.noticeChannels?.[notice.lifecycle_type]?.system !== false);
function changeModel(change, epoch) {
  check(isPlainObject(change) && Number.isSafeInteger(change.id) && change.id > 0 && HEX.test(change.identity)
    && typeof change.deleted === 'boolean', 'invalid push source change');
  if (change.deleted) return { ...change, notice: null };
  const notice = change.notice;
  check(isPlainObject(notice) && notice.id === change.id && notice.sync_identity === change.identity && notice.sync_epoch === epoch
    && Number.isSafeInteger(notice.sync_revision) && notice.sync_revision >= 0 && Number.isSafeInteger(notice.task_id) && notice.task_id > 0
    && ['question', 'questionnaire', 'plan', 'info'].includes(notice.kind)
    && ['open', 'answered', 'dismissed', 'sent'].includes(notice.status)
    && LIFECYCLE_TYPES.has(notice.lifecycle_type)
    && (notice.source_event_id === null || Number.isSafeInteger(notice.source_event_id) && notice.source_event_id > 0)
    && (notice.read_at === null || typeof notice.read_at === 'string') && typeof notice.created_at === 'string'
    && Number.isSafeInteger(Date.parse(notice.created_at)) && Date.parse(notice.created_at) >= 0, 'invalid push source Notice');
  return { id: change.id, identity: change.identity, deleted: false,
    notice: { id: notice.id, kind: notice.kind, status: notice.status, lifecycle_type: notice.lifecycle_type,
      source_event_id: notice.source_event_id, read_at: notice.read_at, created_at: Date.parse(notice.created_at) } };
}

/** Notification transport only: no Worker ownership, writes to source projects, or daemon startup. */
export class WebPushService {
  constructor(projectHost, { config, authScope, preferences, now = Date.now, send = sendWebPush,
    intervalMs = 10000, sourceTimeoutMs = 4000, pagesPerRefresh = 4 } = {}) {
    check(projectHost && typeof projectHost.status === 'function' && typeof projectHost.openRoute === 'function', 'project Host required');
    for (const value of [intervalMs, sourceTimeoutMs, pagesPerRefresh]) check(Number.isSafeInteger(value) && value > 0, 'invalid push resource limit');
    check(pagesPerRefresh <= 8, 'invalid push page limit');
    this.host = projectHost; this.store = new WebPushStore(config, authScope); this.preferences = preferences;
    this.now = now; this.send = send; this.interval = intervalMs; this.sourceTimeout = sourceTimeoutMs; this.pages = pagesPerRefresh;
    this.controller = new AbortController(); this.pending = new Set(); this.closed = false; this.started = false;
    this.timer = null; this.inflight = null; this.active = false; this.lastError = null;
    this.suppressedSince = 0; this.suppressedChannels = {};
  }
  assertOpen() { check(!this.closed, 'Web Push service is stopping'); }
  async prefs() {
    const model = await this.preferences(); this.assertOpen();
    check(isPlainObject(model?.values) && typeof model.values.noticeNotifications === 'boolean', 'push preferences unavailable');
    return model.values;
  }
  start() {
    this.assertOpen();
    if (this.started) return;
    this.started = true; this.active = Boolean(this.store.read()?.subscriptions.length);
    if (this.active) this.schedule(0);
  }
  schedule(delay = this.interval) {
    if (!this.started || this.closed || this.timer || this.inflight || !this.active) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const work = this.tick().catch(() => { this.lastError = '后台推送读取或发送未完成，将在有界策略内重试。'; });
      this.inflight = work;
      work.finally(() => { this.inflight = null; this.schedule(); });
    }, delay);
    this.timer.unref?.();
  }
  config() {
    this.assertOpen();
    return this.store.update(data => ({ version: WEB_PUSH_VERSION, public_key: data.keys.public_key }), { create: true });
  }
  subscribe(value, origin) {
    this.assertOpen();
    const subscription = normalizePushSubscription(value); pushOrigin(origin);
    check(subscription.expirationTime === null || subscription.expirationTime > this.now(), 'Web Push subscription has expired');
    const id = hash(subscription.endpoint);
    const result = this.store.update(data => {
      const existing = data.subscriptions.find(row => row.id === id);
      if (existing) {
        check(existing.origin === origin, 'Web Push subscription belongs to another origin');
        existing.subscription = subscription;
      } else {
        check(data.subscriptions.length < PUSH_LIMITS.subscriptions, 'Web Push client limit reached; revoke an existing client first');
        data.subscriptions.push({ id, subscription, origin, created_at: this.now(), last_test: 0 });
      }
      return { version: WEB_PUSH_VERSION, id };
    }, { create: true });
    this.active = true; this.start(); this.schedule(0);
    return result;
  }
  status(endpoint, origin) {
    this.assertOpen(); pushEndpoint(endpoint); pushOrigin(origin);
    return { version: WEB_PUSH_VERSION, subscribed: Boolean(this.store.read()?.subscriptions.some(row => row.id === hash(endpoint)
      && row.origin === origin && (row.subscription.expirationTime === null || row.subscription.expirationTime > this.now()))) };
  }
  unsubscribe(endpoint, origin) {
    this.assertOpen(); pushEndpoint(endpoint); pushOrigin(origin);
    this.store.update(data => {
      const id = hash(endpoint);
      data.subscriptions = data.subscriptions.filter(row => row.id !== id || row.origin !== origin);
      const clients = new Set(data.subscriptions.map(row => row.id));
      data.queue = data.queue.filter(job => clients.has(job.subscription_id));
      this.active = clients.size > 0;
    });
    if (!this.active) { clearTimeout(this.timer); this.timer = null; }
    return { version: WEB_PUSH_VERSION, subscribed: false };
  }
  preferencesChanged(model, patch) {
    this.assertOpen();
    const prefs = model.values, now = this.now();
    // Retain conservative barriers in memory even if a concurrent settings writer prevents publication.
    if (Object.hasOwn(patch, 'noticeNotifications')) this.suppressedSince = now;
    if (Object.hasOwn(patch, 'noticeChannels')) {
      for (const [type, channels] of Object.entries(prefs.noticeChannels)) if (channels.system) this.suppressedChannels[type] = now;
    }
    this.store.update(data => {
      if (Object.hasOwn(patch, 'noticeNotifications')) {
        data.enabled = prefs.noticeNotifications;
        if (prefs.noticeNotifications) data.enabled_since = now;
        data.queue = [];
      }
      if (Object.hasOwn(patch, 'noticeChannels')) {
        for (const [type, channels] of Object.entries(prefs.noticeChannels)) {
          if (channels.system) data.channel_since[type] = now;
        }
        data.queue = data.queue.filter(job => enabled(prefs, job));
      }
    });
  }
  async bounded(work, timeout) {
    this.assertOpen();
    const signal = this.controller.signal, operation = new AbortController();
    let timer, abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(new Error('Web Push operation interrupted'));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, timeout);
    });
    const promise = Promise.race([Promise.resolve().then(() => { this.assertOpen(); return work(operation.signal); }), interrupted]);
    this.pending.add(promise);
    try { return await promise; }
    finally {
      // A timed-out source read must release its RPC connection, not accumulate
      // sockets across periodic refreshes. This does not cancel a dispatched write.
      operation.abort(); clearTimeout(timer); signal.removeEventListener('abort', abort); this.pending.delete(promise);
    }
  }
  async deliver(subscription, keys, payload) {
    return this.bounded(signal => this.send({ subscription: subscription.subscription, keys, payload,
      subject: subscription.origin.replace(/^http:/, 'https:'), signal, now: this.now() }), 8500);
  }
  async test(endpoint, origin) {
    this.assertOpen(); pushEndpoint(endpoint); pushOrigin(origin);
    const selected = this.store.update(data => {
      const row = data.subscriptions.find(row => row.id === hash(endpoint) && row.origin === origin);
      check(row, 'Web Push client is not subscribed');
      check(!row.last_test || this.now() - row.last_test >= 10000, 'wait before sending another test notification');
      row.last_test = this.now();
      return { row: structuredClone(row), keys: data.keys };
    });
    check(selected, 'Web Push client is not subscribed');
    const result = await this.deliver(selected.row, selected.keys, { version: WEB_PUSH_VERSION, title: 'Lush · 推送测试',
      body: '推送测试已到达此设备。工作提醒将在这里显示。', tag: `lush.push.test:${selected.row.id}`, url: '/#settings' });
    if (result.expired) this.unsubscribe(endpoint, origin);
    check(result.accepted === true, 'push service did not accept the test notification');
    return { version: WEB_PUSH_VERSION, accepted: true };
  }
  async entries() {
    const model = await this.bounded(() => this.host.status(), this.sourceTimeout);
    check(Array.isArray(model.projects) && model.projects.length <= PUSH_LIMITS.sources, 'push project registry unavailable');
    const ids = new Set();
    return model.projects.map(row => {
      check(isPlainObject(row) && typeof row.project === 'string' && projectRouteId(row.project) === row.id
        && !ids.has(row.id), 'invalid push project identity');
      ids.add(row.id); return { id: row.id, project: row.project };
    });
  }
  async refreshSource(row, prefs) {
    let online = false;
    try {
      const binding = await this.bounded(() => this.host.openRoute(row.id), this.sourceTimeout);
      check(binding?.config?.project === row.project && typeof binding.client?.request === 'function', 'push source identity mismatch');
      for (let page = 0; page < this.pages; page++) {
        const snapshot = this.store.read()?.sources[row.id];
        if (!snapshot) break;
        const model = await this.bounded(signal => binding.client.request('notice.sync', { cursor: snapshot.cursor, limit: 100 }, { signal }), this.sourceTimeout);
        check(isPlainObject(model) && model.version === 1 && model.project === row.project && HEX.test(model.epoch)
          && typeof model.reset === 'boolean' && typeof model.has_more === 'boolean' && typeof model.cursor === 'string'
          && model.cursor.length <= 1024 && Array.isArray(model.changes) && model.changes.length <= 100, 'invalid push source synchronization');
        const changes = model.changes.map(change => changeModel(change, model.epoch));
        check((await this.entries()).some(entry => entry.id === row.id && entry.project === row.project), 'push source was removed');
        // A full queue must still drain existing jobs from a source whose authenticated read succeeded.
        // Otherwise the uncommitted next page would make that source appear offline forever.
        online = true;
        const applied = this.store.update(data => {
          const source = data.sources[row.id];
          if (!source || source.cursor !== snapshot.cursor || source.epoch !== snapshot.epoch) return false;
          if (model.reset || source.epoch !== model.epoch) {
            Object.assign(source, { epoch: model.epoch, ready: false, since: this.now(), floor: 0, seen: [] });
            data.queue = data.queue.filter(job => job.project_id !== row.id);
          }
          const seen = new Map(source.seen);
          for (const change of changes) {
            const notice = change.notice;
            if (change.deleted || !pending(notice)) {
              data.queue = data.queue.filter(job => job.project_id !== row.id || job.identity !== change.identity);
            }
            if (!notice) continue;
            const fresh = !seen.has(change.identity);
            seen.set(change.identity, notice.created_at);
            if (!fresh || !source.ready || !pending(notice) || !enabled(prefs, notice)
              || data.enabled !== true || notice.created_at < Math.max(source.since, data.enabled_since, this.now() - MAX_AGE)
              || notice.created_at <= source.floor
              || notice.created_at < (data.channel_since[notice.lifecycle_type] || 0)) continue;
            for (const subscription of data.subscriptions) {
              if (subscription.created_at > notice.created_at) continue;
              const id = hash(`${subscription.id}:${row.id}:${model.epoch}:${change.identity}`);
              if (data.queue.some(job => job.id === id)) continue;
              check(data.queue.length < PUSH_LIMITS.queue, 'Web Push queue limit reached');
              data.queue.push({ id, subscription_id: subscription.id, project_id: row.id,
                identity: change.identity, epoch: model.epoch, notice_id: notice.id, kind: notice.kind,
                lifecycle_type: notice.lifecycle_type, created_at: notice.created_at, attempts: 0,
                next_attempt: this.now(), expires_at: notice.created_at + MAX_AGE, lease_until: 0 });
            }
          }
          const ordered = [...seen].sort((a, b) => a[1] - b[1]);
          if (ordered.length > PUSH_LIMITS.seen) {
            source.floor = Math.max(source.floor, ordered[ordered.length - PUSH_LIMITS.seen - 1][1]);
          }
          source.seen = ordered.slice(-PUSH_LIMITS.seen);
          source.cursor = model.cursor;
          if (!model.has_more) source.ready = true;
          return true;
        });
        if (!applied || !model.has_more) break;
      }
    } catch { this.lastError = '部分来源不可达或推送增量未补齐；未启动后台。'; }
    return online;
  }
  syncPreferences(data, prefs) {
    data.enabled_since = Math.max(data.enabled_since, this.suppressedSince);
    for (const [type, since] of Object.entries(this.suppressedChannels)) data.channel_since[type] = Math.max(data.channel_since[type] || 0, since);
    if (data.enabled !== prefs.noticeNotifications) {
      data.enabled = prefs.noticeNotifications;
      if (prefs.noticeNotifications) data.enabled_since = this.now();
      data.queue = [];
    }
  }
  async tick() {
    this.assertOpen();
    if (!this.store.read()?.subscriptions.length) { this.active = false; return; }
    const prefs = await this.prefs(), entries = await this.entries(), now = this.now();
    const allowed = new Set(entries.map(row => row.id));
    this.store.update(data => {
      this.syncPreferences(data, prefs);
      data.subscriptions = data.subscriptions.filter(row => row.subscription.expirationTime === null || row.subscription.expirationTime > now);
      const subscriptions = new Set(data.subscriptions.map(row => row.id));
      for (const id of Object.keys(data.sources)) if (!allowed.has(id)) delete data.sources[id];
      for (const row of entries) if (!data.sources[row.id] || data.sources[row.id].project !== row.project) {
        data.sources[row.id] = { project: row.project, epoch: null, cursor: null, ready: false, since: now, floor: 0, seen: [] };
      }
      data.queue = data.queue.filter(job => allowed.has(job.project_id) && subscriptions.has(job.subscription_id)
        && job.expires_at > now && enabled(prefs, job));
      this.active = subscriptions.size > 0;
    });
    if (!this.active) return;
    const online = new Set(); let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (!this.closed && next < entries.length) {
        const row = entries[next++]; if (await this.refreshSource(row, prefs)) online.add(row.id);
      }
    }));
    for (let count = 0; count < 8 && !this.closed; count++) {
      const latest = await this.prefs(), current = new Set((await this.entries()).map(row => row.id));
      const claimed = this.store.update(data => {
        this.syncPreferences(data, latest);
        data.queue = data.queue.filter(job => current.has(job.project_id) && job.expires_at > this.now()
          && enabled(latest, job) && job.created_at >= data.enabled_since
          && job.created_at >= (data.channel_since[job.lifecycle_type] || 0));
        const job = data.queue.find(job => online.has(job.project_id) && job.attempts < 3 && job.next_attempt <= this.now() && job.lease_until <= this.now());
        if (!job) return null;
        const subscription = data.subscriptions.find(row => row.id === job.subscription_id);
        if (!subscription) { data.queue = data.queue.filter(row => row.id !== job.id); return null; }
        job.attempts++; job.lease_until = this.now() + 30000;
        return { job: structuredClone(job), subscription: structuredClone(subscription), keys: data.keys };
      });
      if (!claimed) break;
      const { job, subscription, keys } = claimed;
      let result;
      try {
        // A pending read/sync may have overlapped a user disabling notifications or revoking this client.
        const saved = this.store.read();
        const values = await this.prefs();
        if (!enabled(values, job) || !saved?.subscriptions.some(row => row.id === subscription.id)
          || !saved.queue.some(row => row.id === job.id)) continue;
        result = await this.deliver(subscription, keys, { version: WEB_PUSH_VERSION, title: 'Lush · 工作状态更新',
          body: ['question', 'questionnaire', 'plan'].includes(job.kind) ? '有新的待答事项，请打开 Lush 查看。'
            : STATUS_BODIES[job.lifecycle_type] || '有新的工作告知，请打开 Lush 查看。',
          tag: `lush.push:${job.project_id}:${job.epoch}:${job.identity}`, url: pushNoticeUrl(job.project_id, job.notice_id) });
      } catch { result = { accepted: false, expired: false, retryable: true }; }
      if (this.closed) break;
      this.store.update(data => {
        const current = data.queue.find(row => row.id === job.id);
        if (!current || current.attempts !== job.attempts) return;
        if (result.expired) {
          data.subscriptions = data.subscriptions.filter(row => row.id !== subscription.id);
          data.queue = data.queue.filter(row => row.subscription_id !== subscription.id);
        } else if (result.accepted || !result.retryable || current.attempts >= 3) {
          data.queue = data.queue.filter(row => row.id !== job.id);
        } else {
          current.next_attempt = this.now() + (current.attempts === 1 ? 10000 : 60000); current.lease_until = 0;
        }
      });
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); this.timer = null; this.controller.abort();
    await Promise.allSettled([this.inflight, ...this.pending]);
  }
}
