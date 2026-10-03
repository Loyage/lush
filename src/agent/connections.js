import { randomUUID } from 'node:crypto';
import { check } from '../core/types.js';
import { ConnectionFile } from './connections-file.js';
import { DEFAULT_ENDPOINTS, digest, secret, fields, validId, normalizeConnection, normalizeSampling,
  requestJson, fail, safeCode, unavailable } from './connections-utils.js';
import { queryConnection } from './connections-query.js';
import { authorization, callbackCode, REDIRECT_URI, exchange, refresh } from './connections-oauth.js';

function publicConnection(row, now) {
  const { revision, credential, ...connection } = row;
  const expires_at = credential?.type === 'oauth' ? new Date(credential.expires).toISOString() : null;
  return { ...connection, credential: { status: !credential ? 'unconfigured'
    : credential.type === 'oauth' && credential.expires <= now ? 'expired' : 'configured',
    identity: credential?.accountId ? `账号 ${digest(credential.accountId).slice(0, 8)}` : null, expires_at } };
}
function identity(row) {
  return {
    account_key: digest([row.provider, row.credential?.accountId || row.credential?.key || ['unconfigured', row.id]]),
    source_key: digest(['connector-v1', row.provider, row.endpoint, row.models]),
  };
}

/** Project-owned multi-account configuration and private credentials. No model calls. */
export class ConnectionManager {
  constructor(config, options = {}) {
    check(typeof config?.home === 'string' && config.home.length > 0, 'connection home is required');
    this.file = new ConnectionFile(config.home); this.options = options; this.now = options.now || Date.now;
    this.logins = new Map(); this.flights = new Map(); this.pending = new Set();
    this.controller = new AbortController(); this.closed = false;
  }
  _alive() { if (this.closed) fail('stopped'); }
  _row(id) {
    check(validId(id), 'connection id is invalid');
    const row = this.file.read().connections.find(row => row.id === id);
    check(row, 'connection not found'); return row;
  }
  _track(fn) {
    this._alive();
    const pending = Promise.resolve().then(fn).finally(() => this.pending.delete(pending));
    this.pending.add(pending); return pending;
  }
  _request(url, init) {
    this._alive();
    return requestJson(url, init, { ...this.options, signal: this.controller.signal });
  }
  config() {
    const data = this.file.read();
    return { version: 1, sampling: data.sampling, connections: data.connections.map(row => publicConnection(row, this.now())) };
  }
  /** Internal synchronous identity; never returns credentials or goes on the public config read model. */
  identity(id) {
    const row = this._row(id);
    return { ...identity(row), revision: digest(row) };
  }
  save(connection, credential = null) {
    this._alive();
    const id = connection?.id ?? randomUUID(), normalized = normalizeConnection(connection, id);
    let key = null;
    if (credential !== null && credential !== undefined) {
      fields(credential, ['api_key'], 'credential');
      check(normalized.auth_type === 'api_key', 'OAuth credentials require the login flow');
      if (credential.api_key !== undefined && credential.api_key !== '') {
        check(secret(credential.api_key), 'API key is invalid'); key = credential.api_key;
      }
    }
    const result = this.file.transaction(data => {
      const index = data.connections.findIndex(row => row.id === id), previous = data.connections[index];
      check(connection.id === undefined || previous, 'connection not found');
      check(index >= 0 || data.connections.length < 50, 'too many connections');
      const keep = previous?.provider === normalized.provider && previous?.auth_type === normalized.auth_type
        && new URL(previous.endpoint).origin === new URL(normalized.endpoint).origin;
      const row = { ...normalized, revision: randomUUID(),
        credential: key ? { type: 'api_key', key } : keep ? previous.credential : null };
      if (index < 0) data.connections.push(row); else data.connections[index] = row;
      return publicConnection(row, this.now());
    });
    this._cancelLogins(id); return result;
  }
  remove(id) {
    this._alive(); check(validId(id), 'connection id is invalid');
    this.file.transaction(data => {
      const index = data.connections.findIndex(row => row.id === id); check(index >= 0, 'connection not found');
      data.connections.splice(index, 1);
    });
    this._cancelLogins(id); return { removed: id };
  }
  configureSampling(sampling) {
    this._alive(); const normalized = normalizeSampling(sampling);
    this.file.transaction(data => { data.sampling = normalized; }); return normalized;
  }
  _cancelLogins(id) { for (const [key,value] of this.logins) if (value.id === id) this.logins.delete(key); }
  _purgeLogins() { for (const [key,value] of this.logins) if (value.expires <= this.now()) this.logins.delete(key); }
  _publish(id, revision, credential) {
    this._alive();
    return this.file.transaction(data => {
      const row = data.connections.find(row => row.id === id);
      if (!row || digest(row) !== revision) fail('auth_changed');
      row.credential = credential; row.revision = randomUUID();
      return { ...row };
    });
  }
  async _runtime(row, minimumValidityMs = 300000) {
    this._alive();
    if (!row.enabled) fail('disabled');
    if (!row.credential) fail('unconfigured');
    if (row.credential.type === 'oauth' && new URL(row.endpoint).origin !== new URL(DEFAULT_ENDPOINTS[row.provider]).origin) fail('unsupported');
    let current = row;
    if (row.credential.type === 'oauth' && row.credential.expires <= this.now() + minimumValidityMs) {
      const key = digest([row,minimumValidityMs]);
      if (!this.flights.has(key)) {
        const pending = this._refresh(row, minimumValidityMs).finally(() => this.flights.delete(key));
        this.flights.set(key, pending);
      }
      current = await this.flights.get(key);
    }
    this._alive();
    // Even non-refreshing asynchronous operations must reject configuration changes.
    const latest = this.file.read().connections.find(entry => entry.id === row.id);
    if (!latest || digest(latest) !== digest(current)) fail('auth_changed');
    if (current.credential.type === 'oauth' && current.credential.expires <= this.now() + minimumValidityMs) fail('expired');
    return { connection: publicConnection(current, this.now()), credential: { ...current.credential }, ...identity(current) };
  }
  async _refresh(row, minimumValidityMs) {
    const lock = await this.file.refreshLock(row.id, this.controller.signal, this.options.lockTimeout);
    try {
      lock.assert();
      const latest = this.file.read().connections.find(entry => entry.id === row.id);
      if (!latest) fail('auth_changed');
      if (digest(latest) !== digest(row)) {
        // Another coordinated refresh can be reused, but changed configuration/identity cannot.
        const { credential: a, revision: ar, ...ac } = row;
        const { credential: b, revision: br, ...bc } = latest;
        if (digest(ac) !== digest(bc) || !b || b.type !== 'oauth' || b.accountId !== a.accountId || b.expires <= this.now() + minimumValidityMs) fail('auth_changed');
        return latest;
      }
      if (latest.credential.expires > this.now() + minimumValidityMs) return latest;
      const credential = await refresh(latest.credential, (url,init) => this._request(url,init), this.now);
      lock.assert();
      return this._publish(row.id, digest(latest), credential);
    } finally { lock.release(); }
  }
  prepareRuntime(id) { return this._track(() => this._runtime(this._row(id))); }
  query(id) {
    return this._track(async () => {
      const row = this._row(id), checked_at = new Date(this.now()).toISOString();
      let observation, binding = identity(row);
      try {
        if (!row.enabled) fail('disabled');
        // Refuse a proxy before ANY token refresh: query is not authorization to send proxy credentials to an issuer.
        if (new URL(row.endpoint).origin !== new URL(DEFAULT_ENDPOINTS[row.provider]).origin)
          return { id, ...binding, observation: unavailable('unsupported', checked_at, 'unsupported') };
        const runtime = await this._runtime(row, 30000); binding = { account_key: runtime.account_key, source_key: runtime.source_key };
        observation = await queryConnection(runtime.connection, runtime.credential, checked_at, (url,init) => this._request(url,init));
        this._alive();
        const latest = this.file.read().connections.find(entry => entry.id === id);
        if (!latest || digest(identity(latest)) !== digest(binding) || latest.enabled !== row.enabled || latest.label !== row.label
          || latest.provider !== row.provider || latest.endpoint !== row.endpoint || digest(latest.models) !== digest(row.models)) fail('auth_changed');
      } catch (error) {
        const code = safeCode(error);
        observation = unavailable(['unconfigured','disabled'].includes(code) ? 'unconfigured' : 'error', checked_at, code);
      }
      return { id, ...binding, observation };
    });
  }
  loginStart(id) {
    this._alive(); const row = this._row(id);
    check(row.auth_type === 'oauth' && row.provider === 'openai-codex', 'connection does not support OAuth login');
    this._purgeLogins(); this._cancelLogins(id);
    const flow = authorization(), login_id = randomUUID(), expires = this.now() + 15 * 60000;
    this.logins.set(login_id, { ...flow, id, revision: digest(row), expires });
    return { id, login_id, url: flow.url, expires_at: new Date(expires).toISOString(), redirect_uri: REDIRECT_URI,
      instructions: '在浏览器完成授权；若 localhost 回调页无法打开，复制地址栏完整回调 URL（含 code/state）粘贴回来。不要分享回调 URL。' };
  }
  loginFinish(id, login_id, redirect_url) {
    return this._track(async () => {
      check(validId(login_id), 'login id is invalid');
      const login = this.logins.get(login_id);
      if (!login || login.id !== id || login.expires <= this.now()) { this._purgeLogins(); fail('login_expired'); }
      const row = this._row(id); if (digest(row) !== login.revision) fail('auth_changed');
      const code = callbackCode(redirect_url, login.state);
      // Consume before await. Network failure requires a new login, never a second token exchange.
      this.logins.delete(login_id);
      const credential = await exchange(code, login.verifier, (url,init) => this._request(url,init), this.now);
      return publicConnection(this._publish(id, digest(row), credential), this.now());
    });
  }
  async stop() {
    this.closed = true; this.logins.clear(); this.controller.abort();
    await Promise.allSettled([...this.pending]);
  }
}
