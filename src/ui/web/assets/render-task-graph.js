import { $, badge, button, el, roleBadge } from './dom.js';
import { workerKind, workerKindLabel } from './worker-kind.js';
import { api, action } from './api.js';
import { confirmDialog, promptDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { absolute, INTEGRATION, statusOf, interruptReason, worktreeLabel, isHistoricalDelivery } from './format.js';
import { show } from './messages.js';
import { detail } from './navigate.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { readPref, setPref, writePref } from './prefs.js';
import { taskForest } from './task-graph-layout.js';
import { resourceSummary } from './task-graph-usage.js';
import { mergeRelations } from './task-graph-merge.js';
import { captureGraph, restoreGraph, graphMotionRunning } from './task-graph-motion.js';
import { branchDiagnostics, decisionRow } from './task-graph-parts.js';
import { BRANCH_ARCHIVE_HELP, runBranchArchive } from './branch-archive.js';
import { workerDeleteControl } from './worker-delete.js';
import { progressReportingEnabled, progressStats, renderGraphProgress } from './render-progress.js';
import { deliveryControls } from './render-delivery.js';
import { guardedAction, iterationBlocker, iterationControls } from './render-iteration.js';

const ACTIVE = new Set(['running', 'queued', 'waiting', 'awaiting', 'awaiting_acceptance']);
const ENDED = new Set(['completed', 'failed', 'cancelled']);
/** 状态计数 / 图例的固定顺序：先是活动态，再到终结态；只画出现过的。 */
const STATUS_ORDER = ['running', 'queued', 'waiting', 'awaiting', 'awaiting_acceptance', 'completed', 'failed', 'cancelled'];
/** 图上画成卡片的 Task：自己拥有分支 / worktree 的 main / owner / 指令 / child。
 *  planner / scheduler 是历史意图层记录，不在这里画；merge Task 是旧 version 2 的历史队列身份，
 *  和别的 Task 一样由表头的状态开关决定显示与否，不按队列活跃度自动收起。 */
const VISIBLE_KINDS = new Set(['order', 'child', 'main', 'owner', 'merge']);
/** 在飞的合并预约：已预约等静息 / 已发请求待落地 / 已退回源侧解分歧。 */
const IN_FLIGHT = new Set(['pending', 'requested', 'resolving']);

/** 旧 version 2 merge 卡片的历史摘要；当前父自有队列不新增这类卡片。 */
function mergeQueueNotes(raw) {
  const queues = new Map();
  for (const node of raw) {
    if (node.task_kind !== 'merge') continue;
    const inFlight = raw.filter(child => child.parent_id === node.id && IN_FLIGHT.has(child.reservation?.status))
      .sort((a, b) => a.id - b.id);
    const requested = inFlight.filter(child => child.reservation.status === 'requested');
    const resolving = inFlight.filter(child => child.reservation.status === 'resolving');
    const pending = inFlight.length - requested.length - resolving.length;
    const parts = [];
    if (requested.length) parts.push(`${requested.length} 条已发请求待落地（历史协议，不推断当前执行位）`);
    if (pending) parts.push(`${pending} 条已预约、等静息`);
    if (resolving.length) parts.push(`${resolving.length} 条源侧解分歧中（#${resolving.map(child => child.id).join('、#')}）`);
    if (parts.length) queues.set(node.id, `历史合并队列：${parts.join(' · ')}`);
  }
  return queues;
}

function collapsed() { return new Set(readPref('taskGraphCollapsed')); }
function save(set) { writePref('taskGraphCollapsed', set); }
function hiddenStatuses() { return new Set(readPref('taskGraphStatuses')); }
function saveHiddenStatuses(set) { writePref('taskGraphStatuses', set); }

/** 归档后的 Task：自己的分支已归档，或内部 merge 队列随直接父 Task 归档。
 *  任务行仍在库里，只是默认不再占主视图；这里只认读模型字段，不自己猜 Git 现状。 */
function isArchivedTask(node) {
  return node.branch_info?.archived === true || node.archived === true;
}

/** 卡片颜色口径：running 最醒目，其余按真实状态各自一色（排队 / 在等 / 待你 / 完成 / 失败 / 取消）；
 *  只有既非活动也没有明确终结语义的才落到 idle。看板一眼能分清「正在跑」和「停下来了」。 */
function taskVisualState(node) {
  if (node.status === 'running') return 'running';
  if (node.status === 'awaiting' || node.notice) return 'awaiting';
  if (node.status === 'failed') return 'failed';
  if (node.status === 'paused') return 'paused';
  if (node.status === 'queued') return 'queued';
  if (node.status === 'waiting') return 'waiting';
  if (node.status === 'awaiting_acceptance') return 'awaiting_acceptance';
  if (node.status === 'completed') return 'completed';
  if (node.status === 'cancelled') return 'cancelled';
  return 'idle';
}

/**
 * 「合并所有」的候选：目标分支就是这条 Task、已静息且仍待集成的 order/child。展示层只做只读筛选
 * （v2 预约 JSON 不在图里展开，所以按状态 + 集成口径判断），真正能不能发出请求由 runtime 的
 * `worker.reserve_all` → `reserveMergeAll` 再逐条校验一次。
 */
function mergeAllCandidates(graph) {
  const byBranch = new Map();
  for (const node of graph.nodes || []) {
    if (!['order', 'child'].includes(workerKind(node))) continue;
    if (node.status !== 'waiting' || node.integration !== 'pending') continue;
    if (!node.target_branch) continue;
    if (node.reservation?.kind && node.reservation.kind !== 'merge') continue;
    const list = byBranch.get(node.target_branch) ?? [];
    list.push({ id: node.id, title: node.title });
    byBranch.set(node.target_branch, list);
  }
  return byBranch;
}

/**
 * 分支所有者卡片上的「合并所有」：把这条分支下所有已静息、待合并的 Task 一次性交给父 Task
 * 自有队列的 runtime 串行处理，不创建中间 Task。没有候选时也保留按钮并写明原因，选项不因当前状态整块消失。
 */
function mergeAllControl(node, candidates, refresh) {
  const box = el('section', undefined, 'task-graph-merge-all');
  if (!candidates.length) {
    const disabled = el('button', '合并所有', 'ghost');
    disabled.type = 'button'; disabled.disabled = true;
    const host = el('span', undefined, 'help-host');
    host.setAttribute('data-help', `这条分支下没有已静息、待合并的 Worker；等 Worker 完成并静息后再刷新。`);
    host.append(disabled); box.append(host);
    return box;
  }
  box.append(button(`合并所有（${candidates.length}）`, async () => {
    const detail = candidates.map(item => `#${item.id} ${item.title}`).join('\n');
    const confirmed = await confirmDialog({
      title: `把 ${node.branch} 下 ${candidates.length} 条待合并 Worker 一并放入父交付队列？`,
      message: '逐个请求合并；父 Worker 自有队列的 runtime 一次只落地一条，其余按入队顺序排队（代码依赖优先）。不创建 merge Worker、不改变父子关系，也不额外调用父 Agent。取得父执行位后才固定父基线；分歧时唤醒原 Worker 的 Agent 在源侧合入固定父提交并测试，修复期间保留父执行位。挂起释放执行位，恢复重新排队并固定新基线。已发出的请求不能批量撤销；分支与提交不会因失败丢失。',
      detail,
      confirmLabel: '开始合并',
      confirmHelp: agentHelp('按顺序自动合并所有已静息的待合并 Worker；发生分歧时会唤醒对应 Worker 的 Agent。'),
      agent: true,
    });
    if (!confirmed) return;
    const result = await action('worker.reserve_all', { branch: node.branch });
    const bits = [`共 ${result.total} 条`];
    if (result.requested) bits.push(`${result.requested} 条已发出请求`);
    if (result.blocked) bits.push(`${result.blocked} 条仍在等待条件`);
    if (result.failed) bits.push(`${result.failed} 条失败`);
    show(`已把 ${node.branch} 的待合并 Worker 放入父交付队列：${bits.join('、')}。`);
    await refresh();
  }, 'ghost', { agent: true, help: agentHelp(`一次性请求合并 ${node.branch} 下全部已静息、待合并的 Worker；由父 Worker 自有队列的 runtime 串行处理，不额外调用父 Agent，分歧时唤醒原 Agent。`) }));
  return box;
}

function taskCard(node, folded, refresh, mergeAllByBranch = new Map(), queueNote = null, minimal = false) {
  const row = el('article', undefined, 'task-graph-card');
  row.dataset.taskId = String(node.id);
  row.classList.add(`task-graph-${taskVisualState(node)}`);
  const head = el('div', undefined, 'task-graph-head');
  if (node.children.length) {
    const toggle = button(folded.has(node.id) ? '▸' : '▾', () => {
      if (hasPendingInput()) { show('请先提交或清空正在编辑的待决答复，再折叠 Worker。'); return; }
      if (folded.has(node.id)) folded.delete(node.id); else folded.add(node.id);
      save(folded); refresh();
    }, 'ghost', { help: `展开或收起 Worker #${node.id} 的 ${node.children.length} 条直接子 Worker` });
    toggle.dataset.graphFocus = `fold-${node.id}`;
    toggle.setAttribute('aria-expanded', String(!folded.has(node.id)));
    head.append(toggle);
  }
  const title = button(`#${node.id} ${node.title}`, () => detail(node.id), 'ghost');
  title.classList.add('task-graph-title');
  title.dataset.graphFocus = `title-${node.id}`;
  head.append(title, ...(minimal || node.role === 'agent' ? [] : [roleBadge(node.role)]), badge(node.status === 'waiting' && !node.children_active && !interruptReason(node) ? '静息' : statusOf(node).label,
    `b-${node.status}`));
  // 资源消耗紧跟任务状态，排在合并状态标签前面；极简模式的合并标签在第二行，由 minimalSummary 渲染。
  if (!minimal) head.append(resourceSummary(node, folded.has(node.id)));
  // 分支合并状态标签：一眼看清这条 Task 的改动合进父分支没有。
  // 用与任务详情同一份 INTEGRATION 文案与配色；none（没有独有提交）/ 未知值不占位。
  const merge = INTEGRATION[node.integration];
  if (!minimal && merge) head.append(badge(merge, node.integration === 'merged' ? 'b-completed' : 'b-awaiting'));
  if (!minimal && node.task_kind) head.append(badge(node.task_kind === 'merge' ? 'merge（历史）' : workerKindLabel(node)));
  if (!minimal && node.freeze && node.freeze.task_id !== node.id) head.append(badge(node.status === 'running' ? '安全点后冻结' : '冻结', 'warn'));
  if (node.notice_count) head.append(badge(`${node.notice_count} 条待决`, 'b-awaiting'));
  row.append(head);
  if (minimal) {
    row.append(minimalSummary(node, queueNote, folded), taskActionsMenu(node, mergeAllByBranch));
    return row;
  }

  const relations = mergeRelations(node);
  if (relations) row.append(relations);
  if (node.goal_preview && node.goal_preview !== node.title) row.append(el('p', node.goal_preview, 'task-graph-goal'));
  const interruptHint = interruptReason(node);
  if (interruptHint || node.waiting_reason) row.append(el('p', interruptHint || node.waiting_reason, 'task-graph-reason'));
  if (queueNote) row.append(el('p', queueNote, 'task-graph-reason'));
  if (node.result_preview) row.append(el('p', `最近结果：${node.result_preview}${node.result_preview.length >= 320 ? '…' : ''}`, 'task-graph-result'));
  const progress = renderGraphProgress(node.progress, { running: node.status === 'running', status: node.status });
  if (progress) row.append(progress);

  const facts = el('div', undefined, 'task-graph-facts');
  if (node.resolves_task_id) facts.append(button(`正在解决 Worker #${node.resolves_task_id}`, () => detail(node.resolves_task_id), 'ghost',
    { help: '这是被修复的源 Worker；父子连线表示负责收敛的 Worker，不会改写已终结源 Worker 的血缘。' }));
  if (node.branch) facts.append(el('span', `分支：${node.branch}`, 'mono'));
  if (node.target_branch) facts.append(el('span', `父分支：${node.target_branch}`, 'mono'));
  if (node.base_commit) facts.append(el('span', `Worker 基线：${node.base_commit.slice(0, 12)}`, 'mono'));
  if (node.iteration_base_commit) facts.append(el('span', `本轮基线：${node.iteration_base_commit.slice(0, 12)}`, 'mono'));
  if (node.head_commit) facts.append(el('span', `固定提交：${node.head_commit.slice(0, 12)}`, 'mono'));
  if (node.workspace) facts.append(el('span', `${worktreeLabel(node)}：${node.workspace}`, 'mono'));
  if (node.workspace_state === 'missing') facts.append(badge('⚠ worktree 缺失', 'warn'));
  if (!node.branch && !node.workspace) facts.append(el('span', '无独立分支 / worktree', 'meta'));
  if (node.branch_info?.archived) facts.append(badge('分支已归档'));
  else if (node.archived && node.task_kind === 'merge') facts.append(badge('随父 Worker 归档'));
  if (node.delivery) facts.append(badge(`交付：${node.delivery.kind} · ${node.delivery.status}`));
  if (node.has_rule) facts.append(badge('固定输入规则'));
  if (node.children_total) facts.append(el('span', `子 Worker：${node.children_total}${node.children_active ? `（${node.children_active} 活动）` : ''}`, 'meta'));
  if (Number.isInteger(node.calls) && node.calls) facts.append(el('span', `Agent 调用 ${node.calls} 次`, 'meta'));
  if (node.created_at) facts.append(el('span', `创建 ${absolute(node.created_at)}`, 'meta'));
  if (node.updated_at) facts.append(el('span', `更新 ${absolute(node.updated_at)}`, 'meta'));
  row.append(facts);
  if (node.integration_error) row.append(el('p', `集成受阻：${node.integration_error}`, 'hint'));
  if (workerKind(node) !== 'order' && node.delivery?.blocked_reason) row.append(el('p', `交付受阻：${node.delivery.blocked_reason}`, 'hint'));
  if (node.parent_id && !ui.taskGraphIds?.has(node.parent_id)) row.append(el('p', `父 Worker #${node.parent_id} 不在当前图中`, 'hint'));

  if (node.branch_info && !node.branch_info.archived) {
    const branch = node.branch_info;
    const git = el('section', undefined, 'task-graph-git');
    const header = el('div', '分支诊断', 'task-graph-git-head');
    if (branch.current_head) header.append(el('span', `HEAD ${branch.current_head.slice(0, 12)}`, 'mono'));
    else header.append(el('span', '当前分支 ref 不可用', 'warn'));
    if (branch.current_head && node.head_commit && branch.current_head !== node.head_commit) {
      header.append(el('span', `与 Worker 固定提交 ${node.head_commit.slice(0, 12)} 不同`, 'warn'));
    }
    git.append(header);
    if (branch.current) header.append(badge('当前检出'));
    if (branch.parent) git.append(el('div', `Git 父分支：${branch.parent}`, 'mono'));
    const relation = branch.relation;
    const label = { equal: '一致', ahead: '领先', behind: '落后', diverged: '分歧', missing: '分支缺失',
      parent_archived: '父分支已归档', unknown: '关系未知' }[relation?.status] || '关系未知';
    const counts = Number.isFinite(relation?.ahead) && Number.isFinite(relation?.behind)
      ? ` · 领先 ${relation.ahead} / 落后 ${relation.behind} 个提交` : '';
    git.append(el('div', `Git 关系：${label}${counts}`, ['diverged', 'missing'].includes(relation?.status) ? 'warn' : 'meta'));
    if (relation?.status === 'diverged' && node.integration === 'merged')
      git.append(el('p', '改动已合入；Squash 等集成方式不会改写原分支的 Git 提交关系。', 'hint'));
    if (branch.diagnostics) git.append(branchDiagnostics({ name: node.branch, diagnostics: branch.diagnostics }));
    else git.append(el('p', '分支诊断不可用，不能推断工作区干净或已合并。', 'hint'));
    row.append(git);
    // 归档与详情同源（`branch.archive`）：删这条分支与后代分支的 worktree/ref，Task 记录保留。
    const archive = archiveControl(node);
    if (archive) row.append(archive);
  }

  if (node.notice && !isHistoricalDelivery(node)) {
    if (['question', 'plan'].includes(node.notice.kind)) {
      // Inline decisions refresh this Task view after a response.
      const decision = decisionRow(node, loadTaskGraph);
      if (node.notice.body?.length >= 1000) decision.append(el('p', '正文仅显示前 1000 字；完整内容请打开 Worker 详情。', 'hint'));
      row.append(decision);
    } else {
      const pending = el('div', undefined, 'graph-decision');
      pending.append(el('strong', node.notice.title || '等待你回答问卷'),
        el('p', '这条待决事项需要在 Worker 详情完成问卷；图中不会把选项误当作普通文字答复。', 'hint'),
        button('打开待决事项', () => detail(node.id), 'ghost', { help: '到 Worker 详情查看完整问题与选项并答复。' }));
      row.append(pending);
    }
  }
  appendTaskActions(row, node, mergeAllByBranch);
  return row;
}

function archiveControl(node) {
  const branch = node.branch_info;
  if (!branch || branch.archived || !branch.archivable || isHistoricalDelivery(node) || node.status === 'awaiting_acceptance') return null;
  return button('归档', () => runBranchArchive({ name: node.branch, subtreeBranches: branch.subtree_branches },
    { refresh: loadTaskGraph }), 'ghost', { help: BRANCH_ARCHIVE_HELP });
}

// 完整卡片和极简浮层共用同一套准入、确认、Agent 标识与 RPC，不复制业务规则。
function appendTaskActions(row, node, mergeAllByBranch) {
  if (['main', 'owner'].includes(node.task_kind) && node.branch)
    row.append(mergeAllControl(node, mergeAllByBranch.get(node.branch) ?? [], loadTaskGraph));
  const iteration = iterationControls(node, { refresh: loadTaskGraph });
  if (iteration) row.append(iteration);
  const controls = deliveryControls(node, { refresh: loadTaskGraph });
  if (controls) row.append(controls);
  const deletion = workerDeleteControl(node, { refresh: loadTaskGraph });
  if (deletion) row.append(deletion);
  if (['order', 'child'].includes(workerKind(node)) && !ENDED.has(node.status) && !isHistoricalDelivery(node)) {
    row.append(guardedAction(button('向此 Worker 输入', async () => {
      const body = await promptDialog({ title: `发给 Worker #${node.id}`, label: '输入', confirmLabel: '发送消息',
        confirmHelp: agentHelp('把输入交给这条 Worker；固定规则可请求 Agent 在安全点提前收尾，否则轮末投递。'), agent: true });
      if (!body) return;
      await action('worker.message', { id: node.id, body });
      show(`已提交给 Worker #${node.id}`);
      await loadTaskGraph();
    }, 'ghost', { agent: true, help: agentHelp('给这个 Worker 的 Agent 发送输入；可能在安全点提前收尾，不会立即硬杀。') }), iterationBlocker(node)));
  }
}

function minimalSummary(node, queueNote, folded = new Set()) {
  const line = el('div', undefined, 'task-graph-minimal-summary');
  const reporting = progressReportingEnabled();
  const stats = progressStats(reporting ? node.progress : null);
  const count = stats.total ? `${stats.completed}/${stats.total}` : '';
  const stopped = { failed: '失败时中止', cancelled: '取消时中止', completed: '结束时未完成' }[node.status];
  const step = stats.current ? `${stats.current.label}${stopped ? ` · ${stopped}` : ''}`
    : stats.total ? '计划已全部完成' : reporting && node.status === 'running' ? '等待 Agent 汇报计划' : '';
  const waiting = ['waiting', 'awaiting', 'awaiting_acceptance', 'paused', 'queued'].includes(node.status);
  const interruptHint = interruptReason(node);
  const note = interruptHint || (node.integration_error ? `集成受阻：${node.integration_error}`
    : waiting && node.waiting_reason ? node.waiting_reason : queueNote || step);
  const text = el('span', [count, note].filter(Boolean).join(' · '), 'task-graph-minimal-note');
  const relations = mergeRelations(node);
  line.append(interruptHint ? text : relations || text);
  if (node.freeze && node.freeze.task_id !== node.id) line.append(badge(node.status === 'running' ? '安全点后冻结' : '冻结', 'warn'));
  if (isArchivedTask(node)) line.append(badge('已归档'));
  // 资源消耗排在合并状态标签前面；收拢时这里显示的是整棵子树的合计。
  line.append(resourceSummary(node, folded.has(node.id)));
  const merge = INTEGRATION[node.integration];
  if (merge) line.append(badge(merge, node.integration === 'merged' ? 'b-completed' : 'b-awaiting'));
  return line;
}

/** 原生非模态 popover：在顶层浮动，不受树横向滚动裁切；Esc / 外部点击由浏览器收起。
 * 普通按钮组而非 ARIA menu：复用控件内含说明与禁用帮助，Tab 按文档顺序可达。 */
function taskActionsMenu(node, mergeAllByBranch) {
  const wrap = el('div', undefined, 'task-graph-more');
  const panel = el('section', undefined, 'task-graph-actions-popover');
  panel.id = `task-graph-actions-${node.id}`;
  panel.setAttribute('popover', 'auto');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', `Worker #${node.id} 更多操作`);
  const trigger = el('button', '⋯', 'ghost task-graph-more-trigger');
  trigger.type = 'button';
  trigger.setAttribute('popovertarget', panel.id);
  trigger.setAttribute('data-help', '打开这条 Worker 的更多操作；可追加输入、处理交付或进入详情，不展开 Worker 条目。');
  trigger.onclick = () => {
    if (panel.dataset.open === 'true') return;
    const heading = el('strong', `#${node.id} ${node.title}`, 'task-graph-actions-title');
    const close = button('关闭', () => panel.hidePopover(), 'ghost');
    close.setAttribute('autofocus', '');
    panel.replaceChildren(heading, close, button('打开 Worker 详情', () => detail(node.id), 'ghost'));
    if (node.notice) panel.append(button('打开待决事项', () => detail(node.id), 'ghost',
      { help: '到 Worker 详情查看完整问题与选项并答复。' }));
    appendTaskActions(panel, node, mergeAllByBranch);
    const archive = archiveControl(node);
    if (archive) panel.append(archive);
  };
  // 先关闭顶层浮层并恢复触发焦点，再让业务按钮打开原有确认 / 输入弹窗。
  panel.addEventListener('click', event => {
    const button = event.target.closest?.('button');
    if (button && !button.disabled) panel.hidePopover();
  }, { capture: true });
  trigger.dataset.graphFocus = `more-${node.id}`;
  trigger.setAttribute('aria-label', `Worker #${node.id} 更多操作`);
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', panel.id);
  trigger.setAttribute('aria-expanded', 'false');
  panel.addEventListener('beforetoggle', event => {
    const open = event.newState === 'open';
    panel.dataset.open = String(open);
    trigger.setAttribute('aria-expanded', String(open));
    if (!open) trigger.focus({ preventScroll: true });
  });
  wrap.append(trigger, panel);
  return wrap;
}

export function renderTaskGraph(graph) {
  if (ui.view?.id !== 'task-graph') return;
  if (hasOpenActions() || hasPendingInput() || window.getSelection?.()?.toString()
    || graphMotionRunning($('detail').querySelector('.task-graph'))) return;
  const minimal = ui.taskGraphMinimal;
  const raw = (graph.nodes || []).filter(node => !ui.deletedWorkerIds.has(node.id));
  const byId = new Map(raw.map(node => [node.id, node]));
  // merge 与其它 Task 一视同仁：画不画由表头的状态开关决定，不再按队列活跃度整层收起。
  const visible = new Set(raw.filter(node => VISIBLE_KINDS.has(workerKind(node))).map(node => node.id));
  // 被筛掉的中间 Task 不制造孤儿：父指到最近的可见祖先，所以归档 / 状态筛选藏起来的父 Task 不会把子 Task 一起带走。
  // 祖先都不在这一页（被截断 / 真的缺节点）时保留原 parent_id，照旧画成根并写明「父 Task 不在当前图中」。
  const parentInView = node => {
    const seen = new Set([node.id]);
    for (let parent = byId.get(node.parent_id); parent && !seen.has(parent.id); parent = byId.get(parent.parent_id)) {
      if (visible.has(parent.id)) return parent.id;
      seen.add(parent.id);
    }
    return node.parent_id ?? null;
  };
  const all = raw.filter(node => visible.has(node.id)).map(node => ({ ...node, layout_parent_id: parentInView(node) }));
  const mergeQueue = mergeQueueNotes(raw);
  const full = graph; // Local controls must retain hidden intermediates and real parents.
  // 归档 Task 默认不画：它们是收尾后的记录，收进「显示已归档」开关后面，避免压住仍在进行的工作。
  // 过滤在 taskForest 之前完成，所以归档父节点下的未归档子 Task 会顶成根，不会一起消失。
  const archivedCount = all.filter(isArchivedTask).length;
  const listed = ui.taskGraphShowArchived ? all : all.filter(node => !isArchivedTask(node));
  // 状态计数用筛选前的口径：关掉一个状态后它的开关还得留在表头上，否则再也点不回来。
  const counts = new Map();
  for (const node of listed) counts.set(node.status, (counts.get(node.status) || 0) + 1);
  const hidden = hiddenStatuses();
  const nodes = listed.filter(node => !hidden.has(node.status));
  const view = { ...full, nodes };
  const host = $('detail');
  const saved = collapsed();
  // Polls often return identical bounded data. Preserve DOM identity and reading state
  // unless content, local display preferences, the deletion filter or the layout width changed.
  // A stale graph response can still list a just-deleted subtree, so the filter set is part of the key.
  const renderKey = JSON.stringify([graph, minimal, [...saved].sort(), [...hidden].sort(),
    ui.taskGraphShowArchived, [...ui.taskGraphFilesExpanded].sort(), host.clientWidth,
    [...ui.deletedWorkerIds].sort((a, b) => a - b)]);
  if (host.querySelector('.task-graph')?.dataset.renderKey === renderKey) return;
  const before = captureGraph(host);
  const forest = taskForest(view);
  const mergeAllByBranch = mergeAllCandidates(view);
  // 用 all 而不是 nodes：可见子 Task 的父 Task 可能只是被归档藏起来，不该被说成「不在当前图中」。
  ui.taskGraphIds = new Set(all.map(node => node.id));
  const focusKey = document.activeElement?.dataset?.graphFocus;
  const focusTask = document.activeElement?.closest?.('.task-graph-card')?.dataset.taskId;
  const box = el('div', undefined, `task-graph${minimal ? ' task-graph-minimal' : ''}`);
  const hero = el('header', undefined, 'resource-hero task-graph-hero');
  hero.append(el('h1', 'Worker 树'), el('p', '连线表示委派层级（隐藏节点可能省略），卡片箭头表示真实合并目标。新式请求由父 Worker 的 runtime 串行合并，不额外调用父 Agent；分歧时由源 Worker 处理。同父兄弟按处理阶段优先展示，不代表执行次序，代码依赖仍优先。'));
  const summary = el('div', undefined, 'task-graph-summary');
  const active = nodes.filter(node => ACTIVE.has(node.status)).length;
  const decisions = nodes.reduce((count, node) => count + (node.notice_count || 0), 0);
  summary.append(badge(`图中 ${nodes.length} / ${graph.total} Worker`), badge(`${active} 活动`));
  // 状态计数本身兼作图例与开关：点一下隐藏 / 显示该状态，只改显示、不写库、不改任务状态。
  for (const status of STATUS_ORDER) {
    const count = counts.get(status) || 0;
    if (!count) continue;
    const info = statusOf({ status });
    const off = hidden.has(status);
    const toggle = button(`${info.icon} ${info.label} ${count}`, () => {
      const next = hiddenStatuses();
      if (next.has(status)) next.delete(status); else next.add(status);
      saveHiddenStatuses(next);
      renderTaskGraph(full);
    }, 'badge task-graph-status-toggle', {
      help: off ? `当前隐藏了「${info.label}」的 Worker；点一下重新显示。`
        : `隐藏「${info.label}」的 Worker；只影响这一页的显示，不改 Worker 状态。`,
    });
    toggle.classList.add(`b-${status}`);
    toggle.setAttribute('data-status', status);
    toggle.dataset.graphFocus = `status-${status}`;
    if (off) toggle.classList.add('is-off');
    toggle.setAttribute('aria-pressed', String(!off));
    summary.append(toggle);
  }
  if (hidden.size) summary.append(button('全部状态', () => {
    saveHiddenStatuses(new Set());
    renderTaskGraph(full);
  }, 'ghost task-graph-status-reset', { help: '清除状态筛选，重新显示所有状态的 Worker。' }));
  if (decisions) summary.append(badge(`${decisions} 待决`, 'b-awaiting'));
  if (archivedCount) {
    const toggle = el('label', undefined, 'task-graph-mode task-graph-archived-toggle');
    const archived = el('input');
    archived.type = 'checkbox';
    archived.checked = ui.taskGraphShowArchived;
    archived.dataset.graphFocus = 'show-archived';
    archived.onchange = () => {
      if (hasPendingInput()) {
        archived.checked = ui.taskGraphShowArchived;
        show('请先提交或清空正在编辑的待决答复，再切换归档显示。');
        return;
      }
      ui.taskGraphShowArchived = archived.checked;
      renderTaskGraph(full);
      host.querySelector('[data-graph-focus="show-archived"]')?.focus({ preventScroll: true });
    };
    toggle.append(archived, el('span', `显示已归档（${archivedCount}）`));
    toggle.setAttribute('data-help', '归档 Worker 是用户显式归档分支后留下的记录，包含随父 Worker 归档的历史内部合并队列；这里只在当前页面显示，不写库、不改 Worker 状态，重开页面仍默认隐藏。');
    summary.append(toggle);
  }
  const mode = el('label', undefined, 'task-graph-mode');
  const checkbox = el('input');
  checkbox.type = 'checkbox';
  checkbox.checked = !minimal;
  checkbox.dataset.graphFocus = 'detail-mode';
  checkbox.onchange = () => {
    if (hasPendingInput()) {
      checkbox.checked = !minimal;
      show('请先提交或清空正在编辑的待决答复，再切换显示模式。');
      return;
    }
    setPref('taskGraphMinimal', !checkbox.checked);
    renderTaskGraph(full);
    host.querySelector('[data-graph-focus="detail-mode"]')?.focus({ preventScroll: true });
  };
  mode.append(checkbox, el('span', '详情模式'));
  mode.setAttribute('data-help', '勾选后展开 Worker 的目标、结果、进度、分支诊断与操作；取消勾选回到默认的极简双行展示。仅改变显示，按项目记住选择。');
  hero.append(summary, mode, button('刷新', () => loadTaskGraph(), 'ghost'));
  box.append(hero);
  if (view.truncated) box.append(el('p', `只显示最近及活动的 ${nodes.length} / ${graph.total} 条 Worker；父节点可能在截断范围外。`, 'hint'));
  const paint = (node, parent) => {
    const wrap = el('div', undefined, 'task-graph-node');
    wrap.append(taskCard(node, saved, () => renderTaskGraph(full), mergeAllByBranch, mergeQueue.get(node.id) ?? null, minimal));
    if (node.children.length && !saved.has(node.id)) {
      const children = el('div', undefined, 'task-graph-children');
      for (const child of node.children) paint(child, children);
      wrap.append(children);
    }
    parent.append(wrap);
  };
  for (const node of forest) paint(node, box);
  // Structural identity excludes content/status changes, but includes every visible
  // parent, collapsed/filter preference and width: only actual reorders animate.
  const topology = [...box.querySelectorAll('.task-graph-card')].map(card => {
    const node = nodes.find(node => String(node.id) === card.dataset.taskId);
    return [node.id, node.parent_id, node.layout_parent_id];
  }).sort((a, b) => a[0] - b[0]);
  box.dataset.layoutKey = JSON.stringify([minimal, [...saved].sort(), [...hidden].sort(), ui.taskGraphShowArchived,
    host.clientWidth, topology]);
  for (const card of box.querySelectorAll('.task-graph-card')) {
    [...card.querySelectorAll('button'), ...card.querySelectorAll('input')].forEach(control => {
      const label = control.getAttribute('aria-label') || control.textContent || control.type || 'control';
      control.dataset.graphFocus ||= `control-${card.dataset.taskId}-${encodeURIComponent(label)}`;
    });
  }
  box.dataset.renderKey = renderKey;
  host.replaceChildren(box);
  restoreGraph(host, box, before);
  if (focusKey) (host.querySelector(`[data-graph-focus="${focusKey}"]`)
    || (focusTask && host.querySelector(`[data-graph-focus="title-${focusTask}"]`)))?.focus({ preventScroll: true });
}

let pending = null;
export async function loadTaskGraph() {
  const view = ui.view;
  if (!pending) pending = api('/api/worker-graph').finally(() => { pending = null; });
  const graph = await pending;
  if (ui.view === view) {
    ui.taskGraphFetchedAt = Date.now();
    if (!hasPendingInput()) renderTaskGraph(graph);
  }
  return graph;
}
function hasOpenActions() {
  return Boolean($('detail').querySelector('.task-graph-actions-popover[data-open="true"]')
    || (!$('modal').hidden && $('modal').children.length)
    || document.querySelector?.('dialog[open], [popover]:popover-open'));
}
function hasPendingInput() {
  const active = document.activeElement;
  if (active?.isContentEditable || (active && ['INPUT', 'SELECT'].includes(active.tagName)
    && !['checkbox', 'radio', 'button'].includes(active.type))) return true;
  for (const node of $('detail').querySelectorAll('textarea')) {
    if (node.value || node === document.activeElement) return true;
  }
  return false;
}
export async function openTaskGraph() {
  activateDetailView({ view: 'task-graph', hash: '#worker-graph' });
  try { await loadTaskGraph(); }
  catch (error) { if (ui.view?.id === 'task-graph') $('detail').textContent = `Worker 树加载失败：${error.message}`; throw error; }
}
