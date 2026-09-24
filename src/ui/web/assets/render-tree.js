import { $, badge, button, el, roleBadge, routeBadge, syncChildren } from './dom.js';
import { api } from './api.js';
import { DEP_HELP, HOT, INTEGRATION, ROLE, TERMINAL_STATUS, absolute, depsOf, relative, statusOf, waitingDeps } from './format.js';
import { filterUi, roleOption, syncSelectOptions, uniqueValues, withCurrent } from './filters-ui.js';
import { detail } from './navigate.js';
import { countText, describeFilters, filterTasks, isFiltering, matchTask } from './sidebar.js';
import { setNavCount } from './sidebar-ui.js';
import { ui } from './state.js';
import { orderSiblings, rankTasks, treeParent } from './tree-order.js';
import { referenceable } from './context-references.js';
import { renderCompactProgress } from './render-progress.js';

/** 同一个父任务下互相没有依赖的兄弟可以同时跑；有依赖的串成链——这就是树里看不到的并行/串行。 */
function siblingChain(children) {
  const ids = new Set(children.map(child => child.id));
  const inner = new Map(children.map(child => [child.id, depsOf(child).filter(dep => ids.has(dep.id))]));
  const level = new Map();
  const depth = (taskId, seen = new Set()) => {
    if (level.has(taskId)) return level.get(taskId);
    if (seen.has(taskId)) return 0;
    seen.add(taskId);
    const upstreams = inner.get(taskId) || [];
    const value = upstreams.length ? 1 + Math.max(...upstreams.map(dep => depth(dep.id, seen))) : 0;
    level.set(taskId, value); return value;
  };
  for (const child of children) depth(child.id);
  const levels = new Map();
  for (const child of children) { const at = level.get(child.id); if (!levels.has(at)) levels.set(at, []); levels.get(at).push(child.id); }
  return [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group.sort((a, b) => a - b));
}
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
  if (task.status === 'awaiting') return '等你决定：有没答复的问题';
  if (task.status === 'completed' && task.integration === 'conflict') return '已完成，合并冲突等你决定';
  if (task.status === 'completed' && ['pending', 'review'].includes(task.integration)) return '已完成，等你批准合并';
  return null;
}
export function renderTree(data) {
  const container = $('tasks');
  const flows = new Map((data.inputs || []).map(input => [input.id, input.flow]));
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
  // 筛选只影响呈现：可见集合 = 命中项 + 命中项的全部祖先（父作为通路保留），子任务被筛掉时父仍可见。
  const query = { ...ui.filters.tasks, openNoticeIds };
  const visible = filterTasks(data.tasks, query);
  const visibleIds = new Set(visible.map(task => task.id));
  const byParent = new Map();
  // 分组规则与 tree-order.js 的 rankTasks 共用同一个函数，保证排序看到的就是这棵树。
  for (const task of visible) {
    const key = treeParent(task, visibleIds);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(task);
  }
  // 角色选项随任务出现：轮询里只换 option 节点，不换 select，不打断正在选择的人。
  if (filterUi.taskRole) {
    const roles = [...new Set([...Object.keys(ROLE), ...uniqueValues(data.tasks, 'role')])];
    const options = [{ value: 'all', label: '全部类型' }, ...roles.map(roleOption)];
    syncSelectOptions(filterUi.taskRole, withCurrent(options, ui.filters.tasks.role, roleOption), ui.filters.tasks.role);
  }
  const ranks = rankTasks(visible, openNoticeIds);
  const index = { concurrency: data.status.concurrency ?? 1, children: taskId => fullByParent.get(taskId) || [] };
  const ordered = [];
  const walk = (parent, depth) => {
    // 每层兄弟先按当前偏好排好；band 行仍插在这层兄弟之前，节点复用 / dataset / 点击行为不变。
    const siblings = orderSiblings(byParent.get(parent) || [], { mode: ui.sidebarSortMode, ranks });
    // 根任务之间的并行由 planner 槽决定（不是一个父任务下的兄弟关系），所以只画委派出来的兄弟。
    if (parent !== 0 && siblings.length > 1) {
      const chain = siblingChain(siblings).map(group => group.length > 1 ? `{${group.map(taskId => `#${taskId}`).join(' ‖ ')}}` : `#${group[0]}`).join(' → ');
      const band = el('div', `‖ ${chain}（并列可同时跑，上限 ${index.concurrency}）`, `band d${Math.min(depth, 5)}`);
      band.title = '∥ 表示同一父任务下互相无依赖、可以同时跑；→ 的顺序来自依赖边：⛓ 基线还要求先合并上游，⏳ 顺序只等上游结束。';
      ordered.push(band);
    }
    for (const task of siblings) {
      const node = known.get(task.id) || button('', () => { ui.noticeFocus = null; return detail(task.id); }, 'task');
      const integration = INTEGRATION[task.integration];
      node.dataset.id = task.id;
      node.className = `task d${Math.min(depth, 5)} s-${task.status}${ui.selected === task.id ? ' selected' : ''}${task.route ? ' route-flagged' : ''}`;
      node.replaceChildren();
      const row = el('span', undefined, 'row');
      row.append(el('span', statusOf(task).icon, `dot c-${task.status}`), el('span', `#${task.id}`, 'tid'),
        el('span', statusOf(task).label), roleBadge(task.role));
      if (task.route) row.append(routeBadge());
      const flow = task.parent_id === null && !task.verifies_task_id && !task.resolves_task_id ? flows.get(task.input_id) : null;
      if (flow) row.append(badge(flow === 'explain' ? '了解' : '开发', flow === 'explain' ? 'b-neutral' : 'b-completed'));
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
      ordered.push(node); walk(task.id, depth + 1);
    }
  };
  walk(0, 0);
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
  const matched = isFiltering(query) ? data.tasks.filter(task => matchTask(task, query)).length : data.tasks.length;
  const paths = visible.length - matched;
  const summary = describeFilters(query);
  $('task-count').textContent = isFiltering(query)
    ? `${countText(matched, data.tasks.length)}${paths > 0 ? `（含 ${paths} 个父级）` : ''}${summary ? ` · ${summary}` : ''}`
    : `${data.tasks.length} 个 · ${active} 进行中`;
  setNavCount('tasks', page?.total ?? data.tasks.length);
}
