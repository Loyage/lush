import { createHash } from 'node:crypto';
import * as discovery from '../agent/status.js';
import { UsageSettings } from '../agent/usage-settings.js';
import { check } from './types.js';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function usageSourceKey(config, provider) {
  return hash(config.custom.find(item => item.provider === provider) || { provider, adapter: 'builtin-v1' });
}

/** One project owns settings, timer, concurrent queries and their sanitized cache. No model calls. */
export class AgentUsageService {
  constructor(project, options = {}) {
    this.project = project; this.store = project.store; this.settings = new UsageSettings(project.config);
    this.discoverStatus = options.discoverStatus || ((...args) => discovery.discoverAgentStatus(...args));
    this.discoverUsage = options.discoverUsage || ((...args) => discovery.discoverAgentUsage(...args));
    this.now = options.now || Date.now;
    this.setTimer = options.setTimeout || setTimeout; this.clearTimer = options.clearTimeout || clearTimeout;
    this.flights = new Set(); this.timer = null; this.closed = false; this.generation = 0;
  }
  config() { return this.settings.get(); }
  configure(value) {
    check(!this.closed && !this.project.stopping, 'project is stopping');
    this.project.assertWritable('configure usage queries');
    const config = this.settings.save(value);
    this.prune(config); this.schedule(config);
    return config;
  }
  prune(config) {
    this.store.pruneAgentUsage(new Date(this.now() - config.retention_days * 86400000).toISOString());
  }
  start() {
    // Invalid settings must not take down task recovery or be silently overwritten.
    try { const config = this.config(); this.prune(config); this.schedule(config); }
    catch { this.warning = '用量配置无法安全读取，后台采样未启用。'; }
  }
  schedule(config) {
    this.generation++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (!config.enabled || this.closed || this.project.stopping) return;
    const generation = this.generation;
    this.timer = this.setTimer(async () => {
      this.timer = null;
      try { await this.query(false); }
      catch { this.warning = '后台用量采样失败；未取得新的可用数值。'; }
      finally {
        // Disabling or changing settings while a request is in flight owns the next schedule.
        if (!this.closed && !this.project.stopping && this.generation === generation) {
          try { this.schedule(this.config()); }
          catch { this.warning = '用量配置无法安全读取，后台采样已停止。'; }
        }
      }
    }, config.interval_minutes * 60000);
    this.timer?.unref?.();
  }
  query(full = true) {
    check(!this.closed && !this.project.stopping, 'project is stopping');
    const usageConfig = this.config(), profile = this.project.agentSettings.resolve('agent');
    // Discovery owns single-flight because its identity hot-reads auth and environment files.
    // The service only tracks callers for shutdown; shared query_id observations deduplicate in SQLite.
    const pending = this.project.write('query agent usage', async () => {
      const data = await (full ? this.discoverStatus : this.discoverUsage)(this.project.config, profile, { usageConfig });
      // Retention is applied using the current policy, while source identity uses the queried snapshot.
      this.prune(this.config());
      let cacheBytes = 0, cacheTruncated = false;
      const accounts = (data.accounts || []).map(account => {
        if (!account.balance?.queried || !account.account_key) return account;
        const sourceKey = usageSourceKey(usageConfig, account.provider), balance = account.balance;
        const at = balance.checked_at || data.checked_at;
        const queryKey = hash([account.provider, account.account_key, sourceKey, balance.query_id || data.query_id || [at, balance.status, balance.items]]);
        const custom = usageConfig.custom.find(item => item.provider === account.provider);
        const items = balance.items?.length ? balance.items : custom?.items.map(item => ({ id: item.id, label: item.label,
          unit: item.unit, window_seconds: item.window_seconds, remaining: null, total: null, used: null, reset_at: null })) || [];
        this.store.recordAgentUsage({ query_key: queryKey, provider: account.provider, account_key: account.account_key,
          source_key: sourceKey, at, status: balance.status, error_code: balance.error_code, kind: balance.kind || custom?.kind, items });
        if (balance.status === 'available') return account;
        const last_success = this.store.lastAgentUsageSuccess(account.provider, account.account_key, sourceKey);
        if (!last_success) return account;
        const bytes = Buffer.byteLength(JSON.stringify(last_success));
        if (bytes > 16384 || cacheBytes + bytes > 65536) {
          cacheTruncated = true;
          return { ...account, last_success_truncated: true };
        }
        cacheBytes += bytes;
        return { ...account, last_success };
      });
      return { ...data, accounts, usage_config: usageConfig,
        ...(cacheTruncated ? { warnings: [...(data.warnings || []), '历史成功缓存较大，部分旧值未附在状态响应中；可在用量历史查看。'] } : {}) };
    }).finally(() => { this.flights.delete(pending); });
    this.flights.add(pending); return pending;
  }
  history({ provider = null, account_key = null, days = 7 } = {}) {
    check(provider === null || (typeof provider === 'string' && /^[a-z][a-z0-9_-]{0,79}$/i.test(provider)), 'invalid usage history provider');
    check(account_key === null || (typeof account_key === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(account_key)), 'invalid usage history account');
    check([1,7,30,90].includes(days), 'usage history days must be 1, 7, 30 or 90');
    const config = this.config(); this.prune(config);
    const now = this.now();
    return this.store.readAgentUsageHistory({ provider, account_key, from: new Date(now - Math.min(days, config.retention_days) * 86400000).toISOString(),
      to: new Date(now).toISOString(), retention_days: config.retention_days });
  }
  async stop() {
    this.closed = true; this.generation++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.flights]);
  }
}
