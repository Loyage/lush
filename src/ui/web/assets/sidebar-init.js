import { SIDEBAR_SECTIONS, toggleCollapsed } from './sidebar.js';
import { $, el } from './dom.js';
import { filterInput, filterSelect, filterToggle, filterUi, plannerOption, roleOption, specStatusOption, statusOption, syncSelectOptions, withCurrent } from './filters-ui.js';
import { applyFilters } from './refresh.js';
import { navTo, paintCollapsed } from './sidebar-ui.js';
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
  item.title = `在右侧打开「${section.long}」`;
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
  // 行动任务：状态 / 角色 / 合并 / 只看待我处理 / 关键字
  const taskStatus = filterSelect('状态', [{ value: 'all', label: '全部状态' },
    ...['queued', 'running', 'waiting', 'awaiting', 'completed', 'failed', 'cancelled'].map(statusOption)],
    ui.filters.tasks.status, value => { ui.filters.tasks.status = value; applyFilters(); });
  const taskRole = filterSelect('角色', withCurrent([{ value: 'all', label: '全部角色' }], ui.filters.tasks.role, roleOption), ui.filters.tasks.role,
    value => { ui.filters.tasks.role = value; applyFilters(); });
  const taskIntegration = filterSelect('合并', [{ value: 'all', label: '全部' }, { value: 'unmerged', label: '待合并' }, { value: 'merged', label: '已合并' }],
    ui.filters.tasks.integration, value => { ui.filters.tasks.integration = value; applyFilters(); });
  const taskMine = filterToggle('只看待我处理', ui.filters.tasks.mine, value => { ui.filters.tasks.mine = value; applyFilters(); });
  const taskText = filterInput(ui.filters.tasks.text, value => { ui.filters.tasks.text = value; applyFilters(); });
  $('task-filters').replaceChildren(taskStatus.wrap, taskRole.wrap, taskIntegration.wrap, taskMine.wrap, taskText.wrap);
  filterUi.taskRole = taskRole.select;
  // 规划任务：状态 / planner / 角色 / 关键字
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
  // 历史输入：流程 / 闸门 / 状态 / 关键字
  const intentFlow = filterSelect('流程', [{ value: 'all', label: '全部' }, { value: 'develop', label: '开发' }, { value: 'explain', label: '了解' }],
    ui.filters.intents.flow, value => { ui.filters.intents.flow = value; applyFilters(); });
  const intentGate = filterSelect('闸门', [{ value: 'all', label: '全部' }, { value: 'proposed', label: '等你批准' }],
    ui.filters.intents.gate, value => { ui.filters.intents.gate = value; applyFilters(); });
  const intentStatus = filterSelect('状态', withCurrent([{ value: 'all', label: '全部状态' }], ui.filters.intents.status, statusOption), ui.filters.intents.status,
    value => { ui.filters.intents.status = value; applyFilters(); });
  const intentText = filterInput(ui.filters.intents.text, value => { ui.filters.intents.text = value; applyFilters(); });
  $('intent-filters').replaceChildren(intentFlow.wrap, intentGate.wrap, intentStatus.wrap, intentText.wrap);
  filterUi.intentStatus = intentStatus.select;
  paintCollapsed();
}
