import { $, badge, button, el } from './dom.js';
import { action } from './api.js';
import { promptDialog } from './dialog.js';
import { PLAN_GATE, relative, short, statusOf } from './format.js';
import { filterUi, statusOption, syncSelectOptions, uniqueValues, withCurrent } from './filters-ui.js';
import { detail } from './navigate.js';
import { countText, describeFilters, filterIntents, isFiltering } from './sidebar.js';
import { setNavCount } from './sidebar-ui.js';
import { orderList } from './tree-order.js';
import { ui } from './state.js';
import { referenceable } from './context-references.js';

/* ---------- Intent workbench: goal → compiled Plan → review candidate ---------- */
function planActions(intent) {
  if (intent.plan_gate !== 'proposed') return null;
  const actions = el('span', undefined, 'intent-actions');
  actions.append(button('批准并开发', () => action('plan.approve', { id: intent.task_id }), 'primary'));
  actions.append(button('驳回', async () => {
    const reason = await promptDialog({
      title: `驳回 #${intent.id} 的拆解？`,
      message: '理由会送给 planner，让它据此重拆。',
      label: '驳回理由',
      placeholder: '例如：别动架构，先加个开关',
      confirmLabel: '驳回并重拆',
    });
    if (!reason || !reason.trim()) return;
    return action('plan.reject', { id: intent.task_id, reason: reason.trim() });
  }));
  return actions;
}
function candidateActions(intent) {
  const actions = el('span', undefined, 'intent-actions');
  if (intent.showcase_task_id) actions.append(button(`查看效果展示 #${intent.showcase_task_id}`,
    () => detail(intent.showcase_task_id), 'link'));
  if (!intent.candidate_id) return actions.children.length ? actions : null;
  if (intent.candidate_report_task_id && intent.candidate_status === 'preparing') {
    actions.append(button(`查看历史检验任务 #${intent.candidate_report_task_id}`,
      () => detail(intent.candidate_report_task_id), 'link'));
  } else if (intent.candidate_report_task_id && ['ready','accepted','integrated'].includes(intent.candidate_status)) {
    const report = el('a', '打开结果报告', 'link');
    report.href = `/api/task/${intent.candidate_report_task_id}/report`; report.target = '_blank'; report.rel = 'noopener';
    actions.append(report);
  }
  if (intent.candidate_status === 'ready') {
    actions.append(button('接受并合入', () => action('candidate.accept', { id: intent.candidate_id }), 'primary'));
    actions.append(button('要求修改', async () => {
      const feedback = await promptDialog({ title: `候选 v${intent.candidate_version} 需要怎样修改？`,
        message: '反馈会在同一个 Intent 下启动增量 planner；已审阅版本保持不变。', label: '验收反馈',
        placeholder: '例如：移动端按钮太靠下，请调整后重新给我看', confirmLabel: '提交修改要求' });
      if (feedback?.trim()) return action('candidate.changes', { id: intent.candidate_id, feedback: feedback.trim() });
    }));
  }
  return actions.children.length ? actions : null;
}
/** One intent row: original goal, deterministic Plan compilation and the latest frozen review candidate. */
function intentItem(intent) {
  const status = statusOf(intent);
  const item = el('div', undefined, `intent${intent.plan_gate === 'proposed' ? ' needs-approval' : ''}`);
  const row = el('span', undefined, 'row');
  row.append(el('span', `#${intent.id}`, 'tid'), badge(`${status.icon} ${status.label}`, `b-${intent.status}`));
  if (intent.flow) row.append(badge(intent.flow === 'explain' ? '了解' : '开发', 'b-neutral'));
  if (intent.direct) row.append(badge('直接执行 · 无规划调用', 'b-neutral'));
  row.append(el('span', relative(intent.created_at), 'when'));
  item.append(row);
  const goal = el('span', intent.content, 'goal intent-goal');
  goal.title = intent.content;
  item.append(goal);
  const meta = el('span', undefined, 'meta');
  meta.append(el('span', `${intent.direct ? '规划占位' : '规划'} #${intent.task_id}`, 'tid'));
  const counts = [intent.specs_pending ? `待编排 ${intent.specs_pending}` : null, intent.specs_planned ? `已编排 ${intent.specs_planned}` : null,
    intent.specs_dropped ? `已丢弃 ${intent.specs_dropped}` : null].filter(Boolean);
  meta.append(el('span', counts.length ? `拆解 ${counts.join(' · ')}` : '还没拆解'));
  if (intent.candidate_id) meta.append(badge(`候选 v${intent.candidate_version} · ${intent.candidate_status}`, intent.candidate_status === 'ready' ? 'b-completed' : 'b-neutral'));
  if (PLAN_GATE[intent.plan_gate]) meta.append(badge(PLAN_GATE[intent.plan_gate].label, PLAN_GATE[intent.plan_gate].className));
  // 锚点在 submit 那一刻写下、之后不变：这条输入派出的 worker 都以它为基线。
  if (intent.anchor_branch) {
    const anchor = el('span', `锚点 ${short(intent.anchor_commit)}`, 'tid');
    anchor.title = `${intent.anchor_branch} @ ${intent.anchor_commit}\nworktree: ${intent.anchor_workspace}\n目标分支: ${intent.anchor_target_branch}`;
    meta.append(anchor);
  }
  if (intent.work_tasks) meta.append(el('span', `开发任务 ${intent.work_tasks}`));
  if (intent.references?.length) meta.append(badge(`引用 ${intent.references.length}`, 'b-neutral'));
  item.append(meta);
  const actions = planActions(intent);
  if (actions) item.append(actions);
  const review = candidateActions(intent);
  if (review) item.append(review);
  item.append(el('span', intent.plan_gate === 'proposed'
    ? 'planner 认为这次改动风险较高，先请你拍板；批准后由 runtime 直接编译 Work DAG。'
    : '回看规划、执行与交付结果；合并仍由你明确批准。', 'hint'));
  item.onclick = event => { if (event.target === item || event.target.classList.contains('goal')) { ui.noticeFocus = null; return detail(intent.task_id); } };
  referenceable(item, { kind: 'intent', target: { input_id: intent.id }, label: `意图 #${intent.id}`,
    quote: intent.content, location: { view: 'intent-list', input_id: intent.id } });
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
    intent.specs_dropped, intent.work_tasks, intent.work_active, intent.work_failed, intent.flow, intent.direct, intent.candidate_id, intent.candidate_version, intent.candidate_status,
    intent.candidate_report_task_id, intent.showcase_task_id, intent.showcase_status].join(':')).join('\u0000')].join('\u0002');
  if (signature === ui.intentSignature) return;
  ui.intentSignature = signature;
  const container = $('intents');
  if (!all.length) { container.replaceChildren(el('div', '还没有历史输入：在下面输入框回车就提交一条。', 'intent-empty')); return; }
  if (!intents.length) { container.replaceChildren(el('div', '没有符合筛选的条目', 'intent-empty')); return; }
  container.replaceChildren(...intents.map(intentItem));
}
