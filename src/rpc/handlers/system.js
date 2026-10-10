import { check } from '../../core/types.js';

const deviceUser = actor => check(actor === null, 'device settings requires user approval');

/** system.* */
export const handlers = {
  'sleep.start'(p, params) { return p.startSleep(params.options, params.confirmed); },
  'sleep.stop'(p) { return p.stopSleep(); },
  'sleep.resume'(p) { return p.resumeSleepDevelopment(); },
  'sleep.status'(p) { return p.sleepStatus(); },
  'sleep.choices'(p, params) { return p.sleepChoices(params.before, params.limit); },
  'system.usage'(p, params) { return p.usageStatistics(params); },
  'system.status'(p, params, actor) { return { ...p.status(actor === null), ...this.identity, pid: process.pid }; },
  // Polling summary has its own indexed/persistent-cursor path and never opens the full Agent profile.
  'system.summary'(p, params, actor) {
    check(params.development === undefined || typeof params.development === 'boolean', 'development must be boolean');
    const summary = { ...p.summary(), ...this.identity, pid: process.pid };
    if (params.development === true && actor === null) summary.development = p.developmentSummary();
    // Only the user polling surface gets this narrow authorization mirror;
    // Agent summaries still cannot read Hook configuration or receipts.
    if (actor === null) {
      const model = p.daemonHooks(), mount = model.mounts.find(item => item.id === 'auto-select');
      summary.auto_select = { enabled: mount.enabled, revision: model.revision, editable: mount.editable,
        scope: 'device', policy_revision: model.policy_revision ?? model.revision,
        available: !model.error, error: model.error ?? null };
    }
    return summary;
  },
  'system.interrupt_all'(p) { return p.interruptAll(); },
  'system.resume_all'(p) { return p.resumeAll(); },
  'system.stop'(p, params, actor) { this.stopping.request(); return { stopping: true }; },
  'system.stop_if_idle'(p) {
    // No await between checking activity and closing admission: pump/merge callbacks
    // cannot start a new invocation in the check → shutdown window.
    check(!p.stopping, '项目后台正在停止，请稍后再试');
    check(p.running.size === 0 && p.introRunning.size === 0,
      '项目还有活动 Agent 或模型调用，请先结束或暂停 Worker 后再重启');
    check(!p.writing && !p.clearing && !p.workspaces.pending && !p.workspaces.busy.size
      && !p.taskMergeBusy?.size && !p.mergeRunsDriving.size && !p.integratingIntents.size,
      '项目还有 Git、合并或后台操作正在执行，请稍后再重启');
    check(p.maintenanceView().ready_to_restart,
      '项目还有自动化、同步、资源回收或后台操作正在执行，请稍后再重启');
    p.stopping = true;
    this.stopping.request();
    return { stopping: true };
  },
  'system.timeline'(p, params, actor) { return p.timeline({ limit: params.limit }); },
  // 用户专属写操作：把运行设置（并发上限）的热更新暴露给 CLI / Web，agent 不得调用。
  'system.configure'(p, params, actor) {
    check(!Object.hasOwn(params.settings ?? {}, 'input_routes'), 'legacy input routes are no longer configurable');
    return p.configureRuntimeSettings(params.settings, params.scope);
  },
  'system.settings'(p, params) { return p.runtimeSettings(params.scope); },
  'settings.clear_override'(p, params) { return p.clearSettingsOverride(params.kind, params.target); },
  'settings.migration.preview'(p) { return p.settingsMigrationPreview(); },
  'settings.migration.apply'(p, params) { return p.settingsMigrationApply(params); },
  'agent.config'(p, params, actor) { deviceUser(actor); return p.agentConfig(params.scope); },
  'agent.models'(p, params, actor) { deviceUser(actor); return p.agentModels(params.agent, params.scope); },
  'agent.resources'(p, params, actor) { deviceUser(actor); return p.agentResources(params.scope); },
  'agent.status'(p) { return p.agentStatus(); },
  'agent.usage.config'(p) { return p.agentUsageConfig(); },
  'agent.usage.configure'(p, params) { return p.configureAgentUsage(params.config); },
  'agent.usage.history'(p, params) { return p.agentUsageHistory(params); },
  'agent.selection.resources'(p, params, actor) { deviceUser(actor); return p.agentSelectionResources(params.scope); },
  'agent.connections.list'(p, params) { return p.agentConnectionsList(params.scope); },
  'agent.connections.save'(p, params) { return p.saveAgentConnection(params.connection, params.credential, params.scope); },
  'agent.connections.remove'(p, params) { return p.removeAgentConnection(params.id, params.scope); },
  'agent.connections.sampling'(p, params) { return p.configureConnectionSampling(params.sampling, params.scope); },
  'agent.connections.query'(p, params) { return p.queryAgentConnections(params.id, params.scope); },
  'agent.connections.history'(p, params) { return p.agentConnectionHistory(params.id, params.days); },
  'agent.connections.device.start'(p, params) { return p.startConnectionDeviceLogin(params.id, params.scope); },
  'agent.connections.device.poll'(p, params) { return p.pollConnectionDeviceLogin(params.id, params.login_id, params.scope); },
  'agent.connections.device.cancel'(p, params) { return p.cancelConnectionDeviceLogin(params.id, params.login_id, params.scope); },
  'agent.connections.models'(p, params) { return p.agentConnectionModels(params.id, params.scope); },
  'agent.connections.models.refresh'(p, params) { return p.refreshAgentConnectionModels(params.id ?? null, params.scope); },
  // 资源安装由资源分区的新 mixin 实现；此处只固定用户专属 RPC 与安全投影边界。
  'agent.packages.list'(p, params) { return p.agentPackages(params.scope); },
  'agent.packages.install'(p, params) { return p.installAgentPackage(params.source, params.scope); },
  'agent.packages.remove'(p, params) { return p.removeAgentPackage(params.id, params.scope); },
  'agent.packages.update'(p, params) { return p.updateAgentPackage(params.id, params.scope); },
  'agent.connections.login.start'(p, params) { return p.startConnectionLogin(params.id, params.scope); },
  'agent.connections.login.finish'(p, params) { return p.finishConnectionLogin(params.id, params.login_id, params.redirect_url, params.scope); },
  // 环境变量值可能包含密钥：读取与写入都只允许本地用户/Web 登录会话，不向 agent token 开放。
  'agent.network'(p, params) { return p.agentNetwork(params.scope); },
  'agent.network.configure'(p, params) { return p.configureAgentNetwork(params.config, params.scope); },
  'agent.environment'(p, params, actor) { return p.agentEnvironment(params.target, params.scope); },
  'agent.environment.configure'(p, params, actor) { return p.configureAgentEnvironment(params.target, params.values, params.scope); },
  'agent.configure'(p, params, actor) { return p.configureAgents(params.config, params.scope); },
  // 只读分支图：用户与 agent 都能看，权限放在 PARAMS 里（不进 USER_ONLY / AGENT_ONLY）。
  'graph.get'(p, params, actor) { return p.graph(); },
};
