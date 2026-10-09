import { $, button, el, roleBadge, routeBadge, syncChildren } from './dom.js';
import { api } from './api.js';
import { projectBase } from './route.js';
import { DEP_HELP, HOT, INTEGRATION, ROLE, STATUS, TERMINAL_STATUS, absolute, depsOf, relative, statusOf, interruptReason, waitingDeps } from './format.js';
import { filterUi, roleOption, statusOption, uniqueValues } from './filters-ui.js';
import { detail } from './navigate.js';
import { countText, describeFilters, filterTasks, isFiltering } from './sidebar.js';
import { setNavCount } from './sidebar-ui.js';
import { ui } from './state.js';
import { orderTasks, treeParent } from './tree-order.js';
import { referenceable } from './context-references.js';
import { progressReportingEnabled, progressStats, refreshProgressDurations, renderCompactProgress } from './render-progress.js';
import { workerLabel, rememberWorkers } from './worker-label.js';

// DOM-owned state is discarded with the node on boot/project changes. Signatures describe
// rendered dependencies, not updated_at (child status/progress/config can change independently).
const rowState = new WeakMap();
const listState = new WeakMap();
function patchText(node, text) { if (node.textContent !== text) node.textContent = text; }
const inside = (root, node) => {
  for (let at = node; at; at = at.parentNode) if (at === root) return true;
  return false;
};
function readingState(container) {
  const focused = document.activeElement;
  const selection = globalThis.window?.getSelection?.();
  const selected = selection && inside(container, selection.anchorNode) && inside(container, selection.focusNode)
    ? { anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset, focusNode: selection.focusNode, focusOffset: selection.focusOffset } : null;
  return () => {
    // insertBefore can drop keyboard focus/selection on a moved row. Restore only surviving
    // reading nodes; if their actual content changed, do not select an unrelated replacement.
    if (focused && inside(container, focused) && document.activeElement !== focused) focused.focus?.({ preventScroll: true });
    if (selected && inside(container, selected.anchorNode) && inside(container, selected.focusNode)
      && (selection.anchorNode !== selected.anchorNode || selection.anchorOffset !== selected.anchorOffset
        || selection.focusNode !== selected.focusNode || selection.focusOffset !== selected.focusOffset)) {
      selection.setBaseAndExtent?.(selected.anchorNode, selected.anchorOffset, selected.focusNode, selected.focusOffset);
    }
  };
}

/** Relative clocks are independent of overview revision and never replace reading nodes. */
export function refreshTreeTimes(container = $('tasks')) {
  if (!container) return;
  for (const node of container.children) {
    const state = rowState.get(node);
    if (state) patchText(state.when, relative(state.updatedAt));
  }
  refreshProgressDurations(container);
}

/** 一行依赖标签：同名依赖合并成一个标签，词义放在 title 里，免得一行被标签挤爆。 */
function depChips(task) {
  const kinds = ['code', 'order'].filter(kind => depsOf(task).some(dep => dep.kind === kind));
  return kinds.map(kind => {
    const deps = depsOf(task).filter(dep => dep.kind === kind);
    const waiting = deps.some(dep => !TERMINAL_STATUS.has(dep.status));
    const chip = el('span', `${kind === 'code' ? '⛓' : '⏳'}${deps.map(dep => workerLabel(dep)).join(',')}${waiting ? '·等' : ''}`,
      `dep dep-${kind}${waiting ? ' dep-wait' : ''}`);
    chip.title = `${kind === 'code' ? 'code 依赖（分支基线）' : 'order 依赖（只等结束）'}：${DEP_HELP[kind]}\n上游：${deps.map(dep => `${workerLabel(dep)} ${statusOf(dep).label}`).join('、')}`;
    return chip;
  });
}
/** 此刻为什么没在干活：等依赖 / 等槽 / 等子任务 / 等你决定。四种拼起来才是完整的并行-串行关系。 */
function whyLine(task, index) {
  const interruptHint = interruptReason(task);
  if (interruptHint) return interruptHint;
  const waiting = waitingDeps(task);
  if (task.status === 'running') return `运行中 · 占 1 个并发槽`;
  if (task.status === 'queued' && waiting.length) return `排队：等 ${waiting.map(dep => workerLabel(dep)).join('、')} 结束`;
  if (task.status === 'queued') return `排队：没有依赖、但没有空槽（上限 ${index.concurrency}）`;
  if (task.status === 'waiting') {
    const kids = index.children(task.id);
    const live = kids.filter(child => child.status === 'running').length;
    return `等子 Worker：${live} 个在跑 · ${kids.filter(child => !TERMINAL_STATUS.has(child.status)).length} 个未结束`;
  }
  if (task.status === 'awaiting_acceptance') return task.task_kind === 'child'
    ? `本轮已交付，等待父 Worker ${workerLabel(task.parent_id, task.parent_worker_number)} 确认；无需你验收` : '本轮已交付，待验收；可追加输入继续开发';
  if (task.status === 'awaiting') return '等你决定：有没答复的问题';
  if (task.status === 'paused') return '已暂停：可追加输入或调整运行设置，点「继续」恢复';
  if (task.status === 'completed' && task.integration === 'conflict') return '已完成，合并冲突等你决定';
  if (task.status === 'completed' && ['pending', 'review'].includes(task.integration)) return '已完成，等你批准合并';
  return null;
}
/** 兼容旧入口名称；任务列表以平铺方式渲染，关系视图由 render-task-graph.js 负责。 */
export function renderTree(data) {
  rememberWorkers(data.tasks);
  const container = $('tasks');
  const restoreReading = readingState(container);
  const known = new Map([...container.children].map(node => [Number(node.dataset.id), node]));
  let list = listState.get(container);
  const project = projectBase();
  // resetUiState supplies a fresh deletion set on boot; do not reuse an old project's paging lock.
  if (!list || list.scope !== ui.deletedWorkerIds || list.project !== project) {
    list = { scope: ui.deletedWorkerIds, project }; listState.set(container, list);
  }
  list.data = data;
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
    if (Number(node.dataset.id) !== task.id) node.dataset.id = task.id;
    const className = `task s-${task.status}${ui.selected === task.id ? ' selected' : ''}${task.route ? ' route-flagged' : ''}`;
    if (node.className !== className) node.className = className;
    let state = rowState.get(node);
    if (!state) {
      state = { row: el('span', undefined, 'row'), when: el('span', '', 'when'), goal: el('span', '', 'goal'),
        dot: el('span', '', 'dot'), tid: el('span', '', 'tid'), status: el('span', ''),
        reason: el('span', '', 'meta reason'), integration: el('span', '', 'meta') };
      rowState.set(node, state);
    }
    const status = statusOf(task);
    const label = workerLabel(task);
    // Dependency labels also depend on the project number cache, not just task.deps.
    const depsKey = JSON.stringify(depsOf(task).filter(dep => ['code', 'order'].includes(dep.kind))
      .map(dep => [dep.kind, workerLabel(dep), dep.status, statusOf(dep)]));
    const rowKey = JSON.stringify([task.status, status, label, task.role, Boolean(task.route), depsKey]);
    if (state.rowKey !== rowKey) {
      state.rowKey = rowKey;
      patchText(state.dot, status.icon); patchText(state.tid, label); patchText(state.status, status.label);
      const dotClass = `dot c-${task.status}`;
      if (state.dot.className !== dotClass) state.dot.className = dotClass;
      if (!Object.hasOwn(state, 'role') || state.role !== task.role) {
        state.role = task.role; state.roleBadge = task.role === 'agent' ? null : roleBadge(task.role);
      }
      if (task.route && !state.routeBadge) state.routeBadge = routeBadge();
      if (state.depsKey !== depsKey) { state.depsKey = depsKey; state.deps = depChips(task); }
      syncChildren(state.row, [state.dot, state.tid, state.status, ...(state.roleBadge ? [state.roleBadge] : []),
        ...(task.route ? [state.routeBadge] : []), ...state.deps, state.when]);
    }
    state.updatedAt = task.updated_at;
    patchText(state.when, relative(task.updated_at));
    patchText(state.goal, task.display_title || task.goal);
    const stats = progressStats(task.progress), current = stats.current;
    const progressKey = JSON.stringify([HOT.has(task.status), progressReportingEnabled(), stats.completed, stats.total,
      current && [current.label, current.kind, current.timing_unknown, current.work_ms, current.active_since,
        current.started_at, current.wait_ms, current.waiting_since]]);
    if (state.progressKey !== progressKey) {
      state.progressKey = progressKey;
      state.progress = HOT.has(task.status) ? renderCompactProgress(task.progress) : null;
    }
    const why = whyLine(task, index);
    if (why) patchText(state.reason, why);
    // 已经用一句话说了"等你批准合并"，就不用再挂一个"待合并"标签。
    const integrationText = integration && integration !== '待合并' ? integration : null;
    if (integrationText) patchText(state.integration, integrationText);
    syncChildren(node, [state.row, state.goal, ...(state.progress ? [state.progress] : []),
      ...(why ? [state.reason] : []), ...(integrationText ? [state.integration] : [])]);
    const title = `${task.goal}\n更新于 ${absolute(task.updated_at)}`;
    if (node.title !== title) node.title = title;
    const referenceKey = JSON.stringify([task.id, label, task.goal, status.label, task.role]);
    if (state.referenceKey !== referenceKey) {
      state.referenceKey = referenceKey;
      referenceable(node, [
        { kind: 'task', target: { task_id: task.id }, label: `Worker ${label}`, quote: `${task.goal}\n状态：${status.label} · ${ROLE[task.role] || task.role}`, location: { view: 'task-tree', task_id: task.id } },
        { kind: 'task_subtree', target: { task_id: task.id }, label: `Worker 子树 ${label}`, quote: `${task.goal}\n从此 Worker 开始的分支`, location: { view: 'task-tree', task_id: task.id } },
      ]);
    }
    ordered.push(node);
  }
  if (isFiltering(query) && !visible.length) ordered.push(el('div', data.task_page?.has_more
    ? '已加载 Worker 中没有符合筛选的条目；更早记录尚未加载，请继续加载历史。'
    : '没有符合筛选的条目', 'filter-empty'));
  const page = data.task_page;
  if (page) {
    const pagingKey = JSON.stringify(page);
    if (list.pagingKey !== pagingKey) {
      const paging = el('div', undefined, 'task-pagination');
      paging.append(el('span', page.truncated
        ? `当前显示全部 ${page.active} 个活动 Worker 和最近 ${page.shown} / ${page.historical} 个历史 Worker（列表已截断）`
        : `已显示全部 ${page.total} 个 Worker`, 'hint'));
      if (page.has_more) {
        const more = button('加载更早 50 个', async () => {
          more.disabled = true; more.textContent = '加载中…';
          try {
            const next = await api(`/api/workers?scope=all&before=${page.cursor}&limit=50`);
            if (listState.get(container) !== list || ui.deletedWorkerIds !== list.scope || projectBase() !== list.project) return;
            next.tasks = next.tasks.filter(task => !ui.deletedWorkerIds.has(task.id));
            const loaded = new Map([...ui.taskHistory, ...next.tasks].filter(task => !ui.deletedWorkerIds.has(task.id)).map(task => [task.id, task]));
            ui.taskHistory = [...loaded.values()];
            ui.taskHistoryPage = { ...page, cursor: next.cursor, has_more: next.has_more, truncated: next.has_more,
              shown: page.shown + next.tasks.length };
            // Polling may have replaced the snapshot while pagination was in flight.
            const latest = list.data;
            const all = new Map([...next.tasks, ...latest.tasks].filter(task => !ui.deletedWorkerIds.has(task.id)).map(task => [task.id, task]));
            latest.tasks = [...all.values()].sort((a, b) => a.id - b.id);
            latest.task_page = ui.taskHistoryPage;
            renderTree(latest);
          } catch (error) { more.disabled = false; more.textContent = '加载更早 50 个'; more.title = error.message; }
        }, 'ghost');
        more.type = 'button'; paging.append(more);
      }
      list.pagingKey = pagingKey; list.paging = paging;
    }
    ordered.push(list.paging);
  } else { list.pagingKey = null; list.paging = null; }
  syncChildren(container, ordered);
  restoreReading();
  const active = data.tasks.filter(task => HOT.has(task.status)).length;
  const matched = visible.length;
  const summary = describeFilters(query);
  $('task-count').textContent = isFiltering(query)
    ? `${countText(matched, data.tasks.length)}${summary ? ` · ${summary}` : ''}`
    : `${data.tasks.length} 个 · ${active} 进行中`;
  setNavCount('tasks', page?.total ?? data.tasks.length);
}
