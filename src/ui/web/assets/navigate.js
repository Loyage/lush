/**
 * 导航间接层：跳转与「动作完成后刷新」都走这里，谁都不直接 import detail.js / refresh.js，
 * 否则 api.js 会撞上 refresh.js ↔ api.js 的循环依赖。refresh.js 在模块求值时把实现注册进来。
 */
let navigation = { refresh: async () => {}, detail: async () => {}, overview: async () => {}, graph: async () => {} };

export function registerNavigation({ refresh, detail, overview, graph }) {
  const previous = navigation;
  const registered = { refresh, detail, overview, graph };
  navigation = registered;
  // DOM tests replace this singleton with controlled handlers. Return an identity-guarded teardown so
  // one file cannot leave its handlers installed for another file that already booted the application.
  return () => { if (navigation === registered) navigation = previous; };
}

export function refresh() { return navigation.refresh(); }
export function detail(taskId) { return navigation.detail(taskId); }
export function overview() { return navigation.overview(); }
export function graph() { return navigation.graph(); }
