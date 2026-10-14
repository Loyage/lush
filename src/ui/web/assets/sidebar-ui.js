import { SIDEBAR_SECTIONS } from './sidebar.js';
import { ui } from './state.js';
import { listSurface } from './list-surface.js';
import { isValet } from './work-type.js';

const RESOURCE_META = new Map(SIDEBAR_SECTIONS.map(section => [section.id, section]));
const PAGES = {
  projects: ['全局总览', '用户工作台', '项目与账户 · 你的卡片看板'],
  'project-management': ['项目管理', '用户工作台', '目录入口与后台维护'],
  'global-inbox': ['全局收件箱', '用户工作台', '所有有权访问项目的待答问题与告知'],
  automation: ['全局自动化', '用户工作台', '设备自动选择 · Worker 流程在项目内设置'],
  'workspace-link': ['独立用户工作台', '项目工作', '全局页面在独立标签打开'],
  unavailable: ['项目不可用', '工作台', '项目离线时仍可使用环境、设置与帮助'],
  overview: ['项目概览', '工作', '需求、执行进展与最新成果'],
  'task-graph': ['工作树', '工作', 'Worker 父子关系 · Agent、分支与 worktree'],
  'cli-interfaces': ['CLI 接口', '工作', '搜索与学习命令 · 就地选择未来新管家的默认权限'],
  hooks: ['项目自动化', '工作', '功能设置 · 新 Worker 默认与显示原则'],
  inputs: ['历史输入', '工作', '草稿与提交状态 · 全库原始指令检索'],
  statistics: ['用量统计', '交付与用量', 'Token 用量与预计花费 · 非实际账单'],
  settings: ['设备设置', '用户工作台', '设备唯一偏好、运行参数与网络'],
  'agent-status': ['Agent 配置', '用户工作台', '设备统一的执行后端、模型来源、Prompt 与工作方式'],
  'model-sources': ['模型来源', '用户工作台', '设备 API、账号登录、模型范围与余额额度'],
  docs: ['帮助文档', '其他', '使用流程、架构与接口参考'],
};
function node(id) { return globalThis.document?.getElementById?.(id) ?? null; }

export function setViewChrome(title, context = '项目', hint = '', { root = false } = {}) {
  const toolbar = node('view-toolbar'); if (toolbar) toolbar.hidden = ui.view?.id === 'projects';
  const titleNode = node('view-title'); if (titleNode) titleNode.textContent = title;
  const mobileTitle = node('mobile-view-title'); if (mobileTitle) mobileTitle.textContent = title;
  const contextNode = node('view-context'); if (contextNode) contextNode.textContent = context;
  const hintNode = node('view-hint'); if (hintNode) hintNode.textContent = hint;
  // Browser-tab identity is owned by project-identity.js, not the current panel.
  // Keep the project name visible when navigating to settings/docs/Worker views.
  const back = node('view-back');
  if (back) {
    back.disabled = Boolean(root);
    back.removeAttribute('title');
    back.removeAttribute('data-help');
  }
}

/** 页面身份是唯一导航状态；旧读标记在此统一投影，面板不得各自设置。 */
function activate(id, { key = id, title, context, hint, push = true, hash } = {}) {
  const changed = ui.view?.key !== key;
  if (changed) { ui.disposeValetSettings?.(); ui.disposeValetSettings = null; ui.disposeProjectAutomation?.(); ui.disposeProjectAutomation = null; ui.hooksPage?.shortcutNode?.dispose?.(); ui.disposePageModules?.(); ui.disposeTaskGraph?.(); ui.disposeServiceRestart?.(); ui.disposeServiceRestart = null; ui.disposeDetailRequests?.(); ui.clearSettingsSecrets?.(); ui.view = { id, key }; ui.composerTask = null; ui.composerAppendTarget = null; ui.composerError = null; }
  const resource = RESOURCE_META.get(id);
  ui.indexOpen = resource ? id : null;
  ui.docsOpen = id === 'docs';
  ui.settingsOpen = id === 'settings'; ui.statisticsOpen = id === 'statistics';
  if (id !== 'task') {
    ui.selected = null; ui.selectedRevision = null; ui.detailDirty = false; ui.detailTask = null;
  }
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
  if (resource) {
    const page = node(`side-${id}`), body = node(id);
    const card = page?.querySelector('.resource-card'), heading = card?.querySelector('.section-title');
    listSurface({ root: page, card, heading, body, tools: page?.querySelector('.resource-tools'), pagination: node('notice-pagination') });
  }
  const resources = node('resource-panels'); if (resources) { resources.hidden = !resource; if (changed) resources.scrollTop = 0; }
  for (const section of SIDEBAR_SECTIONS) {
    const page = node(`side-${section.id}`); if (page) page.hidden = section.id !== id;
  }
  const selectedWork = id === 'task' ? ui.lastSnapshot?.tasks?.find(task => task.id === ui.selected)
    || (ui.composerTask?.id === ui.selected ? ui.composerTask : null) : null;
  selectNav(id === 'task' ? (isValet(selectedWork) ? 'valets' : 'tasks') : id === 'notice' ? 'notices' : id);
  const meta = resource ? [resource.long, '工作', resource.description] : PAGES[id] || ['项目', '工作', ''];
  setViewChrome(title ?? meta[0], context ?? meta[1], hint ?? meta[2], { root: id === 'overview' || id === 'projects' });
  const route = id === 'tasks' ? 'workers' : id === 'task-graph' ? 'worker-graph' : id;
  const target = hash ?? (id === 'overview' ? '' : `#${route}`);
  if (push && globalThis.location?.hash !== target) {
    const base = `${globalThis.location?.pathname || '/'}${globalThis.location?.search || ''}`;
    globalThis.window?.history?.pushState?.(null, '', target || base);
  }
  toggleMobileNavigation(false);
  ui.syncComposer?.();
  return ui.view;
}

/** The mobile header stays outside the scrollable menu; opening it never changes the page. */
export function toggleMobileNavigation(force) {
  const sidebar = node('sidebar'), toggle = node('sidebar-toggle');
  if (!sidebar || !toggle) return false;
  const open = force ?? !sidebar.classList.contains('mobile-open');
  sidebar.classList.toggle('mobile-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = open ? '收起菜单' : '导航菜单';
  if (!open && node('navigation-menu')?.contains?.(globalThis.document?.activeElement)) toggle.focus();
  return open;
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
