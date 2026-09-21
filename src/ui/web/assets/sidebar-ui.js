import { SIDEBAR_SECTIONS } from './sidebar.js';
import { ui } from './state.js';

const RESOURCE_META = new Map(SIDEBAR_SECTIONS.map(section => [section.id, section]));

function node(id) { return globalThis.document?.getElementById?.(id) ?? null; }

/** 统一更新右侧视图栏。所有页面都经过这里，返回按钮的位置与语义始终不变。 */
export function setViewChrome(title, context = '项目', hint = '', { root = false } = {}) {
  const titleNode = node('view-title'); if (titleNode) titleNode.textContent = title;
  const contextNode = node('view-context'); if (contextNode) contextNode.textContent = context;
  const hintNode = node('view-hint'); if (hintNode) hintNode.textContent = hint;
  const back = node('view-back');
  if (back) {
    back.disabled = Boolean(root);
    back.title = root ? '已经在核心分支图' : '返回上一页面';
  }
}

/** 切回通用内容画布（分支图 / 概览 / 任务 / 文档）。 */
export function activateDetailView({ title = '项目', context = '工作空间', hint = '', root = false } = {}) {
  ui.indexOpen = null;
  const detail = node('detail'); if (detail) detail.hidden = false;
  const resources = node('resource-panels'); if (resources) resources.hidden = true;
  for (const section of SIDEBAR_SECTIONS) {
    const page = node(`side-${section.id}`); if (page) page.hidden = true;
  }
  selectNav(null);
  setViewChrome(title, context, hint, { root });
}

/** 打开一个右侧信息页。左栏只负责导航，不再承载任务或规划列表。 */
export function openResource(id, { push = true } = {}) {
  const meta = RESOURCE_META.get(id);
  if (!meta) return false;
  ui.indexOpen = id;
  ui.selected = null; ui.selectedRevision = null; ui.detailDirty = false; ui.detailTask = null;
  ui.graphOpen = false; ui.graphRenderKey = null; ui.docsOpen = false; ui.settingsOpen = false;
  const detail = node('detail'); if (detail) detail.hidden = true;
  const resources = node('resource-panels'); if (resources) resources.hidden = false;
  for (const section of SIDEBAR_SECTIONS) {
    const page = node(`side-${section.id}`); if (page) page.hidden = section.id !== id;
  }
  selectNav(id);
  setViewChrome(meta.long, '项目信息', meta.description);
  const hash = `#${id}`;
  if (push && globalThis.location?.hash !== hash) globalThis.window?.history?.pushState?.(null, '', hash);
  // 窄屏点完导航立即把抽屉收起，信息页获得完整宽度。
  const sidebar = node('sidebar'); sidebar?.classList?.remove('mobile-open');
  const toggle = node('sidebar-toggle');
  if (toggle) { toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = '导航菜单'; }
  return true;
}

/** 把折叠状态画到 DOM：区块加 .collapsed（CSS 隐藏内容并换箭头），标题按钮同步 aria-expanded。 */
export function paintCollapsed() {
  for (const section of SIDEBAR_SECTIONS) {
    const collapsedNow = ui.collapsed.has(section.id);
    ui.sideNodes.get(section.id)?.classList.toggle('collapsed', collapsedNow);
    ui.sideHeads.get(section.id)?.setAttribute('aria-expanded', String(!collapsedNow));
  }
}
export function setNavCount(id, count) { const target = ui.navCounts.get(id); if (target) target.textContent = String(count); }
export function selectNav(id) {
  for (const [key, target] of ui.navButtons) {
    target.classList.toggle('selected', key === id);
    target.setAttribute('aria-current', key === id ? 'page' : 'false');
  }
}
/** 左栏导航只切换右侧页面；列表、筛选与滚动全部留在内容区。 */
export function navTo(id) { return openResource(id); }
