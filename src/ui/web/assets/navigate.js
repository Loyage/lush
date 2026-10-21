/**
 * 导航间接层：跳转与「动作完成后刷新」都走这里，谁都不直接 import detail.js / refresh.js，
 * 否则 api.js 会撞上 refresh.js ↔ api.js 的循环依赖。refresh.js 在模块求值时把实现注册进来。
 */
import { requestPageLeave } from './page-leave-guard.js';

let navigation = { refresh: async () => {}, detail: async () => {}, overview: async () => {}, resource: () => false };

export function registerNavigation({ refresh, detail, overview, resource }) {
  const previous = navigation;
  const registered = { refresh, detail, overview, resource: resource ?? previous.resource ?? (() => false) };
  navigation = registered;
  // DOM tests replace this singleton with controlled handlers. Return an identity-guarded teardown so
  // one file cannot leave its handlers installed for another file that already booted the application.
  return () => { if (navigation === registered) navigation = previous; };
}

export function refresh() { return navigation.refresh(); }
export function detail(taskId) { return requestPageLeave(`#worker-${taskId}`, { leave: () => navigation.detail(taskId) }); }
export function overview() { return requestPageLeave('', { leave: () => navigation.overview() }); }
export function resource(id) { return requestPageLeave(`#${id}`, { leave: () => navigation.resource(id) }); }
