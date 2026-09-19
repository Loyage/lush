/** system.* */
export const handlers = {
  'system.status'(p, params, actor) { return { ...p.status(), ...this.identity, pid: process.pid }; },
  'system.stop'(p, params, actor) { this.stopping.request(); return { stopping: true }; },
  'system.timeline'(p, params, actor) { return p.timeline({ limit: params.limit }); },
};
