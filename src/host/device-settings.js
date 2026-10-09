import path from 'node:path';
import { launcherStateDir } from './registry.js';
import { check, isPlainObject } from '../core/types.js';
import { RuntimeSettings, RUNTIME_SETTINGS_LIMITS, RUNTIME_SETTINGS_KEYS } from '../core/settings.js';
import { configurationScope, validateConfigurationDirectory } from '../core/device-config.js';
import { AgentSettings } from '../agent/settings.js';
import { readAgentEnvironment, saveAgentEnvironment } from '../agent/environment.js';
import { readNetworkConfiguration, saveNetworkConfiguration } from '../agent/network.js';
import { QuickExplanationSettings, DEFAULT_EXPLANATION_PROMPT } from '../core/quick-explanation.js';
import { explanationReadiness } from '../core/quick-explanation-policy.js';
import { ConnectionManager } from '../agent/connections.js';
import { AgentPackages } from '../agent/packages.js';
import { discoverAgentModels } from '../agent/models.js';
import { discoverAgentResources } from '../agent/resources.js';
import { discoverSoftwareStatus } from '../agent/status-software.js';
import { normalizeConnectionObservation } from '../persistence/store/agent-connections.js';
import { assertAllowed } from '../rpc/registry.js';

/** No Project, SQLite, Worker, daemon startup, model calls or cross-project scheduling. */
export const DEVICE_SETTINGS_READS = new Map([
  ['runtime', ['system.settings', []]], ['agent/config', ['agent.config', []]],
  ['agent/models', ['agent.models', ['agent']]], ['agent/resources', ['agent.resources', []]],
  ['agent/status', ['agent.status', []]], ['agent/environment', ['agent.environment', ['target']]],
  ['agent/network', ['agent.network', []]], ['agent/connections', ['agent.connections.list', []]],
  ['agent/connections/models', ['agent.connections.models', ['id']]],
  ['agent/selection/resources', ['agent.selection.resources', []]],
  ['agent/packages', ['agent.packages.list', []]], ['quick-explain/config', ['quick_explain.config', []]],
]);
export const DEVICE_SETTINGS_ACTIONS = new Set([
  'system.configure', 'agent.configure', 'agent.environment.configure', 'agent.network.configure', 'quick_explain.configure',
  'agent.connections.save', 'agent.connections.remove', 'agent.connections.sampling', 'agent.connections.query',
  'agent.connections.models.refresh', 'agent.connections.login.start', 'agent.connections.login.finish',
  'agent.connections.device.start', 'agent.connections.device.poll', 'agent.connections.device.cancel',
  'agent.packages.install', 'agent.packages.remove', 'agent.packages.update',
]);
const READ_METHODS = new Set([...DEVICE_SETTINGS_READS.values()].map(([method]) => method));
const ERROR = '设备设置操作失败，请检查配置、私有文件权限或重试。';

function settingsConfig(env) {
  const home = path.join(launcherStateDir(env), 'shared');
  const config = { project: null, home, deviceHome: null, env: { ...env }, provider: env.LUSH_PROVIDER || 'pi' };
  check(['pi', 'codex', 'mock'].includes(config.provider), 'invalid execution backend');
  const defaults = {};
  for (const [key, spec] of Object.entries(RUNTIME_SETTINGS_LIMITS)) {
    const value = Number(env[spec.env] ?? spec.fallback);
    check(Number.isInteger(value) && value >= 1 && value <= spec.max, `${spec.env} is invalid`);
    defaults[key] = value;
  }
  Object.assign(config, { concurrencyDefault: defaults.concurrency, controlConcurrencyDefault: defaults.control_concurrency,
    timeoutDefault: defaults.call_timeout, maxCallsDefault: defaults.task_call_limit, maxDepthDefault: defaults.max_depth });
  return config;
}

export class DeviceSettingsService {
  constructor(env = process.env, options = {}) {
    this.config = settingsConfig(env);
    this.runtime = new RuntimeSettings(this.config);
    this.agents = new AgentSettings({ ...this.config, deviceHome: this.config.home });
    this.explanation = new QuickExplanationSettings(this.config);
    this.options = options;
    this.manager = null; this.packages = null; this.pending = new Set(); this.closed = false;
  }
  metadata(source = 'device') {
    return configurationScope({ deviceHome: this.config.home, project: null }, 'device', source);
  }
  view(value) {
    const source = value.configuration_scope?.source;
    return { ...value, configuration_scope: this.metadata(['default', 'mixed'].includes(source) ? source : 'device') };
  }
  runtimeView(value) {
    return this.view({ ...value, ...Object.fromEntries(RUNTIME_SETTINGS_KEYS.map(key =>
      [key, { ...value[key], source: value[key].overridden ? 'device' : 'default' }])) });
  }
  getManager() {
    if (!this.manager) this.manager = new ConnectionManager(this.config, this.options.connections ?? {});
    return this.manager;
  }
  getPackages() {
    if (!this.packages) this.packages = new AgentPackages(this.config, this.options.packages ?? {});
    return this.packages;
  }
  connectionList() {
    const manager = this.getManager(), config = manager.config(), checked_at = new Date().toISOString();
    return this.view({ ...config, checked_at, connections: config.connections.map(connection => {
      const current = manager.cachedObservation(connection.id);
      return { ...connection, storage_scope: 'device', consumers: [],
        observation: current?.observation || normalizeConnectionObservation({ status: 'unknown', checked_at, source: 'none', resources: [] }),
        last_success: current?.last_success || null };
    }), history_available: false, consumers_scope: 'none' });
  }
  async queryConnections(id = null) {
    const manager = this.getManager(), config = manager.config();
    const ids = id == null ? config.connections.filter(row => row.enabled).map(row => row.id) : [id];
    // Bounded sequential requests; the Host has no background sampling loop or persistent project history.
    for (const connectionId of ids) {
      const result = await manager.query(connectionId);
      check(!this.closed, 'device settings service is stopping');
      const identity = manager.identity(connectionId);
      if (identity.account_key !== result.account_key || identity.source_key !== result.source_key) continue;
      await manager.recordObservation(connectionId, result.account_key, result.source_key, result.observation);
    }
    return this.connectionList();
  }
  explanationConfig() {
    const profile = this.explanation.read();
    const connection = this.getManager().config().connections.find(row => row.id === profile.connection_id);
    const reason = explanationReadiness(connection, profile);
    return this.view({ version: 1, ...profile, default_prompt: DEFAULT_EXPLANATION_PROMPT, ready: reason === null, reason,
      configuration_scope: this.explanation.configurationScope?.() });
  }
  async perform(method, p) {
    validateConfigurationDirectory(this.config);
    switch (method) {
      case 'system.settings': return this.runtimeView(this.runtime.get());
      case 'system.configure':
        check(!Object.hasOwn(p.settings ?? {}, 'input_routes'), 'legacy input routes are no longer configurable');
        return this.runtimeView(this.runtime.save(p.settings));
      case 'agent.config': {
        this.config.progressReporting = this.runtime.get().progress_reporting.value;
        this.agents.config.progressReporting = this.config.progressReporting;
        return this.view(this.agents.get('device'));
      }
      case 'agent.configure': {
        this.agents.config.progressReporting = this.runtime.get().progress_reporting.value;
        return this.view(this.agents.save(p.config, 'device'));
      }
      case 'agent.models': return this.view(await discoverAgentModels(this.config, p.agent));
      case 'agent.resources': return this.view(await discoverAgentResources(this.config));
      case 'agent.status': return this.view(await discoverSoftwareStatus(this.config));
      case 'agent.environment': return this.view(readAgentEnvironment({ ...this.config, deviceHome: this.config.home }, p.target, 'device'));
      case 'agent.environment.configure': return this.view(saveAgentEnvironment({ ...this.config, deviceHome: this.config.home }, p.target, p.values, 'device'));
      case 'agent.network': return this.view(readNetworkConfiguration(this.config));
      case 'agent.network.configure': return this.view(saveNetworkConfiguration(this.config, p.config));
      case 'quick_explain.config': return this.explanationConfig();
      case 'quick_explain.configure': {
        const profile = this.explanation.preview(p.config);
        if (profile.connection_id) {
          const connection = this.getManager().config().connections.find(row => row.id === profile.connection_id);
          const reason = explanationReadiness(connection, profile, false);
          check(!reason, reason || '解释来源无效');
          if (profile.model && connection.models?.length) check(connection.models.includes(profile.model), '解释模型不在来源范围内');
        }
        this.explanation.save(profile); return this.explanationConfig();
      }
      case 'agent.connections.list': return this.connectionList();
      case 'agent.selection.resources': {
        const list = this.connectionList();
        return { ...list, connections: list.connections.map(row => ({ ...row, supported_agents: ['pi'], model_catalog: this.getManager().catalog(row.id) })) };
      }
      case 'agent.connections.save': return this.view({ ...this.getManager().save(p.connection, p.credential), storage_scope: 'device' });
      case 'agent.connections.remove': {
        return this.getManager().remove(p.id);
      }
      case 'agent.connections.sampling': return this.getManager().configureSampling(p.sampling);
      case 'agent.connections.query': return this.queryConnections(p.id);
      case 'agent.connections.models': return this.getManager().catalog(p.id);
      case 'agent.connections.models.refresh': {
        if (p.id != null) return this.getManager().catalogRefresh(p.id);
        const config = this.getManager().config(), catalogs = [];
        for (const row of config.connections.filter(row => row.enabled)) catalogs.push(await this.getManager().catalogRefresh(row.id));
        return { version: 1, catalogs };
      }
      case 'agent.connections.login.start': return this.getManager().loginStart(p.id);
      case 'agent.connections.login.finish': return this.getManager().loginFinish(p.id, p.login_id, p.redirect_url);
      case 'agent.connections.device.start': return this.getManager().deviceStart(p.id);
      case 'agent.connections.device.poll': return this.getManager().devicePoll(p.id, p.login_id);
      case 'agent.connections.device.cancel': return this.getManager().deviceCancel(p.id, p.login_id);
      case 'agent.packages.list': return this.view(await this.getPackages().list());
      case 'agent.packages.install': return this.view(await this.getPackages().install(p.source));
      case 'agent.packages.remove': return this.view(await this.getPackages().remove(p.id));
      case 'agent.packages.update': return this.view(await this.getPackages().update(p.id));
    }
    throw new Error('device settings method not allowed');
  }
  async request(method, params = {}) {
    check(!this.closed, 'device settings service is stopping');
    check(READ_METHODS.has(method) || DEVICE_SETTINGS_ACTIONS.has(method), 'device settings method not allowed');
    check(isPlainObject(params) && !Object.hasOwn(params, '_token'), 'agent tokens are not accepted by Host settings');
    check(params.scope === undefined || params.scope === 'device', 'Host settings only accept device scope');
    const p = { ...params, scope: 'device' };
    assertAllowed(method, p, null);
    const pending = this.perform(method, p); this.pending.add(pending);
    try { return await pending; }
    catch { throw new Error(ERROR); }
    finally { this.pending.delete(pending); }
  }
  async stop() {
    this.closed = true;
    await Promise.allSettled([this.manager?.stop(), this.packages?.stop()]);
    await Promise.allSettled([...this.pending]);
  }
}
