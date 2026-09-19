import { SIDEBAR_SECTIONS } from './sidebar.js';
import { ui } from './state.js';

/** 把折叠状态画到 DOM：区块加 .collapsed（CSS 隐藏内容并换箭头），标题按钮同步 aria-expanded。 */
export function paintCollapsed() {
  for (const section of SIDEBAR_SECTIONS) {
    const collapsedNow = ui.collapsed.has(section.id);
    ui.sideNodes.get(section.id)?.classList.toggle('collapsed', collapsedNow);
    ui.sideHeads.get(section.id)?.setAttribute('aria-expanded', String(!collapsedNow));
  }
}
export function setNavCount(id, count) { const node = ui.navCounts.get(id); if (node) node.textContent = String(count); }
export function selectNav(id) {
  for (const [key, node] of ui.navButtons) {
    node.classList.toggle('selected', key === id);
    node.setAttribute('aria-current', key === id ? 'true' : 'false');
  }
}
/** 快速导航：能滚就滚并高亮；dom-stub / 老浏览器没有 scrollIntoView 时静默降级成只高亮。 */
export function navTo(id) {
  const section = ui.sideNodes.get(id);
  if (section && typeof section.scrollIntoView === 'function') {
    try { section.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch { /* 忽略 */ }
  }
  selectNav(id);
}
