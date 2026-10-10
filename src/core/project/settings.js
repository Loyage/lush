import { check } from '../types.js';
import { settingsConfigurationScope } from '../device-config.js';

const runtimeFacts = config => JSON.stringify([config.concurrency, config.controlConcurrency, config.timeout,
  config.maxCalls, config.maxDepth, config.progressReporting, config.inputRoutes]);

/** Device defaults are per-project admission limits, never a machine-wide scheduler. */
export default {
  refreshRuntimeConfiguration() {
    if (typeof this.config.refreshRuntimeSettings !== 'function') return true;
    const before = runtimeFacts(this.config), unavailable = this.runtimeSettingsUnavailable;
    try {
      this.config.refreshRuntimeSettings();
      this.runtimeSettingsUnavailable = false;
      if (unavailable || before !== runtimeFacts(this.config)) this.kick();
      return true;
    } catch {
      // Keep in-flight calls intact, but do not admit new calls using damaged shared configuration.
      this.runtimeSettingsUnavailable = true;
      return false;
    }
  },
  startRuntimeSettingsMonitor() {
    if (!this.config.deviceHome || this.runtimeSettingsMonitor) return;
    this.runtimeSettingsMonitor = setInterval(() => { if (!this.stopping) this.refreshRuntimeConfiguration(); }, 1000);
    this.runtimeSettingsMonitor.unref?.();
  },
  stopRuntimeSettingsMonitor() {
    if (this.runtimeSettingsMonitor) clearInterval(this.runtimeSettingsMonitor);
    this.runtimeSettingsMonitor = null;
  },
  runtimeSettings(scope) {
    scope = settingsConfigurationScope(this.config, scope);
    this.config.refreshRuntimeSettings?.();
    return this.config.runtimeSettings.get(scope);
  },
  configureRuntimeSettings(patch, scope) {
    scope = settingsConfigurationScope(this.config, scope);
    this.assertWritable('configure runtime settings');
    return this.config.configureRuntime(patch, scope);
  },
  async settingsMigrationPreview() {
    const { previewDeviceMigration } = await import('../device-migration.js');
    return previewDeviceMigration(this.config);
  },
  settingsMigrationApply(options) {
    check(this.running.size === 0 && this.introRunning.size === 0, '项目还有活动 Agent 或模型调用，请先结束或暂停后迁移');
    check(!this.writing && !this.clearing && !this.workspaces.pending && !this.workspaces.busy.size
      && !this.taskMergeBusy?.size && !this.mergeRunsDriving.size && !this.integratingIntents.size,
    '项目还有写入、Git 或合并操作，请稍后再迁移');
    check(!this.agentConnections.isBusy?.(), '模型来源还有登录或网络操作，请结束后再迁移');
    for (const manager of [this.agentPackageManager, this.deviceAgentPackageManager].filter(Boolean)) {
      check(!manager.isBusy?.() && !manager.activeMutation && !manager.pending.size && !manager.mutations.length,
        '项目还有资源安装或查询，请结束后再迁移');
    }
    check(!this.stopping, 'project is stopping');
    return this.write('migrate device settings', async () => {
      this.settingsMigrationApplying = true;
      try {
        const { migrateDeviceSettings } = await import('../device-migration.js');
        const result = await migrateDeviceSettings(this.config, options);
        this.config.refreshRuntimeSettings?.();
        return result;
      } finally { this.settingsMigrationApplying = false; this.kick(); }
    });
  },
  clearSettingsOverride(kind, target) {
    settingsConfigurationScope(this.config, 'project');
    check(!this.stopping, 'project is stopping');
    check(['agent', 'network', 'quick_explain', 'environment'].includes(kind), 'unknown configuration override kind');
    check(kind === 'environment' || target === undefined, 'only environment accepts a target');
    return this.write('clear project configuration override', async () => {
      if (kind === 'agent') { this.agentSettings.clearOverride(); return this.agentConfig(); }
      if (kind === 'quick_explain') { this.quickExplanationSettings.clearOverride(); return this.quickExplanationConfig(); }
      if (kind === 'network') {
        const { clearNetworkOverride } = await import('../../agent/network.js');
        clearNetworkOverride(this.config); return this.agentNetwork();
      }
      const { clearAgentEnvironmentOverride } = await import('../../agent/environment.js');
      clearAgentEnvironmentOverride(this.config, target); return this.agentEnvironment(target);
    });
  },
};
