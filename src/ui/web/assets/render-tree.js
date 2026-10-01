import { $, button, el, roleBadge, routeBadge, syncChildren } from './dom.js';
import { api } from './api.js';
import { DEP_HELP, HOT, INTEGRATION, ROLE, STATUS, TERMINAL_STATUS, absolute, depsOf, relative, statusOf, waitingDeps } from './format.js';
import { filterUi, roleOption, statusOption, uniqueValues } from './filters-ui.js';
import { detail } from './navigate.js';
import { countText, describeFilters, filterTasks, isFiltering } from './sidebar.js';
import { setNavCount } from './sidebar-ui.js';
import { ui } from './state.js';
import { orderTasks, treeParent } from './tree-order.js';
import { referenceable } from './context-references.js';
import { renderCompactProgress } from './render-progress.js';

/** 一行依赖标签：同名依赖合并成一个标签，词义放在 title 里，免得一行被标签挤爆。 */
function depChips(task) {
  const kinds = ['code', 'order'].filter(kind => depsOf(task).some(dep => dep.kind === kind));
  return kinds.map(kind => {
    const deps = depsOf(task).filter(dep => dep.kind === kind);
    const waiting = deps.some(dep => !TERMINAL_STATUS.has(dep.status));
    const chip = el('span', `${kind === 'code' ? '⛓' : '⏳'}#${deps.map(dep => dep.id).join(',')}${waiting ? '·等' : ''}`,
      `dep dep-${kind}${waiting ? ' dep-wait' : ''}`);
    chip.title = `${kind === 'code' ? 'code 依赖（分支基线）' : 'order 依赖（只等结束）'}：${DEP_HELP[kind]}\n上游：${deps.map(dep => `#${dep.id} ${statusOf(dep).label}`).join('、')}`;
    return chip;
  });
}
/** 此刻为什么没在干活：等依赖 / 等槽 / 等子任务 / 等你决定。四种拼起来才是完整的并行-串行关系。 */
function whyLine(task, index) {
  const waiting = waitingDeps(task);
  if (task.status === 'running') return `运行中 · 占 1 个并发槽`;
  if (task.status === 'queued' && waiting.length) return `排队：等 ${waiting.map(dep => `#${dep.id}`).join('、')} 结束`;
  if (task.status === 'queued') return `排队：没有依赖、但没有空槽（上限 ${index.concurrency}）`;
  if (task.status === 'waiting') {
    const kids = index.children(task.id);
    const live = kids.filter(child => child.status === 'running').length;
    return `等子任务：${live} 个在跑 · ${kids.filter(child => !TERMINAL_STATUS.has(child.status)).length} 个未结束`;
  }
  if (task.status === 'awaiting_acceptance') return '本轮已合并，待验收；可追加输入继续开发';
  if (task.status === 'awaiting') return '等你决定：有没答复的问题';
  if (task.status === 'paused') return '已暂停：可追加输入或调整运行设置，点「继续」恢复';
  if (task.status === 'completed' && task.integration === 'conflict') return '已完成，合并冲突等你决定';
  if (task.status === 'completed' && ['pending', 'review'].includes(task.integration)) return '已完成，等你批准合并';
  return null;
}
/** 兼容旧入口名称；任务列表以平铺方式渲染，关系视图由 render-task-graph.js 负责。 */
export function renderTree(data) {
  const container = $('tasks');
  const known = new Map([...container.children].map(node => [Number(node.dataset.id), node]));
  const allIds = new Set(data.tasks.map(task => task.id));
  // 完整父子索引：whyLine 说「等子任务」时要数全部子任务，不能因为筛选把它们藏掉。
  const fullByParent = new Map();
  for (const task of data.tasks) {
    const key = treeParent(task, allIds);
    if (!fullByParent.has(key)) fullByParent.set(key, []);
    fullByParent.get(key).push(task);
  }
  // 全类型任务列表包含 planner，计划审批同样属于待我处理。
  const openNoticeIds = new Set((data.notices || []).filter(notice => notice.status === 'open').map(notice => notice.task_id));
  // 平铺列表只保留命中项；父子索引仅用于等待原因，不参与展示或排序。
  const query = { ...ui.filters.tasks, openNoticeIds };
  const visible = filterTasks(data.tasks, query);
  const roles = [...new Set([...Object.keys(ROLE), ...uniqueValues(data.tasks, 'role')])];
  filterUi.taskRole?.sync(roles.map(roleOption), ui.filters.tasks.role);
  const statuses = [...new Set([...Object.keys(STATUS), ...uniqueValues(data.tasks, 'status')])];
  filterUi.taskStatus?.sync(statuses.map(statusOption), ui.filters.tasks.status);
  const index = { concurrency: data.status.concurrency ?? 1, children: taskId => fullByParent.get(taskId) || [] };
  const ordered = [];
  for (const task of orderTasks(visible, { mode: ui.sidebarSortMode, openNoticeIds })) {
    const node = known.get(task.id) || button('', () => { ui.noticeFocus = null; return detail(task.id); }, 'task');
    const integration = INTEGRATION[task.integration];
    node.dataset.id = task.id;
    node.className = `task s-${task.status}${ui.selected === task.id ? ' selected' : ''}${task.route ? ' route-flagged' : ''}`;
    node.replaceChildren();
    const row = el('span', undefined, 'row');
    row.append(el('span', statusOf(task).icon, `dot c-${task.status}`), el('span', `#${task.id}`, 'tid'),
      el('span', statusOf(task).label), ...(task.role === 'agent' ? [] : [roleBadge(task.role)]));
    if (task.route) row.append(routeBadge());
    for (const chip of depChips(task)) row.append(chip);
    row.append(el('span', relative(task.updated_at), 'when'));
    node.append(row, el('span', task.goal, 'goal'));
    if (HOT.has(task.status)) {
      const progress = renderCompactProgress(task.progress);
      if (progress) node.append(progress);
    }
    const why = whyLine(task, index);
    if (why) node.append(el('span', why, 'meta reason'));
    // 已经用一句话说了"等你批准合并"，就不用再挂一个"待合并"标签。
    if (integration && integration !== '待合并') node.append(el('span', integration, 'meta'));
    node.title = `${task.goal}\n更新于 ${absolute(task.updated_at)}`;
    referenceable(node, [
      { kind: 'task', target: { task_id: task.id }, label: `任务 #${task.id}`, quote: `${task.goal}\n状态：${statusOf(task).label} · ${ROLE[task.role] || task.role}`, location: { view: 'task-tree', task_id: task.id } },
      { kind: 'task_subtree', target: { task_id: task.id }, label: `任务子树 #${task.id}`, quote: `${task.goal}\n从此任务开始的分支`, location: { view: 'task-tree', task_id: task.id } },
    ]);
    ordered.push(node);
  }
  if (isFiltering(query) && !visible.length) ordered.push(el('div', data.task_page?.has_more
    ? '已加载任务中没有符合筛选的条目；更早记录尚未加载，请继续加载历史。'
    : '没有符合筛选的条目', 'filter-empty'));
  const page = data.task_page;
  if (page) {
    const paging = el('div', undefined, 'task-pagination');
    paging.append(el('span', page.truncated
      ? `当前显示全部 ${page.active} 个活动任务和最近 ${page.shown} / ${page.historical} 个历史任务（列表已截断）`
      : `已显示全部 ${page.total} 个任务`, 'hint'));
    if (page.has_more) {
      const more = button('加载更早 50 个', async () => {
        more.disabled = true; more.textContent = '加载中…';
        try {
          const next = await api(`/api/tasks?scope=all&before=${page.cursor}&limit=50`);
          const loaded = new Map([...ui.taskHistory, ...next.tasks].map(task => [task.id, task]));
          ui.taskHistory = [...loaded.values()];
          ui.taskHistoryPage = { ...page, cursor: next.cursor, has_more: next.has_more, truncated: next.has_more,
            shown: page.shown + next.tasks.length };
          const all = new Map([...data.tasks, ...next.tasks].map(task => [task.id, task]));
          data.tasks = [...all.values()].sort((a, b) => a.id - b.id);
          data.task_page = ui.taskHistoryPage;
          renderTree(data);
        } catch (error) { more.disabled = false; more.textContent = '加载更早 50 个'; more.title = error.message; }
      }, 'ghost');
      more.type = 'button'; paging.append(more);
    }
    ordered.push(paging);
  }
  syncChildren(container, ordered);
  const active = data.tasks.filter(task => HOT.has(task.status)).length;
  const matched = visible.length;
  const summary = describeFilters(query);
  $('task-count').textContent = isFiltering(query)
    ? `${countText(matched, data.tasks.length)}${summary ? ` · ${summary}` : ''}`
    : `${data.tasks.length} 个 · ${active} 进行中`;
  setNavCount('tasks', page?.total ?? data.tasks.length);
}
