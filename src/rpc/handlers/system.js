/** system.* */
export const handlers = {
  'system.status'(p, params, actor) { return { ...p.status(), ...this.identity, pid: process.pid }; },
  'system.stop'(p, params, actor) { this.stopping.request(); return { stopping: true }; },
  'system.timeline'(p, params, actor) { return p.timeline({ limit: params.limit }); },
  // 只读分支图：用户与 agent 都能看，权限放在 PARAMS 里（不进 USER_ONLY / AGENT_ONLY）。
  'graph.get'(p, params, actor) { return p.graph(); },
};
