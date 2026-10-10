import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { check } from '../core/types.js';
import { ConnectionFile } from './connections-file.js';
import { DEFAULT_ENDPOINTS, digest, secret, fields, object, validId, normalizeConnection, normalizeSampling,
  requestJson, fail, safeCode, unavailable } from './connections-utils.js';
import { queryConnection } from './connections-query.js';
import { authorization, callbackCode, REDIRECT_URI, exchange, refresh } from './connections-oauth.js';
import { ConnectionDeviceLogins } from './connections-device.js';
import { ConnectionObservationFile } from './connections-observations.js';
import { ConnectionCatalogFile, LISTINGS, catalogKey, listingUrl, localModels, manualModels, normalizeCatalog } from './connections-catalog.js';
import { networkSnapshot } from './network.js';
import { settingsConfigurationScope, scopedConfiguration, configurationScope } from '../core/device-config.js';

const STORAGE = Symbol('connection-storage');
const storedRow = (row, file) => Object.defineProperty({ ...row }, STORAGE, { value: file });

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
    // Host settings have an explicit device root but no project identity. This is not
    // a synthetic Project and never acquires project history or a daemon binding.
    this.deviceOnly = config.project === null && !config.deviceHome;
    this.configurationConfig = this.deviceOnly ? { ...config, deviceHome: config.home } : config;
    this.scope = settingsConfigurationScope(this.configurationConfig, options.scope);
    check(!this.deviceOnly || this.scope === 'device', 'project configuration is unavailable');
    this.networkConfig = this.scope === 'device' ? scopedConfiguration(this.configurationConfig, 'device') : config;
    this.file = new ConnectionFile(this.networkConfig.home, { privateRoot: this.scope === 'device' });
    this.sharedFile = null; // Legacy project credentials are migration sources, never runtime fallbacks.
    this.catalogs = new ConnectionCatalogFile(this.file);
    this.catalogStores = new Map([[this.file.home, this.catalogs]]);
    this.observationStores = new Map();
    this.scopedManagers = options.scopedManagers || new Map();
    this.scopedManagers.set(this.scope, this);
    this.options = options; this.now = options.now || Date.now;
    this.logins = new Map(); this.flights = new Map(); this.pending = new Set();
    this.devices = new ConnectionDeviceLogins(this, publicConnection);
    this.controller = new AbortController(); this.closed = false;
  }
  _alive() { if (this.closed) fail('stopped'); }
  forScope(scope) {
    this._alive(); scope = settingsConfigurationScope(this.configurationConfig, scope);
    check(!this.deviceOnly || scope === 'device', 'project configuration is unavailable');
    if (!this.scopedManagers.has(scope)) new ConnectionManager(this.configurationConfig,
      { ...this.options, scope, scopedManagers: this.scopedManagers });
    return this.scopedManagers.get(scope);
  }
  _data() {
    const local = this.file.read();
    return { ...local, connections: local.connections.map(row => storedRow(row, this.file)) };
  }
  _row(id) {
    check(validId(id), 'connection id is invalid');
    const row = this._data().connections.find(row => row.id === id);
    check(row, 'connection not found'); return row;
  }
  _storage(row) { return row[STORAGE] || this.file; }
  _revision(row) { return digest([row, this._storage(row).home]); }
  storageScope(id) {
    const file = this._storage(this._row(id));
    return this.configurationConfig.deviceHome && file.home === this.configurationConfig.deviceHome ? 'device' : 'project';
  }
  _view(row) {
    const view = publicConnection(row, this.now());
    if (this.configurationConfig.deviceHome) view.storage_scope = this._storage(row).home === this.configurationConfig.deviceHome ? 'device' : 'project';
    return view;
  }
  _catalogStore(row) {
    const file = this._storage(row);
    if (!this.catalogStores.has(file.home)) this.catalogStores.set(file.home, new ConnectionCatalogFile(file));
    return this.catalogStores.get(file.home);
  }
  _observationStore(row) {
    const file = this._storage(row);
    if (!this.observationStores.has(file.home)) this.observationStores.set(file.home, new ConnectionObservationFile(file));
    return this.observationStores.get(file.home);
  }
  _observationKey(row) { return digest(['connection-observation-v1', row.id, identity(row)]); }
  /** Local read on every request: another daemon or Host may have refreshed this source. */
  cachedObservation(id) {
    const row = this._row(id);
    return this._observationStore(row).get(this._observationKey(row));
  }
  recordObservation(id, account_key, source_key, observation) {
    return this._track(async () => {
      const row = this._row(id), current = identity(row);
      if (account_key !== current.account_key || source_key !== current.source_key) fail('auth_changed');
      await this._observationStore(row).put(this._observationKey(row), observation);
    });
  }
  isBusy() {
    return [...this.scopedManagers.values()].some(manager => {
      manager._purgeLogins(); manager.devices.purge();
      return manager.pending.size || manager.logins.size || manager.flights.size
        || [...manager.devices.sessions.values()].some(session => !session.connection);
    });
  }
  _track(fn) {
    this._alive();
    const pending = Promise.resolve().then(fn).finally(() => this.pending.delete(pending));
    this.pending.add(pending); return pending;
  }
  networkSnapshot() { return networkSnapshot(this.networkConfig); }
  _request(url, init, options = {}) {
    this._alive();
    const signal = options.signal ? AbortSignal.any([this.controller.signal, options.signal]) : this.controller.signal;
    const network = options.network || this.networkSnapshot();
    return requestJson(url, init, { ...this.options, ...options, signal,
      fetch: (target, request) => network.fetch(target, request, this.options.fetch) });
  }
  config() {
    const data = this._data();
    const result = { version: 1, sampling: data.sampling, connections: data.connections.map(row => this._view(row)) };
    if (this.configurationConfig.deviceHome) {
      const device = fs.existsSync(this.file.file);
      result.configuration_scope = configurationScope(this.configurationConfig, this.scope,
        device ? 'device' : 'default', false);
    }
    return result;
  }
  /** Internal synchronous identity; never returns credentials or goes on the public config read model. */
  identity(id) {
    const row = this._row(id);
    return { ...identity(row), revision: this._revision(row) };
  }
  save(connection, credential = null) {
    this._alive();
    check(object(connection), 'connection fields are invalid');
    // Public read metadata is not configuration and cannot choose or change the write root.
    const { storage_scope, ...input } = connection;
    check(storage_scope === undefined || ['device', 'project'].includes(storage_scope), 'connection storage scope is invalid');
    const id = input.id ?? randomUUID(), normalized = normalizeConnection(input, id);
    let key = null;
    if (credential !== null && credential !== undefined) {
      fields(credential, ['api_key'], 'credential');
      check(normalized.auth_type === 'api_key', 'OAuth credentials require the login flow');
      if (credential.api_key !== undefined && credential.api_key !== '') {
        check(secret(credential.api_key), 'API key is invalid'); key = credential.api_key;
      }
    }
    // Inherited connections are updated in their actual root; new project-view connections stay local.
    const target = connection.id === undefined ? this.file : this._storage(this._row(id));
    const result = target.transaction(data => {
      const index = data.connections.findIndex(row => row.id === id), previous = data.connections[index];
      check(connection.id === undefined || previous, 'connection not found');
      check(index >= 0 || data.connections.length < 50, 'too many connections');
      const keep = previous?.provider === normalized.provider && previous?.auth_type === normalized.auth_type
        && new URL(previous.endpoint).origin === new URL(normalized.endpoint).origin;
      const row = { ...normalized, revision: randomUUID(),
        credential: key ? { type: 'api_key', key } : keep ? previous.credential : null };
      if (index < 0) data.connections.push(row); else data.connections[index] = row;
      return this._view(storedRow(row, target));
    });
    this._cancelLogins(id); return result;
  }
  remove(id) {
    this._alive(); check(validId(id), 'connection id is invalid');
    const target = this._storage(this._row(id));
    target.transaction(data => {
      const index = data.connections.findIndex(row => row.id === id); check(index >= 0, 'connection not found');
      data.connections.splice(index, 1);
    });
    this._cancelLogins(id); return { removed: id };
  }
  configureSampling(sampling) {
    this._alive(); const normalized = normalizeSampling(sampling);
    this.file.transaction(data => { data.sampling = normalized; }); return normalized;
  }
  _cancelLogins(id) {
    for (const [key,value] of this.logins) if (value.id === id) this.logins.delete(key);
    this.devices.cancelFor(id);
  }
  _purgeLogins() { for (const [key,value] of this.logins) if (value.expires <= this.now()) this.logins.delete(key); }
  _publish(id, revision, credential) {
    this._alive();
    const target = this._storage(this._row(id));
    return target.transaction(data => {
      const row = data.connections.find(row => row.id === id);
      if (!row || this._revision(storedRow(row, target)) !== revision) fail('auth_changed');
      row.credential = credential; row.revision = randomUUID();
      return storedRow(row, target);
    });
  }
  async _runtime(row, minimumValidityMs = 300000, network = this.networkSnapshot()) {
    this._alive();
    if (!row.enabled) fail('disabled');
    if (!row.credential) fail('unconfigured');
    if (row.credential.type === 'oauth' && new URL(row.endpoint).origin !== new URL(DEFAULT_ENDPOINTS[row.provider]).origin) fail('unsupported');
    let current = row;
    if (row.credential.type === 'oauth' && row.credential.expires <= this.now() + minimumValidityMs) {
      const key = digest([row,minimumValidityMs,network.key]);
      if (!this.flights.has(key)) {
        const pending = this._refresh(row, minimumValidityMs, network).finally(() => this.flights.delete(key));
        this.flights.set(key, pending);
      }
      current = await this.flights.get(key);
    }
    this._alive();
    // Even non-refreshing asynchronous operations must reject configuration changes.
    const latest = this._data().connections.find(entry => entry.id === row.id);
    if (!latest || this._revision(latest) !== this._revision(current)) fail('auth_changed');
    if (current.credential.type === 'oauth' && current.credential.expires <= this.now() + minimumValidityMs) fail('expired');
    return { connection: publicConnection(current, this.now()), credential: { ...current.credential }, ...identity(current) };
  }
  async _refresh(row, minimumValidityMs, network) {
    const source = this._storage(row);
    const lock = await source.refreshLock(row.id, this.controller.signal, this.options.lockTimeout);
    try {
      lock.assert();
      const latest = this._data().connections.find(entry => entry.id === row.id);
      if (!latest || this._storage(latest).home !== source.home) fail('auth_changed');
      if (this._revision(latest) !== this._revision(row)) {
        // Another coordinated refresh can be reused, but changed configuration/identity cannot.
        const { credential: a, revision: ar, ...ac } = row;
        const { credential: b, revision: br, ...bc } = latest;
        if (digest(ac) !== digest(bc) || !b || b.type !== 'oauth' || b.accountId !== a.accountId || b.expires <= this.now() + minimumValidityMs) fail('auth_changed');
        return latest;
      }
      if (latest.credential.expires > this.now() + minimumValidityMs) return latest;
      const credential = await refresh(latest.credential, (url,init) => this._request(url,init,{ network }), this.now);
      lock.assert();
      return this._publish(row.id, this._revision(latest), credential);
    } finally { lock.release(); }
  }
  prepareRuntime(id) { const network = this.networkSnapshot(); return this._track(() => this._runtime(this._row(id), 300000, network)); }
  query(id, network = this.networkSnapshot()) {
    return this._track(async () => {
      const row = this._row(id), checked_at = new Date(this.now()).toISOString();
      let observation, binding = identity(row);
      try {
        if (!row.enabled) fail('disabled');
        // Refuse a proxy before ANY token refresh: query is not authorization to send proxy credentials to an issuer.
        if (!Object.hasOwn(DEFAULT_ENDPOINTS, row.provider)
          || new URL(row.endpoint).origin !== new URL(DEFAULT_ENDPOINTS[row.provider]).origin)
          return { id, ...binding, observation: unavailable('unsupported', checked_at, 'unsupported') };
        const runtime = await this._runtime(row, 30000, network); binding = { account_key: runtime.account_key, source_key: runtime.source_key };
        observation = await queryConnection(runtime.connection, runtime.credential, checked_at, (url,init) => this._request(url,init,{ network }));
        this._alive();
        const latest = this._data().connections.find(entry => entry.id === id);
        if (!latest || this._storage(latest).home !== this._storage(row).home || digest(identity(latest)) !== digest(binding) || latest.enabled !== row.enabled || latest.label !== row.label
          || latest.provider !== row.provider || latest.endpoint !== row.endpoint || digest(latest.models) !== digest(row.models)) fail('auth_changed');
      } catch (error) {
        const code = safeCode(error);
        observation = unavailable(['unconfigured','disabled'].includes(code) ? 'unconfigured' : 'error', checked_at, code);
      }
      return { id, ...binding, observation };
    });
  }
  deviceStart(id) { return this.devices.start(id); }
  devicePoll(id, login_id) { return this.devices.poll(id, login_id); }
  deviceCancel(id, login_id) { return this.devices.cancel(id, login_id); }
  loginStart(id) {
    this._alive(); const row = this._row(id);
    check(row.auth_type === 'oauth' && row.provider === 'openai-codex', 'connection does not support OAuth login');
    this._purgeLogins(); this._cancelLogins(id);
    const flow = authorization(), login_id = randomUUID(), expires = this.now() + 15 * 60000;
    this.logins.set(login_id, { ...flow, id, revision: this._revision(row), expires, network: this.networkSnapshot() });
    return { id, login_id, url: flow.url, expires_at: new Date(expires).toISOString(), redirect_uri: REDIRECT_URI,
      instructions: '在浏览器完成授权；若 localhost 回调页无法打开，复制地址栏完整回调 URL（含 code/state）粘贴回来。不要分享回调 URL。' };
  }
  loginFinish(id, login_id, redirect_url) {
    return this._track(async () => {
      check(validId(login_id), 'login id is invalid');
      const login = this.logins.get(login_id);
      if (!login || login.id !== id || login.exchanging || login.expires <= this.now()) { this._purgeLogins(); fail('login_expired'); }
      const row = this._row(id); if (this._revision(row) !== login.revision) fail('auth_changed');
      const code = callbackCode(redirect_url, login.state);
      // Consume before await, but retain the guard so a newer device/browser
      // login can invalidate an exchange already in flight.
      login.exchanging = true;
      try {
        const credential = await exchange(code, login.verifier, (url,init) => this._request(url,init,{ network: login.network }), this.now);
        if (this.logins.get(login_id) !== login || login.expires <= this.now()) fail('login_expired');
        return this._view(this._publish(id, this._revision(row), credential));
      } finally { if (this.logins.get(login_id) === login) this.logins.delete(login_id); }
    });
  }
  /** Cached, identity-scoped model catalog. Local read only; never contacts the provider. */
  catalog(id) {
    const row = this._row(id), ident = identity(row), key = catalogKey(row, ident);
    const stored = this._catalogStore(row).get(key);
    if (stored) return stored;
    return normalizeCatalog(this._synthesized(row), id, this.now);
  }
  _synthesized(row) {
    const manual = manualModels(row);
    const checked_at = new Date(this.now()).toISOString();
    if (!row.enabled) return { version: 1, id: row.id, checked_at, status: 'unknown',
      source: manual.length ? 'manual' : 'none', models: manual, warning: '连接已禁用；未同步模型目录。', error_code: null };
    if (manual.length) return { version: 1, id: row.id, checked_at, status: 'unknown', source: 'manual', models: manual,
      warning: '仅显示用户配置的模型范围；尚未与账号同步验证可用性或额度。', error_code: null };
    return { version: 1, id: row.id, checked_at, status: 'unknown', source: 'none', models: [],
      warning: '尚未同步模型目录；刷新后显示可用模型。', error_code: null };
  }
  _fallbackModels(row, failed) {
    const manual = manualModels(row);
    if (manual.length) return Promise.resolve({ status: 'cached', source: 'manual', models: manual,
      warning: '显示用户配置的模型范围；未与账号同步验证可用性或额度。', error_code: failed?.error_code ?? null });
    const source = this.options.piModels || (async () => {
      const { discoverPiModelMetadata } = await import('./status.js');
      return discoverPiModelMetadata(this.networkConfig);
    });
    return Promise.resolve().then(source).then(metadata => {
      const local = localModels(row, metadata);
      if (local.length) return { status: 'cached', source: 'pi-local', models: local,
        warning: '来自 Lush 独立 Pi 本地元数据，未联网验证账号可用性；实际调用仍须选择匹配来源。', error_code: failed?.error_code ?? null };
      return null;
    }).catch(() => null).then(fallback => fallback || (failed?.status === 'error'
      ? { status: 'error', source: 'none', models: [], warning: failed.warning, error_code: failed.error_code }
      : { status: 'unsupported', source: 'none', models: [], warning: '没有已授权的目录接口，也没有可用的本地模型元数据或手动范围；请手动指定模型。', error_code: null }));
  }
  /** Refresh one catalog from an audited listing / local metadata. Late or changed config is discarded. */
  catalogRefresh(id) {
    return this._track(async () => {
      const row = this._row(id), ident = identity(row), key = catalogKey(row, ident);
      const checked_at = new Date(this.now()).toISOString();
      if (!row.enabled) return normalizeCatalog(this._synthesized(row), id, this.now);
      let result = null;
      const listing = LISTINGS[row.provider];
      if (listing) {
        try {
          const headers = { Accept: 'application/json' };
          if (listing.auth && row.credential?.type === 'api_key' && row.credential.key) headers.Authorization = `Bearer ${row.credential.key}`;
          const data = await this._request(listingUrl(row, listing), { method: 'GET', headers });
          result = { status: 'fresh', source: 'listing', models: listing.parse(data, row.provider), warning: null, error_code: null };
        } catch (error) {
          const code = error?.connectionCode || 'network';
          result = { status: 'error', source: 'none', models: [], error_code: code,
            warning: code === 'unsupported' ? '此前服务商目录接口不可用。' : '无法从服务商目录接口取得模型列表。' };
        }
      }
      if (!result || result.status !== 'fresh') result = await this._fallbackModels(row, result);
      this._alive();
      const latest = this._data().connections.find(entry => entry.id === id);
      const after = latest ? identity(latest) : null;
      if (!latest || !after || this._storage(latest).home !== this._storage(row).home
        || after.account_key !== ident.account_key || after.source_key !== ident.source_key
        || latest.provider !== row.provider || latest.endpoint !== row.endpoint
        || digest(latest.models) !== digest(row.models)) return null;
      const catalog = normalizeCatalog({ ...result, version: 1, id, checked_at }, id, this.now);
      await this._catalogStore(row).put(key, catalog);
      return catalog;
    });
  }
  async stop() {
    const managers = [...this.scopedManagers.values()];
    for (const manager of managers) {
      manager.closed = true; manager.logins.clear(); manager.devices.stop(); manager.controller.abort();
    }
    await Promise.allSettled(managers.flatMap(manager => [...manager.pending]));
  }
}
