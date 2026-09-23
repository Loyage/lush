import { SIDEBAR_SECTIONS } from './sidebar.js';
import { ui } from './state.js';

const RESOURCE_META = new Map(SIDEBAR_SECTIONS.map(section => [section.id, section]));
const PAGES = {
  overview: ['项目概览', '工作', '需求、执行进展与最新成果'],
  graph: ['分支与合并', '交付与用量', '分支谱系、改动诊断与人工合并'],
  statistics: ['用量统计', '交付与用量', 'Token 用量与预计花费 · 非实际账单'],
  settings: ['设置', '其他', 'Agent、界面偏好与系统状态'],
  docs: ['帮助文档', '其他', '使用流程、架构与接口参考'],
};
function node(id) { return globalThis.document?.getElementById?.(id) ?? null; }

export function setViewChrome(title, context = '项目', hint = '', { root = false } = {}) {
  const titleNode = node('view-title'); if (titleNode) titleNode.textContent = title;
  const contextNode = node('view-context'); if (contextNode) contextNode.textContent = context;
  const hintNode = node('view-hint'); if (hintNode) hintNode.textContent = hint;
  if (globalThis.document) document.title = `Lush · ${title}`;
  const back = node('view-back');
  if (back) { back.disabled = Boolean(root); back.title = root ? '已经在项目概览' : '返回上一页面'; }
}

/** 页面身份是唯一导航状态；旧读标记在此统一投影，面板不得各自设置。 */
function activate(id, { key = id, title, context, hint, push = true, hash } = {}) {
  const changed = ui.view?.key !== key;
  if (changed) ui.view = { id, key };
  const resource = RESOURCE_META.get(id);
  ui.indexOpen = resource ? id : null;
  ui.graphOpen = id === 'graph'; ui.docsOpen = id === 'docs';
  ui.settingsOpen = id === 'settings'; ui.statisticsOpen = id === 'statistics';
  if (id !== 'task') {
    ui.selected = null; ui.selectedRevision = null; ui.detailDirty = false; ui.detailTask = null;
  }
  if (id !== 'graph') ui.graphRenderKey = null;
  const detail = node('detail');
  if (detail) {
    detail.hidden = Boolean(resource);
    if (changed) {
      detail.dataset.view = id;
      detail.scrollTop = 0;
      delete detail.dataset.taskId;
      // 切换立即反馈，不把上一页伪装成正在加载的新页面。
      if (!resource) detail.textContent = '正在加载…';
    }
  }
  const resources = node('resource-panels'); if (resources) { resources.hidden = !resource; if (changed) resources.scrollTop = 0; }
  for (const section of SIDEBAR_SECTIONS) {
    const page = node(`side-${section.id}`); if (page) page.hidden = section.id !== id;
  }
  selectNav(id === 'task' ? 'tasks' : id);
  const meta = resource ? [resource.long, '工作', resource.description] : PAGES[id] || ['项目', '工作', ''];
  setViewChrome(title ?? meta[0], context ?? meta[1], hint ?? meta[2], { root: id === 'overview' });
  const target = hash ?? (id === 'overview' ? '' : `#${id}`);
  if (push && globalThis.location?.hash !== target) {
    const base = `${globalThis.location?.pathname || '/'}${globalThis.location?.search || ''}`;
    globalThis.window?.history?.pushState?.(null, '', target || base);
  }
  node('sidebar')?.classList?.remove('mobile-open');
  const toggle = node('sidebar-toggle');
  if (toggle) { toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = '导航菜单'; }
  return ui.view;
}

/** 通用画布页面返回身份令牌；异步完成后先比较 ui.view。 */
export function activateDetailView({ view = 'overview', ...options } = {}) { return activate(view, options); }

export function openResource(id, { push = true } = {}) {
  if (!RESOURCE_META.has(id)) return false;
  activate(id, { push });
  if (id === 'notices') void ui.loadNoticeRecords?.();
  return true;
}

export function paintCollapsed() {
  for (const section of SIDEBAR_SECTIONS) {
    const collapsedNow = ui.collapsed.has(section.id);
    ui.sideNodes.get(section.id)?.classList.toggle('collapsed', collapsedNow);
    ui.sideHeads.get(section.id)?.setAttribute('aria-expanded', String(!collapsedNow));
  }
}
export function setNavCount(id, count) { const target = ui.navCounts.get(id); if (target) target.textContent = String(count); }
export function selectNav(id) {
  const buttons = new Map(ui.navButtons);
  for (const key of Object.keys(PAGES)) { const target = node(`${key}-open`); if (target) buttons.set(key, target); }
  for (const [key, target] of buttons) {
    target.classList.toggle('selected', key === id);
    target.setAttribute('aria-current', key === id ? 'page' : 'false');
  }
}
export function navTo(id) { return openResource(id); }
