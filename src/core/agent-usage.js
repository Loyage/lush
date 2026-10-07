import { createHash } from 'node:crypto';
import { UsageSettings } from '../agent/usage-settings.js';
import { check } from './types.js';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function usageSourceKey(config, provider) {
  return hash(config.custom.find(item => item.provider === provider) || { provider, adapter: 'builtin-v1' });
}

const RETIRED = 'legacy agent usage is retired; use model-source connections for balance queries and sampling';

/** Read-only compatibility for archived independent Pi usage. Never queries, samples or prunes. */
export class AgentUsageService {
  constructor(project, options = {}) {
    this.store = project.store; this.settings = new UsageSettings(project.config);
    this.now = options.now || Date.now;
  }
  config() { return this.settings.get(); }
  configure() { check(false, RETIRED); }
  query() { check(false, RETIRED); }
  start() {} // Historical enabled=true is not authorization to restart retired sampling/cleanup.
  history({ provider = null, account_key = null, days = 7 } = {}) {
    check(provider === null || (typeof provider === 'string' && /^[a-z][a-z0-9_-]{0,79}$/i.test(provider)), 'invalid usage history provider');
    check(account_key === null || (typeof account_key === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(account_key)), 'invalid usage history account');
    check([1,7,30,90].includes(days), 'usage history days must be 1, 7, 30 or 90');
    // Retention is legacy metadata, not a deletion/filter policy for archived records.
    let retention_days = 90;
    try { retention_days = this.config().retention_days; } catch {} // Damaged config must not hide old SQLite history.
    const now = this.now();
    return this.store.readAgentUsageHistory({ provider, account_key, from: new Date(now - days * 86400000).toISOString(),
      to: new Date(now).toISOString(), retention_days });
  }
  async stop() {}
}
