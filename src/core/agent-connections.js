import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { networkSnapshot } from '../agent/network.js';
import { check, LushError } from './types.js';
import { normalizeConfigurationScope, configurationScope } from './device-config.js';
import { normalizeCatalog } from '../agent/connections-catalog.js';
import { safeText as connectionText } from '../agent/connections-utils.js';
import { THINKING_LEVELS } from '../agent/settings.js';
import { connectionErrorCode, normalizeConnectionObservation, validConnectionHash, validConnectionId } from '../persistence/store/agent-connections.js';

const require = createRequire(import.meta.url);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PROVIDERS = new Set(['deepseek','openrouter','zai','kimi-coding','openai-codex','openai-compatible']);
const safeText = (value, max = 256) => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max) : null;
const failure = () => new LushError('连接操作失败，请检查连接配置、权限或重新登录。');
// Only trusted categories cross RPC. Never preserve provider messages or responses.
const DEVICE_FAILURE_CODES = new Set(['network','timeout','unsupported','unauthorized','rate_limited',
  'invalid_response','auth_changed','auth_locked','login_expired','stopped','unsupported_platform']);
const deviceFailure = error => new LushError(`Codex device login failed (${DEVICE_FAILURE_CODES.has(error?.connectionCode) ? error.connectionCode : 'unknown'})`);
const identityKey = (id, account, source) => hash([id,account,source]);
const fingerprint = connection => hash([connection.id,connection.label,connection.provider,connection.endpoint,
  connection.auth_type,connection.enabled,connection.models,connection.credential.identity]);

function boundedObservation(observation, budget) {
  const view = { ...observation, resources: [] };
  let truncated = false;
  for (const resource of observation.resources) {
    view.resources.push(resource);
    if (Buffer.byteLength(JSON.stringify(view)) > budget) { view.resources.pop(); truncated = true; }
  }
  return { view, truncated };
}

function publicConnection(connection) {
  check(validConnectionId(connection?.id) && PROVIDERS.has(connection.provider), 'invalid connection configuration');
  const url = new URL(connection.endpoint);
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search && url.href.length <= 2048, 'invalid connection endpoint');
  check(['api_key','oauth'].includes(connection.auth_type), 'invalid connection authentication type');
  const status = ['configured','unconfigured','expired','unknown'].includes(connection.credential?.status) ? connection.credential.status : 'unknown';
  const expires = connection.credential?.expires_at;
  const models = [...new Set((Array.isArray(connection.models) ? connection.models : []).slice(0, 100).map(model => safeText(model)).filter(Boolean))];
  const optionalText = (value, label, max) => value === undefined || value === null || value === ''
    ? '' : connectionText(value, label, max);
  const default_model = optionalText(connection.default_model, 'connection default model', 256);
  const default_thinking = optionalText(connection.default_thinking, 'connection default thinking', 32);
  check(THINKING_LEVELS.pi.includes(default_thinking), 'invalid connection default thinking');
  check(!default_model || !models.length || models.includes(default_model), 'invalid connection default model');
  // Defaults are editing hints, not part of the account/cache fingerprint above.
  return { id: connection.id, label: safeText(connection.label, 256) || connection.provider, provider: connection.provider,
    endpoint: url.href, auth_type: connection.auth_type, enabled: connection.enabled === true,
    models, default_model, default_thinking, notify_reset: connection.notify_reset === true,
    ...(['project', 'device'].includes(connection.storage_scope) ? { storage_scope: connection.storage_scope } : {}),
    credential: { status, identity: safeText(connection.credential?.identity, 120),
      expires_at: typeof expires === 'string' && Number.isFinite(Date.parse(expires)) ? new Date(expires).toISOString() : null } };
}
function sampling(value) {
  check(value && typeof value === 'object' && Object.keys(value).every(key => ['enabled','interval_minutes','retention_days'].includes(key)), 'invalid connection sampling settings');
  check(typeof value.enabled === 'boolean' && Number.isInteger(value.interval_minutes) && value.interval_minutes >= 1 && value.interval_minutes <= 1440
    && Number.isInteger(value.retention_days) && value.retention_days >= 1 && value.retention_days <= 3650, 'invalid connection sampling settings');
  return { enabled: value.enabled, interval_minutes: value.interval_minutes, retention_days: value.retention_days };
}

/** Project-owned managed account cache; no model calls, no secrets in public views. */
export class AgentConnectionsService {
  constructor(project, options = {}) {
    this.project = project; this.store = project.store;
    this.scope = normalizeConfigurationScope(options.scope);
    this.options = options;
    this.scopedServices = options.scopedServices || new Map();
    this.scopedServices.set(this.scope, this);
    // Loading is lazy: ordinary Worker/status operations do not read credential files or initialize auth.
    this.manager = options.manager || null; this.managerOptions = options.managerOptions || {};
    this.now = options.now || Date.now;
    this.setTimer = options.setTimeout || setTimeout; this.clearTimer = options.clearTimeout || clearTimeout;
    this.flights = new Map(); this.pending = new Set(); this.bindings = new Map();
    this.catalogFlights = new Map();
    this.active = 0; this.waiters = []; this.limit = 3;
    this.timer = null; this.generation = 0; this.closed = false; this.warning = null;
    this.catalogTimer = null; this.catalogGeneration = 0; this.started = false;
    this.catalogIntervalMs = Number.isFinite(options.catalogIntervalMs) && options.catalogIntervalMs > 0
      ? options.catalogIntervalMs : 6 * 60 * 60 * 1000;
    this.catalogDeferMs = Number.isFinite(options.catalogDeferMs) && options.catalogDeferMs > 0
      ? options.catalogDeferMs : 20000;
  }
  forScope(scope = 'project') {
    this.assertOpen(); normalizeConfigurationScope(scope);
    if (!this.scopedServices.has(scope)) {
      const manager = this.getManager();
      check(typeof manager.forScope === 'function', 'scoped connection management is unavailable');
      new AgentConnectionsService(this.project, { ...this.options, scope, manager: manager.forScope(scope),
        scopedServices: this.scopedServices });
    }
    return this.scopedServices.get(scope);
  }
  isBusy() {
    return [...this.scopedServices.values()].some(service => service.pending.size || service.active || service.waiters.length
      || service.manager?.isBusy?.());
  }
  // Device management of a shadowed UUID must not invalidate this project's runtime/cache head.
  // Observation history continues to use the actual connection UUID, never this internal state key.
  stateId(id) {
    if (this.scope === 'device') {
      const manager = this.getManager();
      try { if (manager.forScope('project').storageScope(id) === 'project') return `device-${id}`; }
      catch { /* No local shadow. */ }
    }
    return id;
  }
  getManager() {
    if (!this.manager) {
      const { ConnectionManager } = require('../agent/connections.js');
      this.manager = new ConnectionManager(this.project.config, { ...this.managerOptions, scope: this.scope });
    }
    return this.manager;
  }
  config() {
    try {
      const config = this.getManager().config();
      check(config?.version === 1 && Array.isArray(config.connections) && config.connections.length <= 100, 'invalid connection configuration');
      const connections = config.connections.map(publicConnection);
      check(new Set(connections.map(connection => connection.id)).size === connections.length, 'duplicate connection identity');
      const result = { version: 1, sampling: sampling(config.sampling), connections };
      if (this.project.config.deviceHome) {
        const meta = config.configuration_scope;
        result.configuration_scope = configurationScope(this.project.config, this.scope,
          ['device', 'project', 'default', 'mixed'].includes(meta?.source) ? meta.source : 'default', meta?.project_override === true);
      }
      check(Buffer.byteLength(JSON.stringify(result)) <= 500000, 'connection configuration exceeds read budget');
      if (this.scope === 'project' && this.started && this.samplingKey !== JSON.stringify(result.sampling)) this.schedule(result.sampling);
      return result;
    } catch { if (this.scope === 'project') this.samplingKey = null; throw failure(); }
  }
  assertOpen() { check(!this.closed && !this.project.stopping, 'project is stopping'); }
  identity(id) {
    try {
      const value = this.getManager().identity(id);
      check(validConnectionHash(value?.account_key) && validConnectionHash(value?.source_key)
        && typeof value.revision === 'string' && value.revision.length > 0 && value.revision.length <= 256, 'invalid connection identity');
      return { account_key: value.account_key, source_key: value.source_key, revision: value.revision };
    } catch { throw failure(); }
  }
  snapshot(id, config = this.config()) {
    check(validConnectionId(id), 'invalid connection id');
    const connection = config.connections.find(item => item.id === id);
    check(connection, 'connection not found');
    const identity = this.identity(id);
    // Credential revision is intentionally not the persisted cache namespace:
    // ordinary OAuth refresh must not hide still-valid same-account observations.
    const state = this.store.ensureAgentConnectionState(this.stateId(id),hash([fingerprint(connection),identity.account_key,identity.source_key]));
    this.store.rememberAgentConnectionIdentity(state.connection_id,state.revision,identity.account_key,identity.source_key);
    return { connection, state: { ...state, account_key: identity.account_key, source_key: identity.source_key }, identity };
  }
  current(snapshot, allowRefresh = false) {
    try {
      const current = this.snapshot(snapshot.connection.id);
      return current.state.revision === snapshot.state.revision
        && ((allowRefresh && snapshot.connection.auth_type === 'oauth') || current.identity.revision === snapshot.identity.revision);
    } catch { return false; }
  }
  prune(policy = this.config().sampling) {
    // Device editing/querying does not shorten history governed by a legacy project override.
    if (this.scope === 'device') {
      try { policy = sampling(this.getManager().forScope('project').config().sampling); }
      catch { return; } // Cannot prove the owning project's retention policy: keep its history.
    }
    this.store.pruneAgentConnections(new Date(this.now() - policy.retention_days * 86400000).toISOString());
  }
  /** Read-only model catalog for one connection; local cache, no network, no model request. */
  models(id) {
    check(validConnectionId(id), 'invalid connection id');
    try {
      const manager = this.getManager();
      const value = typeof manager.catalog === 'function' ? manager.catalog(id) : null;
      return normalizeCatalog(value || this.unknownCatalog(id), id, this.now);
    } catch { throw failure(); }
  }
  unknownCatalog(id, warning = '尚未同步模型目录。') {
    return { version: 1, id, checked_at: new Date(this.now()).toISOString(), status: 'unknown',
      source: 'none', models: [], warning, error_code: null };
  }
  catalogList() {
    const config = this.config();
    const catalogs = []; let bytes = 0;
    for (const connection of config.connections) {
      const catalog = this.models(connection.id);
      const size = Buffer.byteLength(JSON.stringify(catalog));
      if (catalogs.length && bytes + size > 300000) break;
      bytes += size; catalogs.push(catalog);
    }
    return { version: 1, checked_at: new Date(this.now()).toISOString(), catalogs };
  }
  refreshCatalogOne(snapshot) {
    const id = snapshot.connection.id;
    const key = `${id}:${snapshot.state.revision}:${snapshot.identity.revision}`;
    if (this.catalogFlights.has(key)) return this.catalogFlights.get(key);
    const pending = this.project.write('refresh agent connection models', async () => {
      await this.acquire();
      try {
        if (!this.current(snapshot) || this.closed) return;
        try { await this.getManager().catalogRefresh(id); }
        catch { /* keep the last good catalog; failures never fabricate a listing */ }
      } finally { this.release(); }
    }).finally(() => { this.catalogFlights.delete(key); });
    this.catalogFlights.set(key, pending); this.track(pending);
    return pending;
  }
  modelsRefresh(id = null) {
    this.assertOpen();
    check(id === null || validConnectionId(id), 'invalid connection id');
    if (typeof this.getManager().catalogRefresh !== 'function') {
      return Promise.resolve(id === null ? this.catalogList() : this.models(id));
    }
    const config = this.config();
    const connections = id === null ? config.connections.filter(connection => connection.enabled)
      : [this.snapshot(id, config).connection];
    const operations = connections.filter(connection => connection.enabled)
      .map(connection => this.refreshCatalogOne(this.snapshot(connection.id, config)));
    if (!operations.length) return Promise.resolve(id === null ? this.catalogList() : this.models(id));
    return this.track(Promise.allSettled(operations).then(results => {
      this.assertOpen();
      if (results.some(result => result.status === 'rejected')) throw failure();
      return id === null ? this.catalogList() : this.models(id);
    }));
  }
  /**
   * A newly saved/logged-in connection is synced by a deferred background task,
   * never inside the save call itself: read paths and tests that never start the
   * service stay local-only, while a running daemon refreshes soon after an edit.
   */
  syncCatalog() {
    if (this.scope !== 'project') { this.scopedServices.get('project')?.syncCatalog(); return; }
    if (typeof this.getManager().catalogRefresh !== 'function' || !this.started || this.closed || this.project.stopping) return;
    this.scheduleCatalog(this.catalogDeferMs);
  }
  scheduleCatalog(delayMs = this.catalogIntervalMs) {
    this.catalogGeneration++;
    if (this.catalogTimer !== null) this.clearTimer(this.catalogTimer);
    this.catalogTimer = null;
    if (!this.started || this.closed || this.project.stopping) return;
    let config;
    try { config = this.config(); } catch { return; }
    if (typeof this.getManager().catalogRefresh !== 'function') return;
    if (!config.connections.some(connection => connection.enabled)) return;
    const generation = this.catalogGeneration;
    this.catalogTimer = this.setTimer(async () => {
      this.catalogTimer = null;
      try { await this.modelsRefresh(null); } catch { /* keep the last good catalog */ }
      finally {
        if (this.started && !this.closed && !this.project.stopping && this.catalogGeneration === generation) this.scheduleCatalog();
      }
    }, delayMs);
    this.catalogTimer?.unref?.();
  }
  list() {
    const config = this.config(), checked_at = new Date(this.now()).toISOString();
    let remainingBytes = 64000;
    const observationBudget = Math.max(1000, Math.floor((600000 - Buffer.byteLength(JSON.stringify(config)) - remainingBytes) / Math.max(1,config.connections.length)));
    const connections = config.connections.map(connection => {
      const { state } = this.snapshot(connection.id, config);
      const current = this.store.latestAgentConnectionObservation(connection.id,state.revision,state.account_key,state.source_key)
        || normalizeConnectionObservation({ status: 'unknown', checked_at, source: 'none', resources: [] });
      const { view: observation, truncated: observation_truncated } = boundedObservation(current,observationBudget);
      let last_success = null, last_success_truncated = false;
      if (!['available','partial'].includes(observation.status)) {
        const old = this.store.lastAgentConnectionSuccess(connection.id,state.account_key,state.source_key);
        if (old) {
          const bytes = Buffer.byteLength(JSON.stringify(old));
          if (bytes <= Math.min(16384, remainingBytes)) { last_success = old; remainingBytes -= bytes; }
          else last_success_truncated = true;
        }
      }
      const consumers = [...this.project.running.entries()].filter(([, run]) =>
        !run.parked && !run.controller?.signal?.aborted && run.connectionBinding?.id === connection.id
        && run.connectionBinding.account_key === state.account_key && run.connectionBinding.source_key === state.source_key)
        .slice(0, 100).map(([task_id, run]) => ({ task_id, model: safeText(run.agent.model) }));
      return { ...connection, observation, last_success, consumers, ...(observation_truncated ? { observation_truncated: true } : {}),
        ...(last_success_truncated ? { last_success_truncated: true } : {}) };
    });
    return { ...config, checked_at, connections, ...(this.warning ? { warning: this.warning } : {}) };
  }
  track(promise) {
    this.pending.add(promise);
    promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }
  operation(action, fn, projectError = failure) {
    this.assertOpen();
    return this.track(this.project.write(action, async () => {
      try { return await fn(); } catch (error) { throw projectError(error); }
    }));
  }
  save(connection, credential = null) {
    return this.operation('save agent connection', () => {
      const saved = publicConnection(this.getManager().save(connection,credential));
      const snapshot = this.snapshot(saved.id);
      this.store.ensureAgentConnectionState(snapshot.state.connection_id,snapshot.state.fingerprint,true);
      this.schedule(this.config().sampling);
      this.syncCatalog();
      return saved;
    });
  }
  remove(id) {
    check(validConnectionId(id), 'invalid connection id');
    return this.operation('remove agent connection', () => {
      const stateId = this.stateId(id);
      this.getManager().remove(id);
      this.store.forgetAgentConnectionState(stateId);
      for (const [key,binding] of this.bindings) if (binding.id === id) this.bindings.delete(key);
      for (const key of [...this.catalogFlights.keys()]) if (key.startsWith(`${id}:`)) this.catalogFlights.delete(key);
      this.schedule(this.config().sampling);
      return { removed: id };
    });
  }
  configureSampling(value) {
    const policy = sampling(value);
    return this.operation('configure connection sampling', () => {
      const saved = sampling(this.getManager().configureSampling(policy));
      this.prune(saved); this.schedule(saved);
      if (this.scope !== 'project') {
        const root = this.scopedServices.get('project');
        if (root) {
          try { const effective = root.config().sampling; if (!root.started) root.schedule(effective); }
          catch { root.warning = '项目连接配置无法安全读取，共享采样设置已保存。'; }
        }
      }
      return saved;
    });
  }
  async acquire() {
    if (this.active < this.limit) { this.active++; return; }
    await new Promise((resolve,reject) => this.waiters.push({ resolve, reject }));
  }
  release() {
    const next = this.waiters.shift();
    if (next) next.resolve(); else this.active--;
  }
  queryOne(snapshot) {
    const network = this.getManager().networkSnapshot?.() || networkSnapshot(this.project.config);
    const key = `${snapshot.connection.id}:${snapshot.state.revision}:${snapshot.identity.revision}:${network.key}`;
    if (this.flights.has(key)) return this.flights.get(key);
    const pending = this.project.write('query agent connection', async () => {
      await this.acquire();
      try {
        if (!this.current(snapshot) || this.closed) return;
        let result;
        try { result = await this.getManager().query(snapshot.connection.id, network); }
        catch (error) {
          const code = connectionErrorCode(error?.connectionCode || error?.usageCode || error?.error_code) || 'unknown';
          result = { id: snapshot.connection.id,
            account_key: snapshot.state.account_key || hash([snapshot.connection.id,'unknown-account']),
            source_key: snapshot.state.source_key || hash([snapshot.connection.provider,snapshot.connection.endpoint,'unknown-source']),
            observation: { status: 'error', checked_at: new Date(this.now()).toISOString(), source: 'none', error_code: code, resources: [] } };
        }
        if (!this.current(snapshot,true)) return;
        check(result?.id === snapshot.connection.id && validConnectionHash(result.account_key) && validConnectionHash(result.source_key), 'invalid connection query result');
        const currentIdentity = this.identity(result.id);
        if (result.account_key !== currentIdentity.account_key || result.source_key !== currentIdentity.source_key) return;
        const observation = normalizeConnectionObservation(result.observation,new Date(this.now()).toISOString());
        this.prune();
        this.store.rememberAgentConnectionIdentity(snapshot.state.connection_id,snapshot.state.revision,result.account_key,result.source_key);
        this.store.recordAgentConnectionObservation({ connection_id: result.id, revision: snapshot.state.revision,
          provider: snapshot.connection.provider, account_key: result.account_key, source_key: result.source_key,
          query_key: randomUUID(), observation });
      } finally { this.release(); }
    }).finally(() => { this.flights.delete(key); });
    this.flights.set(key,pending); this.track(pending);
    return pending;
  }
  query(id = null) {
    this.assertOpen();
    check(id === null || validConnectionId(id), 'invalid connection id');
    const config = this.config();
    const connections = id === null ? config.connections.filter(connection => connection.enabled)
      : [this.snapshot(id,config).connection];
    check(connections.every(connection => connection.enabled), 'connection is disabled');
    const operations = connections.map(connection => this.queryOne(this.snapshot(connection.id,config)));
    return this.track(Promise.allSettled(operations).then(results => {
      this.assertOpen();
      if (results.some(result => result.status === 'rejected')) throw failure();
      return this.list();
    }));
  }
  history(id, days = 7) {
    check(validConnectionId(id), 'invalid connection id');
    check([1,7,30,90].includes(days), 'connection history days must be 1, 7, 30 or 90');
    const policy = this.config().sampling;
    this.prune(policy);
    const now = this.now();
    return this.store.readAgentConnectionHistory({ id, from: new Date(now - Math.min(days,policy.retention_days) * 86400000).toISOString(),
      to: new Date(now).toISOString(), retention_days: policy.retention_days });
  }
  prepareRuntime(id) {
    const snapshot = this.snapshot(id);
    check(snapshot.connection.enabled, 'connection is disabled');
    return this.operation('prepare agent connection', async () => {
      const result = await this.getManager().prepareRuntime(id);
      check(this.current(snapshot,true), 'connection changed during runtime preparation');
      check(result?.connection?.id === id && validConnectionHash(result.account_key) && validConnectionHash(result.source_key), 'invalid connection runtime identity');
      const currentIdentity = this.identity(id);
      check(result.account_key === currentIdentity.account_key && result.source_key === currentIdentity.source_key, 'connection identity changed during runtime preparation');
      this.store.rememberAgentConnectionIdentity(snapshot.state.connection_id,snapshot.state.revision,result.account_key,result.source_key);
      this.bindings.set(identityKey(id,result.account_key,result.source_key), { id, provider: snapshot.connection.provider, revision: snapshot.state.revision });
      check(this.bindings.size <= 1000, 'too many prepared connection identities');
      return result; // INTERNAL ONLY: never registered with RPC or returned by a public view.
    });
  }
  observe(id, account_key, source_key, observation) {
    check(validConnectionId(id) && validConnectionHash(account_key) && validConnectionHash(source_key), 'invalid connection observation identity');
    const binding = this.bindings.get(identityKey(id,account_key,source_key));
    check(binding, 'connection observation has no frozen runtime binding');
    // Shutdown may already have cancelled proactive queries while an Agent is
    // delivering its final passive feedback. Track this trusted write as well.
    return this.track(this.project.write('observe agent connection', () => {
      const safe = normalizeConnectionObservation(observation,new Date(this.now()).toISOString());
      check(safe.source === 'response_headers', 'invalid passive connection observation source');
      this.prune(this.config().sampling);
      const current = this.snapshot(id);
      check(current.connection.enabled && current.state.revision === binding.revision
        && current.identity.account_key === account_key && current.identity.source_key === source_key,
      'connection identity changed since runtime preparation');
      const revision = binding.revision;
      this.store.rememberAgentConnectionIdentity(current.state.connection_id,revision,account_key,source_key);
      const recorded = this.store.recordAgentConnectionObservation({ connection_id: id, revision, provider: binding.provider,
        account_key, source_key, query_key: hash([id,account_key,source_key,safe]), observation: safe });
      return { recorded };
    }));
  }
  deviceStart(id) {
    check(validConnectionId(id), 'invalid connection id');
    return this.operation('start connection device login', async () => {
      const result = await this.getManager().deviceStart(id);
      check(result.id === id && validConnectionId(result.login_id)
        && result.verification_uri === 'https://auth.openai.com/codex/device'
        && typeof result.user_code === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(result.user_code), 'invalid device login response');
      const pending = this.devicePending(id, result.login_id, result);
      return { id, login_id: result.login_id, verification_uri: result.verification_uri, user_code: result.user_code,
        expires_at: pending.expires_at, interval_seconds: pending.interval_seconds };
    }, deviceFailure);
  }
  devicePending(id, login_id, result) {
    const expires = typeof result.expires_at === 'string' ? Date.parse(result.expires_at) : NaN;
    check(Number.isFinite(expires) && expires > this.now() && expires <= this.now() + 15 * 60000
      && Number.isFinite(result.interval_seconds) && result.interval_seconds >= 1 && result.interval_seconds <= 300, 'invalid device login timing');
    return { id, login_id, status: 'pending', interval_seconds: result.interval_seconds, expires_at: new Date(expires).toISOString() };
  }
  devicePoll(id, login_id) {
    check(validConnectionId(id) && validConnectionId(login_id), 'invalid device login');
    return this.operation('poll connection device login', async () => {
      const result = await this.getManager().devicePoll(id, login_id);
      check(result.id === id && result.login_id === login_id, 'invalid device login response');
      if (result.status === 'pending') return this.devicePending(id, login_id, result);
      check(result.status === 'complete', 'invalid device login status');
      const connection = publicConnection(result.connection);
      check(connection.id === id, 'invalid device login connection');
      // snapshot tracks the new account/config once; repeated completion reads
      // must not repeatedly rotate the persisted cache namespace.
      this.snapshot(id);
      this.syncCatalog();
      return { id, login_id, status: 'complete', connection };
    }, deviceFailure);
  }
  deviceCancel(id, login_id) {
    check(validConnectionId(id) && validConnectionId(login_id), 'invalid device login');
    return this.operation('cancel connection device login', async () => {
      await this.getManager().deviceCancel(id, login_id);
      return { id, login_id, status: 'cancelled' };
    }, deviceFailure);
  }
  loginStart(id) {
    check(validConnectionId(id), 'invalid connection id');
    return this.operation('start connection login', async () => {
      const result = await this.getManager().loginStart(id);
      // These are expected authorization URL/state values, not credentials. The
      // callback entered by the user never appears in a return value or event.
      const url = new URL(result.url), redirect = new URL(result.redirect_uri);
      check(result.id === id && validConnectionId(result.login_id) && url.protocol === 'https:' && url.origin === 'https://auth.openai.com'
        && !url.username && !url.password && redirect.origin === 'http://localhost:1455' && redirect.pathname === '/auth/callback', 'invalid login response');
      const expires_at = typeof result.expires_at === 'string' && Number.isFinite(Date.parse(result.expires_at)) ? new Date(result.expires_at).toISOString() : null;
      check(expires_at, 'invalid login expiry');
      return { id, login_id: result.login_id, url: url.href, expires_at, redirect_uri: redirect.href,
        instructions: '在浏览器完成授权后，将跳转到 localhost 的完整回调 URL 粘贴回来；远端环境无需本机回调服务。' };
    });
  }
  loginFinish(id, login_id, redirect_url) {
    check(validConnectionId(id) && validConnectionId(login_id) && typeof redirect_url === 'string' && redirect_url.length <= 10000, 'invalid connection login completion');
    return this.operation('complete connection login', async () => {
      const saved = publicConnection(await this.getManager().loginFinish(id,login_id,redirect_url));
      const snapshot = this.snapshot(saved.id);
      this.store.ensureAgentConnectionState(snapshot.state.connection_id,snapshot.state.fingerprint,true);
      this.syncCatalog();
      return saved;
    });
  }
  start() {
    if (this.scope !== 'project') return; // Scoped editors do not add duplicate background samplers.
    this.started = true;
    try { const config = this.config(); this.prune(config.sampling); this.scheduleCatalog(); }
    catch { this.warning = '连接配置无法安全读取，后台采样未启用。'; }
  }
  schedule(policy) {
    if (this.scope !== 'project') return;
    this.samplingKey = JSON.stringify(policy);
    this.generation++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (!policy.enabled || this.closed || this.project.stopping) return;
    const generation = this.generation;
    this.timer = this.setTimer(async () => {
      this.timer = null;
      try { await this.query(); this.warning = null; }
      catch { this.warning = '后台连接观测失败，没有取得新的可确认资源数据。'; }
      finally {
        if (!this.closed && !this.project.stopping && this.generation === generation) {
          try { this.schedule(this.config().sampling); }
          catch { this.warning = '连接配置无法安全读取，后台采样已停止。'; }
        }
      }
    },policy.interval_minutes * 60000);
    this.timer?.unref?.();
  }
  async stop() {
    await Promise.all([...this.scopedServices.values()].map(service => service._stopSelf()));
  }
  async _stopSelf() {
    this.closed = true; this.started = false; this.generation++; this.catalogGeneration++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.catalogTimer !== null) this.clearTimer(this.catalogTimer);
    this.catalogTimer = null;
    this.catalogFlights.clear();
    for (const waiter of this.waiters.splice(0)) waiter.reject(failure());
    // Do not initialize a credential manager just to close an unused project.
    if (this.manager) { try { await this.manager.stop(); } catch { /* no raw auth diagnostics */ } }
    await Promise.allSettled([...this.pending]);
  }
}
