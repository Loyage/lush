/** system.* */
export const handlers = {
  'system.status'(p, params, actor) { return { ...p.status(), ...this.identity, pid: process.pid }; },
  'system.stop'(p, params, actor) { this.stopping.request(); return { stopping: true }; },
  'system.timeline'(p, params, actor) { return p.timeline({ limit: params.limit }); },
  // 用户专属写操作：把运行设置（并发上限）的热更新暴露给 CLI / Web，agent 不得调用。
  'system.configure'(p, params, actor) { return p.configureRuntimeSettings(params.settings); },
  'agent.config'(p, params, actor) { return p.agentConfig(); },
  'agent.models'(p, params, actor) { return p.agentModels(params.agent); },
  'agent.resources'(p, params, actor) { return p.agentResources(); },
  'agent.configure'(p, params, actor) { return p.configureAgents(params.config); },
  // 只读分支图：用户与 agent 都能看，权限放在 PARAMS 里（不进 USER_ONLY / AGENT_ONLY）。
  'graph.get'(p, params, actor) { return p.graph(); },
};
