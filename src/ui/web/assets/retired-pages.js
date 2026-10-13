// Retired bookmarks are read-only navigation, never hidden configuration migration.
import { $, button, el } from './dom.js';
import { api } from './api.js';
import { detail } from './navigate.js';
import { show } from './messages.js';
import { projectBase } from './route.js';
import { activateDetailView, openResource } from './sidebar-ui.js';
import { ui } from './state.js';

export function openRetiredManagement() {
  openResource('valets');
  show('Valet 设置入口已移除；管家列表仅展示持久管理记录和只读详情。已有配置与授权保留。');
}
export async function openRetiredTools() {
  const owner = globalThis.document, project = projectBase();
  const view = activateDetailView({ view: 'hooks', hash: '#hooks' });
  const module = await import('./render-project-automation.js');
  if (owner !== globalThis.document || project !== projectBase() || ui.view !== view || location.hash !== '#hooks') return;
  await module.openProjectAutomation();
  if (owner === globalThis.document && project === projectBase() && ui.view?.id === 'hooks')
    show('指令与 Hook 工具入口已移除；不再提供 Web 定义／模板编辑入口。已有自动化、配置与历史保留。');
}

/** The bounded overview includes persistent active main identity; never infer its integer ID. */
export async function openLegacyVersions() {
  const view = activateDetailView({ view: 'version-redirect', title: '版本入口已移至 Worker 详情', push: false, hash: '#versions' });
  const owner = globalThis.document, project = projectBase();
  const current = () => owner === globalThis.document && project === projectBase() && ui.view === view && location.hash === '#versions';
  const load = async () => {
    if (!current()) return;
    $('detail').textContent = '正在查找本项目的 main Worker…';
    try {
      const data = await api('/api/overview'); if (!current()) return;
      if (!Array.isArray(data.tasks)) throw new Error('main 身份读面未确认');
      const main = data.tasks.find(task => task.task_kind === 'main' && task.branch === 'main');
      if (!main || !Number.isSafeInteger(main.id) || main.id <= 0) {
        $('detail').replaceChildren(el('h1', '版本入口不可用'), el('p', '本项目没有可用的持久 main Worker，不能跳转版本详情。', 'hint'));
        return;
      }
      window.history.replaceState(null, '', `#worker-${main.id}`);
      await detail(main.id);
    } catch (error) {
      if (!current()) return;
      $('detail').replaceChildren(el('p', `main 身份读取失败：${error.message}；没有跳转到猜测的 Worker。`, 'error'), button('重新读取', load, 'ghost'));
    }
  };
  return load();
}
