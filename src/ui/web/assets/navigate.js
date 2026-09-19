/**
 * 导航间接层：跳转与「动作完成后刷新」都走这里，谁都不直接 import detail.js / refresh.js，
 * 否则 api.js 会撞上 refresh.js ↔ api.js 的循环依赖。refresh.js 在模块求值时把实现注册进来。
 */
let navigation = { refresh: async () => {}, detail: async () => {}, overview: async () => {} };

export function registerNavigation({ refresh, detail, overview }) {
  navigation = { refresh, detail, overview };
}

export function refresh() { return navigation.refresh(); }
export function detail(taskId) { return navigation.detail(taskId); }
export function overview() { return navigation.overview(); }
