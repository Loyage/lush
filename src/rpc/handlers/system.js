import { check } from '../../core/types.js';

/** system.* */
export const handlers = {
  'sleep.start'(p, params) { return p.startSleep(params.options, params.confirmed); },
  'sleep.stop'(p) { return p.stopSleep(); },
  'sleep.resume'(p) { return p.resumeSleepDevelopment(); },
  'sleep.status'(p) { return p.sleepStatus(); },
  'sleep.choices'(p, params) { return p.sleepChoices(params.before, params.limit); },
  'system.usage'(p, params) { return p.usageStatistics(params); },
  'system.status'(p, params, actor) { return { ...p.status(), ...this.identity, pid: process.pid }; },
  // Polling summary has its own indexed/persistent-cursor path and never opens the full Agent profile.
  'system.summary'(p, params, actor) { return { ...p.summary(), ...this.identity, pid: process.pid }; },
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
    p.stopping = true;
    this.stopping.request();
    return { stopping: true };
  },
  'system.timeline'(p, params, actor) { return p.timeline({ limit: params.limit }); },
  // 用户专属写操作：把运行设置（并发上限）的热更新暴露给 CLI / Web，agent 不得调用。
  'system.configure'(p, params, actor) {
    check(!Object.hasOwn(params.settings ?? {}, 'input_routes'), 'legacy input routes are no longer configurable');
    return p.configureRuntimeSettings(params.settings);
  },
  'agent.config'(p, params, actor) { return p.agentConfig(); },
  'agent.models'(p, params, actor) { return p.agentModels(params.agent); },
  'agent.resources'(p, params, actor) { return p.agentResources(); },
  'agent.status'(p) { return p.agentStatus(); },
  'agent.usage.config'(p) { return p.agentUsageConfig(); },
  'agent.usage.configure'(p, params) { return p.configureAgentUsage(params.config); },
  'agent.usage.history'(p, params) { return p.agentUsageHistory(params); },
  'agent.connections.list'(p) { return p.agentConnectionsList(); },
  'agent.connections.save'(p, params) { return p.saveAgentConnection(params.connection, params.credential); },
  'agent.connections.remove'(p, params) { return p.removeAgentConnection(params.id); },
  'agent.connections.sampling'(p, params) { return p.configureConnectionSampling(params.sampling); },
  'agent.connections.query'(p, params) { return p.queryAgentConnections(params.id); },
  'agent.connections.history'(p, params) { return p.agentConnectionHistory(params.id, params.days); },
  'agent.connections.device.start'(p, params) { return p.startConnectionDeviceLogin(params.id); },
  'agent.connections.device.poll'(p, params) { return p.pollConnectionDeviceLogin(params.id, params.login_id); },
  'agent.connections.device.cancel'(p, params) { return p.cancelConnectionDeviceLogin(params.id, params.login_id); },
  'agent.connections.login.start'(p, params) { return p.startConnectionLogin(params.id); },
  'agent.connections.login.finish'(p, params) { return p.finishConnectionLogin(params.id, params.login_id, params.redirect_url); },
  // 环境变量值可能包含密钥：读取与写入都只允许本地用户/Web 登录会话，不向 agent token 开放。
  'agent.environment'(p, params, actor) { return p.agentEnvironment(params.target); },
  'agent.environment.configure'(p, params, actor) { return p.configureAgentEnvironment(params.target, params.values); },
  'agent.configure'(p, params, actor) { return p.configureAgents(params.config); },
  // 只读分支图：用户与 agent 都能看，权限放在 PARAMS 里（不进 USER_ONLY / AGENT_ONLY）。
  'graph.get'(p, params, actor) { return p.graph(); },
};
