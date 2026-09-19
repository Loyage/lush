import { $, badge, button, el } from './dom.js';
import { ROLE, relative, specStatus, specTitle, statusOf } from './format.js';
import { filterUi, plannerOption, roleOption, syncSelectOptions, uniqueValues, withCurrent } from './filters-ui.js';
import { detail } from './navigate.js';
import { countText, describeFilters, filterSpecs, isFiltering } from './sidebar.js';
import { setNavCount } from './sidebar-ui.js';
import { ui } from './state.js';

/* ---------- 拆解队列（只读）：planner 写、scheduler 取走、Web 只展示 ---------- */
// deps 可能是已解析的数组（{spec,kind} 或裸 id），也可能是 JSON 字符串；三种都要兼容。
export function specDeps(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
/** 一条 spec：id / 状态 / role / name / goal（单行截断）/ 更新时间 / 派生的任务 / 依赖。纯只读。 */
export function specItem(spec) {
  const info = specStatus(spec);
  const item = el('div', undefined, 'spec');
  const row = el('span', undefined, 'row');
  row.append(el('span', `#${spec.id}`, 'tid'), badge(info.label, info.className));
  if (spec.role) row.append(badge(ROLE[spec.role] || spec.role, 'b-neutral'));
  if (spec.name) row.append(el('span', spec.name, 'spec-name'));
  row.append(el('span', relative(spec.updated_at), 'when'));
  item.append(row);
  const goal = el('span', spec.goal, 'spec-goal');
  goal.title = spec.goal;
  item.append(goal);
  const deps = specDeps(spec.deps).map(dep => (dep && typeof dep === 'object' ? dep.spec : dep));
  if (deps.length) item.append(el('span', `依赖 spec #${deps.join('、')}`, 'meta'));
  if (spec.note && spec.status === 'dropped') item.append(el('span', `原因：${spec.note}`, 'meta'));
  if (spec.status === 'planned' && spec.task_id !== null && spec.task_id !== undefined) {
    const taskRow = el('span', undefined, 'spec-task');
    taskRow.append(el('span', `任务 #${spec.task_id}`, 'tid'),
      button('查看任务', () => { ui.noticeFocus = null; return detail(spec.task_id); }, 'link'));
    item.append(taskRow);
  }
  item.title = specTitle(spec);
  return item;
}
/** 只读展示拆解队列：按批次分组，区分「等 scheduler 编排」与「已被 scheduler #N 取走」。 */
export function renderSpecs(data) {
  const all = data.specs || [];
  const query = ui.filters.specs;
  const specs = filterSpecs(all, query);
  const tasks = data.tasks || [];
  const stats = data.status?.specs || {};
  setNavCount('specs', all.length);
  const specSummary = describeFilters(query);
  $('spec-count').textContent = all.length
    ? (isFiltering(query)
      ? `${countText(specs.length, all.length)}${specSummary ? ` · ${specSummary}` : ''}`
      : `排队 ${stats.pending ?? 0} · 已排期 ${stats.planned ?? 0} · 丢弃 ${stats.dropped ?? 0}`)
    : '空';
  if (filterUi.specPlanner) {
    const options = [{ value: 'all', label: '全部 planner' }, ...uniqueValues(all, 'planner_task_id').map(plannerOption)];
    syncSelectOptions(filterUi.specPlanner, withCurrent(options, ui.filters.specs.planner, plannerOption), ui.filters.specs.planner);
  }
  if (filterUi.specRole) {
    const options = [{ value: 'all', label: '全部角色' }, ...uniqueValues(all, 'role').map(roleOption)];
    syncSelectOptions(filterUi.specRole, withCurrent(options, ui.filters.specs.role, roleOption), ui.filters.specs.role);
  }
  // 只在队列结构或筛选条件变化时重建：轮询不能把左侧的滚动位置冲掉。
  const signature = [JSON.stringify(query), all.map(spec => `${spec.id}:${spec.status}:${spec.batch_id}:${spec.task_id}`).join('\u0000')].join('\u0002');
  if (signature === ui.specSignature) return;
  ui.specSignature = signature;
  const container = $('specs');
  if (!all.length) { container.replaceChildren(el('div', '拆解队列空：planner 还没写下可编排的条目；写完由 scheduler 一次性编排本批。', 'spec-empty')); return; }
  if (!specs.length) { container.replaceChildren(el('div', '没有符合筛选的条目', 'spec-empty')); return; }
  // 组：batch_id 为空的是还没被 scheduler 取走的一轮拆解（按 planner 分）；否则按 batch（= scheduler 任务 id）分。
  const groupKey = spec => (spec.batch_id === null || spec.batch_id === undefined ? `planner:${spec.planner_task_id}` : `batch:${spec.batch_id}`);
  // 每组的总数从全量算：筛选后组标题能给出「匹配 N / 共 M 条」。
  const totalByGroup = new Map();
  for (const spec of all) totalByGroup.set(groupKey(spec), (totalByGroup.get(groupKey(spec)) || 0) + 1);
  const groups = new Map();
  for (const spec of specs) {
    const key = groupKey(spec);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(spec);
  }
  const ordered = [...groups.values()].sort((a, b) => {
    const pendingA = a[0].batch_id === null || a[0].batch_id === undefined;
    const pendingB = b[0].batch_id === null || b[0].batch_id === undefined;
    if (pendingA !== pendingB) return pendingA ? -1 : 1;   // 等编排的组在前
    if (pendingA) return a[0].planner_task_id - b[0].planner_task_id;
    return a[0].batch_id - b[0].batch_id;                  // 已被取走的按 scheduler id 升序
  });
  container.replaceChildren(...ordered.map(rows => {
    const sorted = [...rows].sort((a, b) => a.id - b.id);
    const first = sorted[0];
    const group = el('div', undefined, 'spec-group');
    const total = totalByGroup.get(groupKey(first)) ?? sorted.length;
    const count = isFiltering(query) && total !== sorted.length ? `匹配 ${sorted.length} / 共 ${total} 条` : `${sorted.length} 条`;
    let title;
    if (first.batch_id === null || first.batch_id === undefined) {
      title = `等 scheduler 编排 · planner #${first.planner_task_id} 的一轮拆解（${count}）`;
    } else {
      const scheduler = tasks.find(task => task.id === first.batch_id);
      title = `已被 scheduler #${first.batch_id}${scheduler ? `（${statusOf(scheduler).label}）` : ''} 取走 · planner #${first.planner_task_id} 的一轮拆解（${count}）`;
    }
    group.append(el('div', title, 'spec-batch'));
    for (const spec of sorted) group.append(specItem(spec));
    return group;
  }));
}
