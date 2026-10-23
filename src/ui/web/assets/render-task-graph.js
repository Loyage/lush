import { $, badge, button, el, roleBadge } from './dom.js';
import { batchDisclosure, disclosureIcon } from './view-controls.js';
import { workerKind, workerKindLabel } from './worker-kind.js';
import { isValet } from './work-type.js';
import { projectBase } from './route.js';
import { graphPage, readTaskGraph, paintGraphStatus, graphTail, observeGraphTail } from './task-graph-loading.js';
import { bindWorkerPreview } from './entity-preview.js';
import { absolute, INTEGRATION, statusOf, interruptReason, worktreeLabel, isHistoricalDelivery } from './format.js';
import { show } from './messages.js';
import { detail } from './navigate.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { devicePreferencesStatus, onDevicePreferences, onPrefChange, readPref, saveDevicePreference, writePref } from './prefs.js';
import { taskForest } from './task-graph-layout.js';
import { resourceSummary } from './task-graph-usage.js';
import { mergeRelations } from './task-graph-merge.js';
import { captureGraph, restoreGraph, graphMotionRunning } from './task-graph-motion.js';
import { branchDiagnostics, decisionRow } from './task-graph-parts.js';
import { graphGitStatus } from './task-graph-git.js';
import { BRANCH_ARCHIVE_HELP, runBranchArchive } from './branch-archive.js';
import { workerDeleteControl } from './worker-delete.js';
import { workerRenameControl } from './worker-rename.js';
import { workerCreateControl, waitingFirstInput, FIRST_INPUT_HELP } from './worker-create.js';
import { progressReportingEnabled, progressStats, renderGraphProgress } from './render-progress.js';
import { deliveryControls } from './render-delivery.js';
import { sourceDelivery } from './delivery-ui.js';
import { deliveryStage } from './delivery-model.js';
import { integrationControl, integrationStatus } from './render-integration.js';
import { workerHooks } from './render-hooks.js';
import { guardedAction, iterationControls } from './render-iteration.js';
import { appendInputBlocker, inputQueueText } from './worker-input.js';
import { appendToWorker } from './composer.js';
import { workerLabel, rememberWorkers } from './worker-label.js';

function syncGraphDevicePreference() {
  if (!globalThis.document) return;
  const input = $('detail')?.querySelector('[data-graph-focus="detail-mode"]'); if (!input) return;
  const device = devicePreferencesStatus();
  input.disabled = !device.ready || device.saving || Boolean(device.error);
  (input.parentElement || input.parentNode)?.setAttribute('data-help', device.saving ? '正在保存设备偏好。'
    : !device.ready || device.error ? `设备偏好当前不可用，不能保存图模式。${device.error || '正在读取权威配置。'}`
      : '勾选后展开 Worker 的目标、结果、进度、分支诊断与操作；取消勾选回到默认的极简双行展示。仅改变显示，所有项目共享设备偏好。');
}
onDevicePreferences(syncGraphDevicePreference);

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
    if (resolving.length) parts.push(`${resolving.length} 条源侧解分歧中（${resolving.map(child => workerLabel(child)).join('、')}）`);
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
  // An audited incomplete acceptance stays visible even if its root was already reclaimed.
  return node.acceptance_recovery !== true && !node.management_attention && (node.branch_info?.archived === true || node.archived === true);
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

/** Keep every delivery stage beside usage; tracking below retains only diagnostics and relations. */
function graphMergeStatus(node) {
  if (node.merge_operation) return integrationStatus(node);
  const summary = node.delivery_summary;
  if (summary && !['pending', 'integrated'].includes(summary.stage))
    return badge(deliveryStage(summary.stage, summary.version), 'b-awaiting');
  const pending = node.reservation?.status === 'pending' && [2, 3].includes(node.reservation.version);
  const state = ['pending', 'integrated'].includes(summary?.stage) ? summary.stage
    : INTEGRATION[node.integration] ? node.integration : pending ? 'pending' : node.integration;
  const label = state === 'pending' ? '未合并' : state === 'integrated' ? '已合并' : INTEGRATION[state];
  return label ? badge(label, ['merged', 'integrated'].includes(state) ? 'b-completed' : 'b-awaiting') : null;
}

function taskCard(node, folded, refresh, queueNote = null, minimal = false, inputWorkers = [], valets = []) {
  const row = el('article', undefined, 'task-graph-card');
  row.dataset.taskId = String(node.id);
  row.classList.add(`task-graph-${taskVisualState(node)}`);
  const head = el('div', undefined, 'task-graph-head');
  if (node.children.length) {
    const toggle = button('', () => {
      if (hasPendingInput()) { show('请先提交或清空正在编辑的待决答复，再折叠 Worker。'); return; }
      if (folded.has(node.id)) folded.delete(node.id); else folded.add(node.id);
      save(folded); refresh();
    }, 'ghost task-graph-fold', { help: `展开或收起 Worker ${workerLabel(node)} 的 ${node.children.length} 条直接子 Worker` });
    toggle.dataset.graphFocus = `fold-${node.id}`;
    const expanded = !folded.has(node.id), caret = el('span');
    disclosureIcon(caret, expanded); toggle.append(caret);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', `${expanded ? '收起' : '展开'} ${workerLabel(node)} 的子 Worker`);
    head.append(toggle);
  }
  const title = button('', () => detail(node.id), 'ghost task-graph-title', { worker: node });
  title.append(el('span', `${workerLabel(node)} ${node.title}`, 'task-graph-link-label'));
  title.dataset.graphFocus = `title-${node.id}`;
  head.append(title, ...(minimal || node.role === 'agent' ? [] : [roleBadge(node.role)]), badge(node.status === 'waiting' && !node.children_active && !interruptReason(node) ? '静息' : statusOf(node).label,
    `b-${node.status}`));
  // 资源消耗紧跟任务状态，排在合并状态标签前面；极简模式的合并标签在第二行，由 minimalSummary 渲染。
  if (!minimal) head.append(resourceSummary(node, folded.has(node.id)));
  const merge = graphMergeStatus(node);
  if (!minimal && merge) head.append(merge);
  if (!minimal && node.task_kind) head.append(badge(node.task_kind === 'merge' ? 'merge（历史）' : workerKindLabel(node)));
  if (!minimal && node.freeze && node.freeze.task_id !== node.id) head.append(badge(node.status === 'running' ? '安全点后冻结' : '冻结', 'warn'));
  if (node.notice_count) head.append(badge(`${node.notice_count} 条待决`, 'b-awaiting'));
  if (!minimal) head.append(taskActionsMenu(node, inputWorkers));
  row.append(head);
  if (!minimal && waitingFirstInput(node)) row.append(el('p', '等待首条输入 · 尚未调用 Agent', 'hint worker-first-input'));
  const tracking = node.merge_operation ? null
    : sourceDelivery(node.delivery_summary, { showStage: false, showInputQueue: false });
  if (tracking) row.append(tracking);
  if (minimal) {
    row.append(minimalSummary(node, queueNote, folded, valets), taskActionsMenu(node, inputWorkers));
    return row;
  }

  const relations = graphRelations(node, valets);
  if (relations) row.append(relations);
  if (node.goal_preview && node.goal_preview !== node.title) row.append(el('p', node.goal_preview, 'task-graph-goal'));
  const interruptHint = interruptReason(node);
  if (interruptHint || node.waiting_reason) row.append(el('p', interruptHint || node.waiting_reason, 'task-graph-reason'));
  if (queueNote) row.append(el('p', queueNote, 'task-graph-reason'));
  const queueText = inputQueueText(node);
  if (queueText) row.append(el('p', queueText, 'hint worker-input-queue'));
  if (node.result_preview) row.append(el('p', `最近结果：${node.result_preview}${node.result_preview.length >= 320 ? '…' : ''}`, 'task-graph-result'));
  if (node.details_unavailable) row.append(el('p', '该 Worker 详情过大，图中详情不可用；请打开 Worker 详情单独读取。', 'hint'));
  else if (node.details_truncated) row.append(el('p', '该 Worker 详情过大，图中摘要已截断；完整内容请打开 Worker 详情。', 'hint'));
  if (node.graph_cached) row.append(el('p', '旧采样缓存，待更新；本轮刷新仅重新读取首批 Worker。', 'hint'));
  const progress = renderGraphProgress(node.progress, { running: node.status === 'running', status: node.status });
  if (progress) row.append(progress);

  const facts = el('div', undefined, 'task-graph-facts');
  if (node.resolves_task_id) facts.append(button(`正在解决 Worker ${workerLabel(node.resolves_task_id)}`, () => detail(node.resolves_task_id), 'ghost',
    { worker: node.resolves_task_id }));
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
  if (node.delivery?.blocked_reason) facts.append(badge('历史合并异常', 'warn'));
  if (node.has_rule) facts.append(badge('固定输入规则'));
  if (node.children_total) facts.append(el('span', `子 Worker：${node.children_total}${node.children_active ? `（${node.children_active} 活动）` : ''}`, 'meta'));
  if (Number.isInteger(node.calls) && node.calls) facts.append(el('span', `Agent 调用 ${node.calls} 次`, 'meta'));
  if (node.created_at) facts.append(el('span', `创建 ${absolute(node.created_at)}`, 'meta'));
  if (node.updated_at) facts.append(el('span', `更新 ${absolute(node.updated_at)}`, 'meta'));
  row.append(facts);
  if (node.integration_error) row.append(el('p', `集成受阻：${node.integration_error}`, 'hint'));
  if (workerKind(node) !== 'order' && node.delivery?.blocked_reason) row.append(el('p', `历史合并受阻：${node.delivery.blocked_reason}`, 'hint'));
  if (node.parent_id && !ui.taskGraphIds?.has(node.parent_id)
    && (!Object.hasOwn(node, 'layout_parent_id') || node.layout_parent_id === node.parent_id)) {
    row.append(el('p', `父 Worker ${workerLabel(node.parent_id)} 不在当前图中`, 'hint'));
  }

  if (node.branch_info && !node.branch_info.archived) {
    const branch = node.branch_info;
    const git = el('section', undefined, 'task-graph-git');
    const header = el('div', '分支诊断', 'task-graph-git-head');
    if (branch.current_head) header.append(el('span', `HEAD ${branch.current_head.slice(0, 12)}`, 'mono'));
    else header.append(el('span', node.details_pending ? 'Git 诊断加载中…' : '当前分支 ref 不可用', node.details_pending ? 'meta' : 'warn'));
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

  if (node.execution_retired !== true && node.notice && !isHistoricalDelivery(node)) {
    if (['question', 'plan'].includes(node.notice.kind)) {
      // Inline decisions refresh this Task view after a response.
      const decision = decisionRow(node, loadTaskGraph);
      if (node.notice.body?.length >= 1000) decision.append(el('p', '正文仅显示前 1000 字；完整内容请打开 Worker 详情。', 'hint'));
      row.append(decision);
    } else {
      const pending = el('div', undefined, 'graph-decision');
      pending.append(el('strong', node.notice.title || '等待你回答问卷'),
        el('p', '这条待决事项需要在 Worker 详情完成问卷；图中不会把选项误当作普通文字答复。', 'hint'),
        button('打开待决事项', () => detail(node.id), 'ghost', { worker: node }));
      row.append(pending);
    }
  }
  appendTaskActions(row, node, inputWorkers);
  return row;
}

function archiveControl(node) {
  if (node.execution_retired === true) return null;
  const branch = node.branch_info;
  const cleanable = !['order', 'child'].includes(workerKind(node)) || ['failed', 'cancelled'].includes(node.status)
    || (node.status === 'completed' && node.accepted !== true);
  if (!branch || branch.archived || !branch.archivable || isHistoricalDelivery(node) || !cleanable) return null;
  return button('清理资源', () => runBranchArchive({ name: node.branch, subtreeBranches: branch.subtree_branches },
    { refresh: loadTaskGraph }), 'ghost', { help: BRANCH_ARCHIVE_HELP });
}

// 完整卡片和极简浮层共用同一套准入、确认、Agent 标识与 RPC，不复制业务规则。
function appendTaskActions(row, node, inputWorkers) {
  if (node.execution_retired === true) {
    row.append(el('p', '远端执行已退役，仅保留只读历史与固定提交；不会续跑、迁移或回收远端资源。', 'hint execution-retired'));
    return;
  }
  const iteration = iterationControls(node, { refresh: loadTaskGraph });
  if (iteration) row.append(iteration);
  const controls = deliveryControls(node, { refresh: loadTaskGraph, showTracking: false, showMerged: false, showPending: false, showStage: !node.delivery_summary });
  if (controls) row.append(controls);
  const hooks = workerHooks(node, { compact: true, refresh: loadTaskGraph });
  if (hooks) row.append(hooks);
  const deletion = workerDeleteControl(node, { refresh: loadTaskGraph });
  if (deletion) row.append(deletion);
  if (['order', 'child'].includes(workerKind(node)) && !ENDED.has(node.status) && !isHistoricalDelivery(node)) {
    row.append(guardedAction(button(waitingFirstInput(node) ? '输入工作指令' : '追加输入', () => appendToWorker(node), 'ghost', {
      help: waitingFirstInput(node) ? FIRST_INPUT_HELP : '展开向该 Worker 追加输入的独立编辑；其他去向的文字保留在本页，不会随切换改投。现在不发送、不调用 Agent。冻结期间提交的追加指令可靠入箱，不打断在途合并或源侧修复，解除冻结且 Agent 静息后投递；暂停中仍需点「开始 / 继续」。',
    }), appendInputBlocker(node, inputWorkers)));
  }
}

function minimalSummary(node, queueNote, folded = new Set(), valets = []) {
  const line = el('div', undefined, 'task-graph-minimal-summary');
  const reporting = progressReportingEnabled();
  const stats = progressStats(reporting ? node.progress : null);
  const count = stats.total ? `${stats.completed}/${stats.total}` : '';
  const stopped = { failed: '失败时中止', cancelled: '取消时中止', completed: '结束时未完成' }[node.status];
  const step = stats.current ? `${stats.current.label}${stopped ? ` · ${stopped}` : ''}`
    : stats.total ? '计划已全部完成' : reporting && node.status === 'running' ? '等待 Agent 汇报计划' : '';
  const waiting = ['waiting', 'awaiting', 'awaiting_acceptance', 'paused', 'queued'].includes(node.status);
  const interruptHint = interruptReason(node);
  const note = (waitingFirstInput(node) ? '等待首条输入 · 尚未调用 Agent' : null) || interruptHint || (node.integration_error ? `集成受阻：${node.integration_error}`
    : waiting && node.waiting_reason ? node.waiting_reason : queueNote || step);
  const text = el('span', [count, note].filter(Boolean).join(' · '), 'task-graph-minimal-note');
  const relations = graphRelations(node, valets);
  const progress = el('div', undefined, 'task-graph-minimal-progress');
  const git = graphGitStatus(node);
  if (git) progress.append(git);
  if (valets.length && interruptHint) relations.prepend(text);
  progress.append(valets.length ? relations : interruptHint ? text : relations || text);
  line.append(progress);
  // Desktop keeps these inline; mobile gives progress and metadata separate rows.
  const meta = el('div', undefined, 'task-graph-minimal-meta');
  if (node.details_unavailable) meta.append(badge('详情过大不可用', 'warn'));
  else if (node.details_truncated) meta.append(badge('详情已截断', 'warn'));
  if (node.graph_cached) meta.append(badge('旧采样 · 待更新'));
  if (node.freeze && node.freeze.task_id !== node.id) meta.append(badge(node.status === 'running' ? '安全点后冻结' : '冻结', 'warn'));
  if (isArchivedTask(node)) meta.append(badge('已归档'));
  const queueText = inputQueueText(node);
  if (queueText) {
    const queue = badge(`待接收追加 ${node.input_queue.buffered} 条`, 'b-awaiting worker-input-queue');
    queue.setAttribute('data-help', queueText); queue.setAttribute('aria-label', queueText); queue.tabIndex = 0;
    meta.append(queue);
  }
  // 资源消耗排在合并状态标签前面；收拢时这里显示的是整棵子树的合计。
  meta.append(resourceSummary(node, folded.has(node.id)));
  const merge = graphMergeStatus(node);
  if (merge) meta.append(merge);
  line.append(meta);
  return line;
}

/** 原生非模态 popover：在顶层浮动，不受树横向滚动裁切；Esc / 外部点击由浏览器收起。
 * 普通按钮组而非 ARIA menu：复用控件内含说明与禁用帮助，Tab 按文档顺序可达。 */
function taskActionsMenu(node, inputWorkers) {
  const wrap = el('div', undefined, 'task-graph-more');
  const panel = el('section', undefined, 'task-graph-actions-popover');
  panel.id = `task-graph-actions-${node.id}`;
  panel.setAttribute('popover', 'auto');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', `Worker ${workerLabel(node)} 更多操作`);
  const trigger = el('button', undefined, 'ghost task-graph-more-trigger');
  const label = el('span', '⋯', 'task-graph-more-label');
  label.setAttribute('aria-hidden', 'true');
  trigger.append(label);
  trigger.type = 'button';
  trigger.setAttribute('popovertarget', panel.id);
  bindWorkerPreview(trigger, node);
  // Reopening the menu must retain an in-flight confirmation or accepted request.
  let integrate;
  trigger.onclick = () => {
    if (panel.dataset.open === 'true') return;
    const heading = el('strong', `${workerLabel(node)} ${node.title}`, 'task-graph-actions-title');
    const close = button('关闭', () => panel.hidePopover(), 'ghost');
    close.setAttribute('autofocus', '');
    panel.replaceChildren(heading, close, button('打开 Worker 详情', () => detail(node.id), 'ghost', { worker: node }),
      ...(node.execution_retired === true ? [] : [workerRenameControl(node, { refresh: loadTaskGraph })]));
    const childCreate = workerCreateControl(node); if (childCreate) panel.append(childCreate);
    if (node.notice) panel.append(button('打开待决事项', () => detail(node.id), 'ghost',
      { worker: node }));
    const queueText = inputQueueText(node);
    if (queueText) panel.append(el('p', queueText, 'hint worker-input-queue'));
    if (['main', 'owner'].includes(workerKind(node)) || node.children.length || node.children_total) {
      integrate ??= integrationControl(node, { refresh: loadTaskGraph });
      if (integrate) panel.append(integrate);
    }
    appendTaskActions(panel, node, inputWorkers);
    const archive = archiveControl(node);
    if (archive) panel.append(archive);
  };
  // 先关闭顶层浮层并恢复触发焦点，再让业务按钮打开原有确认 / 输入弹窗。
  panel.addEventListener('click', event => {
    const button = event.target.closest?.('button');
    if (button && !button.disabled) panel.hidePopover();
  }, { capture: true });
  trigger.dataset.graphFocus = `more-${node.id}`;
  trigger.setAttribute('aria-label', `Worker ${workerLabel(node)} 更多操作`);
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

/** Reuse compact merge-target links, without a management panel. */
function graphRelations(node, valets = []) {
  let line = mergeRelations(node);
  if (!valets.length) return line;
  line ||= el('div', undefined, 'task-graph-merge-relations');
  line.classList.add('task-graph-has-valets');
  for (const valet of valets) {
    const link = button('', () => detail(valet.id), 'ghost task-graph-merge-link task-graph-valet-link', { worker: valet });
    link.append(el('span', `Valet ${workerLabel(valet)} · 运行中`, 'task-graph-link-label'));
    link.dataset.valetId = String(valet.id);
    link.dataset.graphFocus = `valet-${valet.id}`;
    line.append(link);
  }
  line.setAttribute('aria-label', '合并关系与运行中的 Valet');
  return line;
}

export function renderTaskGraph(graph) {
  if (ui.view?.id !== 'task-graph') return;
  if (hasOpenActions() || hasPendingInput() || window.getSelection?.()?.toString()
    || graphMotionRunning($('detail').querySelector('.task-graph'))) return;
  const minimal = ui.taskGraphMinimal;
  const records = (graph.nodes || []).filter(node => !ui.deletedWorkerIds.has(node.id));
  const raw = records.filter(node => !isValet(node));
  const runningValets = records.filter(node => isValet(node) && node.status === 'running' && !isArchivedTask(node) && !node.graph_cached);
  // A filtered/paged-out main remains a labelled anchor, not a development card.
  const main = graph.project_main || raw.find(node => node.task_kind === 'main' && node.branch === 'main');
  rememberWorkers(records);
  for (const node of raw) rememberWorkers(node.merge_queue?.items);
  const byId = new Map(raw.map(node => [node.id, node]));
  // merge 与其它 Task 一视同仁：画不画由表头的状态开关决定，不再按队列活跃度整层收起。
  const visible = new Set(raw.filter(node => VISIBLE_KINDS.has(workerKind(node))).map(node => node.id));
  // 被筛掉的中间 Task 不制造孤儿：父指到最近的可见祖先，所以归档 / 状态筛选藏起来的父 Task 不会把子 Task 一起带走。
  // 祖先都不在这一页（被截断 / 真的缺节点）时保留原 parent_id，照旧画成根并写明「父 Task 不在当前图中」。
  const parentInView = node => {
    if (Object.hasOwn(node, 'layout_parent_id')) return node.layout_parent_id;
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
  const archivedCount = graph.archived_count ?? all.filter(isArchivedTask).length;
  const listed = ui.taskGraphShowArchived ? all : all.filter(node => !isArchivedTask(node));
  // 状态计数用筛选前的口径：关掉一个状态后它的开关还得留在表头上，否则再也点不回来。
  const counts = new Map(Object.entries(graph.counts || {}));
  if (!graph.counts) for (const node of listed) counts.set(node.status, (counts.get(node.status) || 0) + 1);
  const hidden = hiddenStatuses();
  const nodes = listed.filter(node => !hidden.has(node.status));
  const view = { ...full, nodes };
  const host = $('detail');
  const saved = collapsed();
  // Polls often return identical bounded data. Preserve DOM identity and reading state
  // unless content, local display preferences, the deletion filter or the layout width changed.
  // A stale graph response can still list a just-deleted subtree, so the filter set is part of the key.
  const renderKey = JSON.stringify([graph, minimal, [...saved].sort(), [...hidden].sort(),
    ui.taskGraphShowArchived, ui.taskGraphLocator, [...ui.taskGraphFilesExpanded].sort(), host.clientWidth,
    [...ui.deletedWorkerIds].sort((a, b) => a - b)]);
  if (host.querySelector('.task-graph')?.dataset.renderKey === renderKey) return;
  const before = captureGraph(host);
  const forest = taskForest(view);
  // 用 all 而不是 nodes：可见子 Task 的父 Task 可能只是被归档藏起来，不该被说成「不在当前图中」。
  ui.taskGraphIds = new Set(all.map(node => node.id));
  const focusKey = document.activeElement?.dataset?.graphFocus;
  const focusTask = document.activeElement?.closest?.('.task-graph-card')?.dataset.taskId;
  const box = el('div', undefined, `task-graph${minimal ? ' task-graph-minimal' : ''}`);
  const hero = el('header', undefined, 'resource-hero task-graph-hero');
  hero.append(el('h1', '开发树'));
  const summary = el('div', undefined, 'task-graph-summary');
  const decisions = nodes.reduce((count, node) => count + (node.notice_count || 0), 0);
  // 状态计数本身兼作图例与开关：点一下隐藏 / 显示该状态，只改显示、不写库、不改任务状态。
  for (const status of STATUS_ORDER) {
    const count = counts.get(status) || 0;
    if (!count) continue;
    const info = statusOf({ status });
    const off = hidden.has(status);
    const toggle = button(`${info.icon} ${info.label} ${count}`, () => {
      if (readingProtected()) { show('请先结束编辑、选区或弹层操作，再切换状态筛选。'); return; }
      const next = hiddenStatuses();
      if (next.has(status)) next.delete(status); else next.add(status);
      saveHiddenStatuses(next);
      return reloadGraphFilters(full);
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
    if (readingProtected()) { show('请先结束编辑、选区或弹层操作，再切换状态筛选。'); return; }
    saveHiddenStatuses(new Set());
    return reloadGraphFilters(full);
  }, 'ghost task-graph-status-reset', { help: '清除状态筛选，重新显示所有状态的 Worker。' }));
  if (decisions) summary.append(badge(`${decisions} 待决`, 'b-awaiting'));
  if (archivedCount) {
    const toggle = button(`已回收 ${archivedCount}`, async () => {
      if (readingProtected()) {
        show('请先提交或清空正在编辑的待决答复，再切换归档显示。');
        return;
      }
      ui.taskGraphShowArchived = !ui.taskGraphShowArchived;
      await reloadGraphFilters(full);
      host.querySelector('[data-graph-focus="show-archived"]')?.focus({ preventScroll: true });
    }, 'badge task-graph-status-toggle task-graph-archived-toggle', {
      help: '点击切换已回收历史的显隐，包含验收即归档或显式清理资源后保留的 Worker 运行历史，以及随父 Worker 归档的历史内部合并队列。资源回收不等于工作成功，也不等于删除运行记录；这里只改变当前页面显示，不写库、不改 Worker 状态，重开页面仍默认隐藏。',
    });
    toggle.dataset.graphFocus = 'show-archived';
    toggle.setAttribute('aria-pressed', String(ui.taskGraphShowArchived));
    if (!ui.taskGraphShowArchived) toggle.classList.add('is-off');
    summary.append(toggle);
  }
  const mode = el('label', undefined, 'task-graph-mode');
  const checkbox = el('input');
  checkbox.type = 'checkbox';
  checkbox.checked = !minimal;
  checkbox.dataset.graphFocus = 'detail-mode';
  checkbox.onchange = async () => {
    if (hasPendingInput()) {
      checkbox.checked = !minimal;
      show('请先提交或清空正在编辑的待决答复，再切换显示模式。');
      return;
    }
    const identity = ui.view; checkbox.disabled = true;
    try {
      await saveDevicePreference('taskGraphMinimal', !checkbox.checked);
      if (ui.view !== identity || hasPendingInput()) return;
      renderTaskGraph(full);
      host.querySelector('[data-graph-focus="detail-mode"]')?.focus({ preventScroll: true });
    } catch (error) {
      if (ui.view === identity) { checkbox.checked = !readPref('taskGraphMinimal'); show(`显示偏好未保存：${error.message}`, 'error'); }
    } finally { syncGraphDevicePreference(); }
  };
  mode.append(checkbox, el('span', '详情模式'));
  mode.classList.add('help-host'); mode.tabIndex = 0;
  mode.setAttribute('data-help', '勾选后展开 Worker 的目标、结果、进度、分支诊断与操作；取消勾选回到默认的极简双行展示。仅改变显示，所有项目共享设备偏好。');
  checkbox.disabled = !devicePreferencesStatus().ready || devicePreferencesStatus().saving || Boolean(devicePreferencesStatus().error);
  // Include descendants hidden by a folded ancestor, but keep filtered/archived
  // branches outside this view unchanged. Use the same safe forest as the cards.
  const branches = [], pendingBranches = [...forest];
  while (pendingBranches.length) {
    const node = pendingBranches.pop();
    if (node.children.length) { branches.push(node.id); pendingBranches.push(...node.children); }
  }
  const bulkFold = folded => {
    if (hasPendingInput()) {
      show('请先提交或清空正在编辑的待决答复，再批量展开或折叠 Worker。');
      return;
    }
    const next = collapsed();
    for (const id of branches) { if (folded) next.add(id); else next.delete(id); }
    save(next); renderTaskGraph(full);
  };
  const foldControls = el('div', undefined, 'task-graph-fold-controls');
  foldControls.setAttribute('role', 'group'); foldControls.setAttribute('aria-label', '开发树展开与折叠');
  const foldControl = batchDisclosure({ getItems: () => branches, isExpanded: id => !saved.has(id), setExpanded: open => bulkFold(!open),
    scope: '作用于当前已加载且符合筛选的全部子 Worker 层级，含被祖先收起的层级；未加载层级不受影响。保留筛选、归档显示与详情模式，不改变 Worker 状态或调用 Agent。',
    empty: '当前筛选范围没有可展开或收起的子 Worker 层级。' });
  foldControl.button.dataset.graphFocus = 'toggle-all'; foldControls.append(foldControl.root);
  hero.append(summary, mode, foldControls, button('刷新', () => loadTaskGraph({ retry: true }).catch(graphFailure), 'ghost'),
    el('p', undefined, 'hint task-graph-load-status'));
  box.append(hero);
  if (ui.taskGraphLocator) box.append(el('p', '正在定位来源 Worker；若被折叠或筛选隐藏，请展开或调整显示。尚未读到不表示不存在。', 'hint graph-locator-status'));
  if (view.truncated && typeof view.has_more !== 'boolean') box.append(el('p', `只显示最近及活动的 ${nodes.length} / ${graph.total} 条 Worker；父节点可能在截断范围外。`, 'hint'));
  const paint = (node, parent) => {
    const wrap = el('div', undefined, 'task-graph-node');
    const card = taskCard(node, saved, () => renderTaskGraph(full), mergeQueue.get(node.id) ?? null, minimal, raw,
      node.id === main?.id ? runningValets : []);
    wrap.append(card);
    if (node.children.length && !saved.has(node.id)) {
      const children = el('div', undefined, 'task-graph-children');
      for (const child of node.children) paint(child, children);
      wrap.append(children);
    }
    parent.append(wrap);
  };
  if (main && !nodes.some(node => node.id === main.id) && runningValets.length) {
    const anchor = el('section', undefined, 'project-main-anchor');
    anchor.append(button(`${workerLabel(main)} ${main.title || 'main'}`, () => detail(main.id), 'nav-link', { worker: main }),
      el('p', 'main 开发节点在当前筛选或分页之外。', 'hint'), graphRelations(main, runningValets));
    box.append(anchor);
  }
  for (const node of forest) paint(node, box);
  if (typeof graph.has_more === 'boolean') box.append(graphTail(loadNextTaskGraph));
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
  paintGraphStatus(); syncGraphDevicePreference();
  restoreGraph(host, box, before);
  if (focusKey) (host.querySelector(`[data-graph-focus="${focusKey}"]`)
    || (focusTask && host.querySelector(`[data-graph-focus="title-${focusTask}"]`)))?.focus({ preventScroll: true });
  observeGraphTail(loadNextTaskGraph, readingProtected);
  if (ui.taskGraphLocator) {
    const card = host.querySelector(`[data-task-id="${ui.taskGraphLocator}"]`) || host.querySelector(`[data-valet-id="${ui.taskGraphLocator}"]`);
    const status = host.querySelector('.graph-locator-status');
    if (card) {
      status.textContent = '已定位来源 Worker（真实开发父子关系未改变）'; card.classList.add('delivery-located');
      if (!ui.taskGraphLocated) { card.scrollIntoView?.({ block: 'nearest' }); ui.taskGraphLocated = true; }
    } else status.textContent = graph.has_more ? '来源 Worker 尚未在已读且可见范围；可继续加载分页，或展开 / 调整筛选。' : '已读范围未显示来源 Worker；可能已归档、筛选或折叠。不能据此认定不存在。';
  }
}

function graphFailure(error) {
  show(`开发树更新失败：${error.message}`, 'error');
}
export async function loadTaskGraph(options = {}) {
  const view = ui.view;
  const graph = await readTaskGraph(options);
  if (graph && ui.view === view && ui.taskGraphPage?.graph === graph) renderTaskGraph(graph);
  return graph;
}

function readingProtected() {
  return hasPendingInput() || hasOpenActions() || Boolean(window.getSelection?.()?.toString())
    || graphMotionRunning($('detail').querySelector('.task-graph'));
}

export async function loadNextTaskGraph() {
  if (ui.view?.id !== 'task-graph' || readingProtected()) return;
  try { return await loadTaskGraph({ next: !(ui.taskGraphPage?.nextError && !ui.taskGraphPage?.hasMore), retry: true }); }
  catch { /* The inline tail preserves the cursor and offers an explicit retry. */ }
}

async function reloadGraphFilters(previous = ui.taskGraphPage?.graph) {
  const view = ui.view;
  const page = graphPage();
  // Keep full-range filter controls while dropping the old filter's node bodies.
  if (!page.graph && previous) {
    renderTaskGraph({ ...previous, nodes: [], has_more: false, cursor: null, details_pending: true });
  }
  try {
    const graph = await loadTaskGraph({ summary: true });
    if (graph && ui.view === view && graph.details_pending) {
      void loadTaskGraph().catch(error => { if (ui.view === view) graphFailure(error); });
    }
  } catch (error) { if (ui.view === view) graphFailure(error); }
}

onPrefChange('taskGraphStatuses', () => {
  // Settings reset and externally applied preferences invalidate even unmounted caches.
  if (!globalThis.document || !ui.taskGraphPage) return;
  const previous = ui.taskGraphPage.graph, view = ui.view;
  graphPage();
  if (view?.id === 'task-graph') void reloadGraphFilters(previous);
});
function hasOpenActions() {
  return Boolean($('detail').querySelector('.hook-compact[data-completion-editing="true"]')
    || $('detail').querySelector('.task-graph-actions-popover[data-open="true"]')
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
export async function openTaskGraph({ workerId = null, push = true } = {}) {
  if (ui.view?.id !== 'task-graph') ui.taskGraphShowArchived = false;
  ui.taskGraphLocator = workerId; ui.taskGraphLocatorBase = projectBase(); ui.taskGraphLocated = false;
  const view = activateDetailView({ view: 'task-graph', hash: `#worker-graph${workerId ? `-worker-${workerId}` : ''}`, push });
  const page = graphPage();
  if (page.graph) {
    renderTaskGraph(page.graph);
    // The cache paints synchronously; never make reopening wait for Git diagnostics.
    observeGraphTail(loadNextTaskGraph, readingProtected);
    if (Date.now() - page.fetchedAt >= 3000 || page.graph.details_pending) {
      void loadTaskGraph().catch(error => { if (ui.view === view) graphFailure(error); });
    }
    return;
  }
  try {
    const graph = await loadTaskGraph({ summary: true });
    if (ui.view === view && graph?.details_pending) {
      void loadTaskGraph().catch(error => { if (ui.view === view) graphFailure(error); });
    }
  } catch (error) {
    if (ui.view === view) $('detail').textContent = `开发树加载失败：${error.message}`;
    throw error;
  }
}
