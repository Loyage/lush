import { createHash } from 'node:crypto';
import { AgentConnectionsService } from '../../src/core/agent-connections.js';

export const NOW = Date.parse('2026-01-10T12:00:00.000Z');
export const iso = delta => new Date(NOW + delta).toISOString();
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export const resource = (remaining = 70, extra = {}) => ({ id: 'primary', kind: 'quota', scope: 'account', label: '5h quota', unit: '%',
  remaining, total: 100, used: remaining === null ? null : 100 - remaining, used_percent: remaining === null ? null : 100 - remaining,
  reset_at: iso(3600000), window_seconds: 18000, models: [], ...extra });
export const observation = (extra = {}) => ({ status: 'available', checked_at: iso(-1000), source: 'usage_api', resources: [resource()], error_code: null, reason: null, ...extra });
export const connection = (extra = {}) => ({ id: 'conn-one', label: 'Personal', provider: 'deepseek', endpoint: 'https://api.deepseek.com/v1',
  auth_type: 'api_key', enabled: true, models: [], credential: { status: 'configured', identity: null, expires_at: null }, ...extra });

/** No network or real secrets: manager stub implements the public/private Provider seam. */
export class ManagerStub {
  constructor(connections = [connection()]) {
    this.connections = connections; this.policy = { enabled: false, interval_minutes: 5, retention_days: 90 };
    this.keys = new Map(connections.map(item => [item.id,'test-secret'])); this.calls = 0; this.starts = 0; this.stops = 0;
    this.result = observation(); this.onQuery = null; this.revisions = new Map();
  }
  config() { return { version: 1, sampling: this.policy, connections: this.connections, token: 'MUST_NOT_RETURN' }; }
  save(value, credential) {
    const id = value.id || `conn-${this.connections.length + 1}`;
    const index = this.connections.findIndex(item => item.id === id);
    const next = connection({ ...value, id, credential: connection().credential });
    if (index < 0) this.connections.push(next); else this.connections[index] = next;
    if (credential?.api_key) this.keys.set(id,credential.api_key);
    return { ...next, access_token: 'MUST_NOT_RETURN' };
  }
  remove(id) { this.connections = this.connections.filter(item => item.id !== id); this.keys.delete(id); return { removed: id }; }
  configureSampling(value) { this.policy = value; return value; }
  identity(id) {
    const item = this.connections.find(item => item.id === id);
    return { account_key: digest(this.keys.get(id) || 'unconfigured'), source_key: digest(item?.endpoint || 'removed'),
      revision: digest([this.keys.get(id),item?.endpoint,this.revisions.get(id) || 0].join(':')) };
  }
  async query(id) {
    this.calls++;
    const result = { id, ...this.identity(id), observation: this.result };
    if (this.onQuery) return this.onQuery(id,result);
    return result;
  }
  async prepareRuntime(id) {
    return { connection: this.connections.find(item => item.id === id), credential: { type: 'api_key', key: this.keys.get(id) }, ...this.identity(id) };
  }
  async loginStart(id) {
    this.starts++;
    return { id, login_id: 'test-login', url: 'https://auth.openai.com/oauth/authorize?state=fixture', expires_at: iso(600000),
      redirect_uri: 'http://localhost:1455/auth/callback', instructions: 'provider-specific message', credential: 'MUST_NOT_RETURN' };
  }
  async loginFinish(id) {
    const item = this.connections.find(item => item.id === id); this.keys.set(id,'new-account'); return item;
  }
  async stop() { this.stops++; }
}
export function install(fixture, options = {}) {
  const manager = options.manager || new ManagerStub();
  const service = new AgentConnectionsService(fixture.project,{ now: () => NOW, ...options, manager });
  fixture.project.agentConnections = service;
  return { manager, service };
}
export function timers() {
  let id = 0; const waiting = new Map();
  return { waiting, setTimeout(fn,ms) { const key = ++id; waiting.set(key,{fn,ms}); return key; }, clearTimeout(key) { waiting.delete(key); },
    fire() { const [key,item] = waiting.entries().next().value; waiting.delete(key); return item.fn(); } };
}
