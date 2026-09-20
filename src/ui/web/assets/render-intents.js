import { $, badge, button, el } from './dom.js';
import { action } from './api.js';
import { PLAN_GATE, STATUS, relative, short, statusOf } from './format.js';
import { filterUi, statusOption, syncSelectOptions, uniqueValues, withCurrent } from './filters-ui.js';
import { detail } from './navigate.js';
import { countText, describeFilters, filterIntents, isFiltering } from './sidebar.js';
import { setNavCount } from './sidebar-ui.js';
import { orderList } from './tree-order.js';
import { ui } from './state.js';

/* ---------- 历史输入（intent）：一条用户输入 + 它的 planner 拆解 / scheduler 编排 ---------- */
// 意图层不是任务：planner 与 scheduler 不进任务树，只在这里和左栏的「历史输入」区块里露面。
function planActions(intent) {
  if (intent.plan_gate !== 'proposed') return null;
  const actions = el('span', undefined, 'intent-actions');
  actions.append(button('批准并开发', () => action('plan.approve', { id: intent.task_id }), 'primary'));
  actions.append(button('驳回', () => {
    const reason = prompt('驳回理由（会送给 planner，让它据此重拆）：', '');
    if (!reason || !reason.trim()) return Promise.resolve();
    return action('plan.reject', { id: intent.task_id, reason: reason.trim() });
  }));
  return actions;
}
/** 一条意图：输入正文 + planner 状态/闸门 + 拆解条数 + scheduler 编排进度。只读，除了批准/驳回。 */
function intentItem(intent) {
  const status = statusOf(intent);
  const item = el('div', undefined, `intent${intent.plan_gate === 'proposed' ? ' needs-approval' : ''}`);
  const row = el('span', undefined, 'row');
  row.append(el('span', `#${intent.id}`, 'tid'), badge(`${status.icon} ${status.label}`, `b-${intent.status}`));
  if (intent.flow) row.append(badge(intent.flow === 'explain' ? '了解' : '开发', 'b-neutral'));
  row.append(el('span', relative(intent.created_at), 'when'));
  item.append(row);
  const goal = el('span', intent.content, 'goal intent-goal');
  goal.title = intent.content;
  item.append(goal);
  const meta = el('span', undefined, 'meta');
  meta.append(el('span', `规划 #${intent.task_id}`, 'tid'));
  const counts = [intent.specs_pending ? `待编排 ${intent.specs_pending}` : null, intent.specs_planned ? `已编排 ${intent.specs_planned}` : null,
    intent.specs_dropped ? `已丢弃 ${intent.specs_dropped}` : null].filter(Boolean);
  meta.append(el('span', counts.length ? `拆解 ${counts.join(' · ')}` : '还没拆解'));
  if (intent.scheduler_id) {
    const scheduler = el('button', `调度 #${intent.scheduler_id} · ${STATUS[intent.scheduler_status]?.label ?? intent.scheduler_status}`, 'link');
    scheduler.type = 'button';
    scheduler.onclick = () => { ui.noticeFocus = null; return detail(intent.scheduler_id); };
    meta.append(scheduler);
  }
  if (PLAN_GATE[intent.plan_gate]) meta.append(badge(PLAN_GATE[intent.plan_gate].label, PLAN_GATE[intent.plan_gate].className));
  // 锚点在 submit 那一刻写下、之后不变：这条输入派出的 worker 都以它为基线。
  if (intent.anchor_branch) {
    const anchor = el('span', `锚点 ${short(intent.anchor_commit)}`, 'tid');
    anchor.title = `${intent.anchor_branch} @ ${intent.anchor_commit}\nworktree: ${intent.anchor_workspace}\n目标分支: ${intent.anchor_target_branch}`;
    meta.append(anchor);
  }
  if (intent.work_tasks) meta.append(el('span', `开发任务 ${intent.work_tasks}`));
  item.append(meta);
  const actions = planActions(intent);
  if (actions) item.append(actions);
  item.append(el('span', intent.plan_gate === 'proposed'
    ? 'planner 认为这次改动影响面大 / 与现状冲突 / 没把握读准意图，先请你拍板；不批就不进 scheduler。'
    : '点这条看 planner 的拆解与调试详情。', 'hint'));
  item.onclick = event => { if (event.target === item || event.target.classList.contains('goal')) { ui.noticeFocus = null; return detail(intent.task_id); } };
  return item;
}
export function renderIntents(data) {
  const all = data.inputs || [];
  const query = ui.filters.intents;
  // 智能排序＝保持接口返回的时间线顺序；updated 用 planner 最近动过的时间兜底到输入创建时间。
  const intents = orderList(filterIntents(all, query), {
    mode: ui.sidebarSortMode, timeOf: intent => intent.planner_updated_at ?? intent.created_at,
  });
  setNavCount('intents', all.length);
  const intentSummary = describeFilters(query);
  $('intent-count').textContent = isFiltering(query)
    ? `${countText(intents.length, all.length)}${intentSummary ? ` · ${intentSummary}` : ''}`
    : (all.length ? `${all.length} 条` : '空');
  if (filterUi.intentStatus) {
    const options = [{ value: 'all', label: '全部状态' }, ...uniqueValues(all, 'status').map(statusOption)];
    syncSelectOptions(filterUi.intentStatus, withCurrent(options, ui.filters.intents.status, statusOption), ui.filters.intents.status);
  }
  const signature = [ui.sidebarSortMode, JSON.stringify(query), all.map(intent => [intent.id, intent.status, intent.plan_gate, intent.specs_pending, intent.specs_planned,
    intent.specs_dropped, intent.scheduler_id, intent.scheduler_status, intent.work_tasks, intent.flow].join(':')).join('\u0000')].join('\u0002');
  if (signature === ui.intentSignature) return;
  ui.intentSignature = signature;
  const container = $('intents');
  if (!all.length) { container.replaceChildren(el('div', '还没有历史输入：在下面输入框回车就提交一条。', 'intent-empty')); return; }
  if (!intents.length) { container.replaceChildren(el('div', '没有符合筛选的条目', 'intent-empty')); return; }
  container.replaceChildren(...intents.map(intentItem));
}
