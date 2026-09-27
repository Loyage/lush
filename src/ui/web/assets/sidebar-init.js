import { SIDEBAR_SECTIONS, toggleCollapsed } from './sidebar.js';
import { $, el } from './dom.js';
import { filterInput, filterSelect, filterToggle, filterUi, plannerOption, roleOption, specStatusOption, statusOption, syncSelectOptions, withCurrent } from './filters-ui.js';
import { applyFilters } from './refresh.js';
import { navTo, paintCollapsed } from './sidebar-ui.js';
import { ROLE } from './format.js';
import { saveCollapsedPref, ui } from './state.js';

/* ---------- 左侧栏：快速导航、可折叠区块、三个列表的筛选 ---------- */
// 纯逻辑（筛选规则、摘要、折叠 / 筛选状态形态）都在 sidebar.js，这里只负责接到 DOM。
function makeFoldButton(text, fn) {
  const node = el('button', text, 'nav-fold-btn');
  node.type = 'button';
  node.onclick = fn;
  return node;
}
function makeNavItem(section) {
  const item = el('button', undefined, 'nav-item');
  item.type = 'button';
  item.dataset.side = section.id;
  item.setAttribute('data-help', `在右侧打开「${section.long}」`);
  const copy = el('span', undefined, 'nav-copy');
  copy.append(el('strong', section.label, 'nav-label'), el('small', section.description, 'nav-description'));
  item.append(el('span', section.icon, 'nav-icon'), copy, el('span', '0', 'nav-count'), el('span', '→', 'nav-arrow'));
  item.onclick = () => navTo(section.id);
  return item;
}
export function initSidebar() {
  for (const section of SIDEBAR_SECTIONS) {
    ui.sideNodes.set(section.id, $(`side-${section.id}`));
    ui.sideHeads.set(section.id, $(`side-head-${section.id}`));
  }
  const nav = $('side-nav');
  nav.replaceChildren();
  for (const section of SIDEBAR_SECTIONS) {
    const item = makeNavItem(section);
    nav.append(item);
    ui.navButtons.set(section.id, item);
    ui.navCounts.set(section.id, item.querySelector('.nav-count'));
  }
  // 兼容已有的折叠偏好；控制项保持低调，主要导航仍然只负责打开右侧页面。
  const folds = el('span', undefined, 'nav-fold');
  folds.append(
    makeFoldButton('全部折叠', () => { ui.collapsed = new Set(SIDEBAR_SECTIONS.map(section => section.id)); paintCollapsed(); saveCollapsedPref(); }),
    makeFoldButton('全部展开', () => { ui.collapsed = new Set(); paintCollapsed(); saveCollapsedPref(); }));
  nav.append(folds);
  for (const section of SIDEBAR_SECTIONS) {
    ui.sideHeads.get(section.id)?.addEventListener('click', () => {
      ui.collapsed = toggleCollapsed(ui.collapsed, section.id);
      paintCollapsed(); saveCollapsedPref();
    });
  }
  // 行动 AP：状态 / 角色 / 合并 / 只看待我处理 / 关键字
  const apStatus = filterSelect('状态', [{ value: 'all', label: '全部状态' },
    ...['queued', 'running', 'waiting', 'awaiting', 'completed', 'failed', 'cancelled'].map(statusOption)],
    ui.filters.aps.status, value => { ui.filters.aps.status = value; applyFilters(); });
  const apRole = filterSelect('AP 类型', withCurrent([{ value: 'all', label: '全部类型' }, ...Object.keys(ROLE).map(roleOption)], ui.filters.aps.role, roleOption), ui.filters.aps.role,
    value => { ui.filters.aps.role = value; applyFilters(); });
  const apIntegration = filterSelect('合并', [{ value: 'all', label: '全部' }, { value: 'unmerged', label: '待合并' }, { value: 'merged', label: '已合并' }],
    ui.filters.aps.integration, value => { ui.filters.aps.integration = value; applyFilters(); });
  const apMine = filterToggle('只看待我处理', ui.filters.aps.mine, value => { ui.filters.aps.mine = value; applyFilters(); });
  const apText = filterInput(ui.filters.aps.text, value => { ui.filters.aps.text = value; applyFilters(); });
  $('ap-filters').replaceChildren(apStatus.wrap, apRole.wrap, apIntegration.wrap, apMine.wrap, apText.wrap);
  filterUi.apRole = apRole.select;
  // 规划 AP：状态 / planner / 角色 / 关键字
  const specStatus = filterSelect('状态', [{ value: 'all', label: '全部状态' }, specStatusOption('pending'), specStatusOption('planned'), specStatusOption('dropped')],
    ui.filters.specs.status, value => { ui.filters.specs.status = value; applyFilters(); });
  const specPlanner = filterSelect('planner', withCurrent([{ value: 'all', label: '全部 planner' }], ui.filters.specs.planner, plannerOption), ui.filters.specs.planner,
    value => { ui.filters.specs.planner = value; applyFilters(); });
  const specRole = filterSelect('角色', withCurrent([{ value: 'all', label: '全部角色' }], ui.filters.specs.role, roleOption), ui.filters.specs.role,
    value => { ui.filters.specs.role = value; applyFilters(); });
  const specText = filterInput(ui.filters.specs.text, value => { ui.filters.specs.text = value; applyFilters(); });
  $('spec-filters').replaceChildren(specStatus.wrap, specPlanner.wrap, specRole.wrap, specText.wrap);
  filterUi.specPlanner = specPlanner.select;
  filterUi.specRole = specRole.select;
  // 历史输入：闸门 / 状态 / 关键字
  const intentGate = filterSelect('闸门', [{ value: 'all', label: '全部' }, { value: 'proposed', label: '等你批准' }],
    ui.filters.intents.gate, value => { ui.filters.intents.gate = value; applyFilters(); });
  const intentStatus = filterSelect('状态', withCurrent([{ value: 'all', label: '全部状态' }], ui.filters.intents.status, statusOption), ui.filters.intents.status,
    value => { ui.filters.intents.status = value; applyFilters(); });
  const intentText = filterInput(ui.filters.intents.text, value => { ui.filters.intents.text = value; applyFilters(); });
  $('intent-filters').replaceChildren(intentGate.wrap, intentStatus.wrap, intentText.wrap);
  filterUi.intentStatus = intentStatus.select;
  paintCollapsed();
}
