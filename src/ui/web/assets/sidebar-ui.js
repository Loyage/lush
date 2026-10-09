import { SIDEBAR_SECTIONS } from './sidebar.js';
import { ui } from './state.js';

const RESOURCE_META = new Map(SIDEBAR_SECTIONS.map(section => [section.id, section]));
const PAGES = {
  projects: ['项目管理', '工作台', '登记、打开与安全控制项目后台'],
  unavailable: ['项目不可用', '工作台', '项目离线时仍可使用环境、设置与帮助'],
  overview: ['项目概览', '工作', '需求、执行进展与最新成果'],
  'task-graph': ['Worker 树', '工作', 'Worker 父子关系 · Agent、分支与 worktree'],
  versions: ['版本迭代', '工作', 'main 主线历史 · 提交与 Worker / 指令追溯'],
  hooks: ['自动化', '工作', '时间信号 · 管理 Agent · 受控动作 · 模板'],
  inputs: ['历史输入', '工作', '暂存想法 · 全库原始输入检索与发射'],
  statistics: ['用量统计', '交付与用量', 'Token 用量与预计花费 · 非实际账单'],
  settings: ['系统设置', '其他', '界面偏好、运行参数与系统状态'],
  'agent-status': ['Agent 配置', '其他', '执行后端、模型来源、Prompt 与工作方式'],
  'model-sources': ['模型来源', '其他', '设备共享 API、账号登录、模型范围与余额额度'],
  'quick-explain': ['快捷解释', '其他', '选区解释 · 模型来源与 Prompt · 项目历史'],
  docs: ['帮助文档', '其他', '使用流程、架构与接口参考'],
};
function node(id) { return globalThis.document?.getElementById?.(id) ?? null; }

export function setViewChrome(title, context = '项目', hint = '', { root = false } = {}) {
  const titleNode = node('view-title'); if (titleNode) titleNode.textContent = title;
  const contextNode = node('view-context'); if (contextNode) contextNode.textContent = context;
  const hintNode = node('view-hint'); if (hintNode) hintNode.textContent = hint;
  // Browser-tab identity is owned by project-identity.js, not the current panel.
  // Keep the project name visible when navigating to settings/docs/Worker views.
  const back = node('view-back');
  if (back) {
    back.disabled = Boolean(root);
    back.removeAttribute('title');
    back.setAttribute('data-help', root ? '已经在项目概览' : '返回上一页面');
  }
}

/** 页面身份是唯一导航状态；旧读标记在此统一投影，面板不得各自设置。 */
function activate(id, { key = id, title, context, hint, push = true, hash } = {}) {
  const changed = ui.view?.key !== key;
  if (changed) { ui.disposeDetailRequests?.(); ui.clearSettingsSecrets?.(); ui.closeQuickExplanationPanel?.(); ui.view = { id, key }; ui.composerTask = null; ui.composerAppendTarget = null; ui.composerError = null; }
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
  const resources = node('resource-panels'); if (resources) { resources.hidden = !resource; if (changed) resources.scrollTop = 0; }
  for (const section of SIDEBAR_SECTIONS) {
    const page = node(`side-${section.id}`); if (page) page.hidden = section.id !== id;
  }
  selectNav(id === 'task' ? 'tasks' : id);
  const meta = resource ? [resource.long, '工作', resource.description] : PAGES[id] || ['项目', '工作', ''];
  setViewChrome(title ?? meta[0], context ?? meta[1], hint ?? meta[2], { root: id === 'overview' });
  const route = id === 'tasks' ? 'workers' : id === 'task-graph' ? 'worker-graph' : id;
  const target = hash ?? (id === 'overview' ? '' : `#${route}`);
  if (push && globalThis.location?.hash !== target) {
    const base = `${globalThis.location?.pathname || '/'}${globalThis.location?.search || ''}`;
    globalThis.window?.history?.pushState?.(null, '', target || base);
  }
  node('sidebar')?.classList?.remove('mobile-open');
  const toggle = node('sidebar-toggle');
  if (toggle) { toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = '导航菜单'; }
  ui.syncComposer?.();
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
