import { SIDEBAR_SECTIONS, toggleCollapsed } from './sidebar.js';
import { batchDisclosure } from './view-controls.js';
import { $, el } from './dom.js';
import { filterInput, filterMulti, filterSelect, filterToggle, filterUi, plannerOption, roleOption, specStatusOption, statusOption, syncSelectOptions, withCurrent } from './filters-ui.js';
import { applyFilters } from './refresh.js';
import { openResource, paintCollapsed } from './sidebar-ui.js';
import { requestPageLeave } from './page-leave-guard.js';
import { ROLE } from './format.js';
import { saveCollapsedPref, ui } from './state.js';

// User navigation owns the leave guard; the shared page-activation layer must
// remain independent so lazy pages do not split the startup singleton closure.
export function navTo(id) {
  return requestPageLeave(`#${id === 'tasks' ? 'workers' : id}`, { leave: () => openResource(id) });
}

/* ---------- 左侧栏：快速导航、可折叠区块、三个列表的筛选 ---------- */
// 纯逻辑（筛选规则、摘要、折叠 / 筛选状态形态）都在 sidebar.js，这里只负责接到 DOM。
function makeNavItem(section) {
  const item = el('button', undefined, 'nav-item');
  item.type = 'button';
  item.dataset.side = section.id;
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
  const foldControl = batchDisclosure({ getItems: () => SIDEBAR_SECTIONS, isExpanded: section => !ui.collapsed.has(section.id),
    setExpanded: open => { ui.collapsed = new Set(open ? [] : SIDEBAR_SECTIONS.map(section => section.id)); paintCollapsed(true); saveCollapsedPref(); },
    scope: '作用于侧栏资源列表区块；保存当前项目折叠偏好，不切换页面或读取历史。' });
  folds.syncFold = foldControl.sync; folds.append(foldControl.root);
  nav.append(folds);
  for (const section of SIDEBAR_SECTIONS) {
    ui.sideHeads.get(section.id)?.addEventListener('click', () => {
      ui.collapsed = toggleCollapsed(ui.collapsed, section.id);
      paintCollapsed(true); saveCollapsedPref();
    });
  }
  // 行动任务：状态 / 角色 / 合并 / 只看待我处理 / 关键字
  const taskStatus = filterMulti('状态',
    ['queued', 'running', 'waiting', 'awaiting', 'awaiting_acceptance', 'paused', 'completed', 'failed', 'cancelled'].map(statusOption),
    ui.filters.tasks.status, value => { ui.filters.tasks.status = value; applyFilters(); });
  const taskRole = filterMulti('历史角色', Object.keys(ROLE).map(roleOption), ui.filters.tasks.role,
    value => { ui.filters.tasks.role = value; applyFilters(); });
  const taskIntegration = filterSelect('合并', [{ value: 'all', label: '全部' }, { value: 'unmerged', label: '待合并' }, { value: 'merged', label: '已合并' }],
    ui.filters.tasks.integration, value => { ui.filters.tasks.integration = value; applyFilters(); });
  const taskMine = filterToggle('只看待我处理', ui.filters.tasks.mine, value => { ui.filters.tasks.mine = value; applyFilters(); });
  const taskText = filterInput(ui.filters.tasks.text, value => { ui.filters.tasks.text = value; applyFilters(); },
    { label: '搜索工作目标或编号', scope: '范围：已读取的开发 Worker；不是全库。更早记录需加载历史。' });
  taskText.input.placeholder = '搜索目标、W 编号或 #内部ID';
  taskText.input.setAttribute('aria-label', '搜索工作目标或编号');
  const extras = el('div', undefined, 'task-filter-extras');
  extras.append(taskRole.wrap, taskIntegration.wrap, taskMine.wrap);
  $('task-filters').replaceChildren(taskText.wrap, taskStatus.wrap, extras);
  filterUi.taskStatus = taskStatus;
  filterUi.taskRole = taskRole;
  const valetStatus = filterMulti('状态',
    ['queued', 'running', 'waiting', 'awaiting', 'paused', 'completed', 'failed', 'cancelled'].map(statusOption),
    ui.filters.valets.status, value => { ui.filters.valets.status = value; applyFilters(); });
  const valetText = filterInput(ui.filters.valets.text, value => { ui.filters.valets.text = value; applyFilters(); },
    { label: '搜索管家指令或编号', scope: '范围：已读取的持久 Valet；不是全库或绑定快照。更早记录需加载历史。' });
  valetText.input.placeholder = '搜索指令、V 编号或 #内部ID';
  $('valet-filters')?.replaceChildren(valetText.wrap, valetStatus.wrap);
  filterUi.valetStatus = valetStatus;
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
