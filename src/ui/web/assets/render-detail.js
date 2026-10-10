import { $, badge, block, button, el, kv, roleBadge, routeBadge, statusBadge } from './dom.js';
import { workerKind } from './worker-kind.js';
import { action, withReadSignal } from './api.js';
import { confirmDialog } from './dialog.js';
import { appendToWorker } from './composer.js';
import { configureTask, retryTask } from './retry-dialog.js';
import { clearOverrideControl, modelSourceSummary } from './worker-model-source.js';
import { workerRenameControl } from './worker-rename.js';
import { INTEGRATION, ROLE, TERMINAL_STATUS, absolute, duration, edgeLabel, relative, resolverOf, runWorkMs, statusOf, interruptReason, taskTitle, worktreeLabel, isHistoricalDelivery } from './format.js';
import { agentHelp } from './help.js';
import { freezeBlocker } from './merge-select.js';
import { show } from './messages.js';
import { detail, overview } from './navigate.js';
import { renderAgent } from './render-agent.js';
import { renderConversation } from './render-conversation.js';
import { disposeDetailModules, limitDetailModules } from './detail-preview.js';
import { captureDetailReading, restoreDetailReading } from './detail-reading.js';
import { linkWorkerNumbers } from './worker-links.js';
import { renderDiff } from './render-diff.js';
import { deliveryControls } from './render-delivery.js';
import { workerHooks } from './render-hooks.js';
import { guardedAction, iterationControls } from './render-iteration.js';
import { appendInputBlocker, inputQueueText } from './worker-input.js';
import { renderHistory } from './render-history.js';
import { renderTaskMessage } from './render-task-message.js';
import { formatProgressDuration, renderTaskProgress } from './render-progress.js';
import { renderProgressHistory } from './render-progress-history.js';
import { noticePanel } from './render-notices.js';
import { settledDecision } from './choice-snapshot.js';
import { renderResolutions } from './render-resolutions.js';
import { specItem } from './render-specs.js';
import { renderVerifications } from './render-verify.js';
import { BRANCH_ARCHIVE_HELP, runBranchArchive } from './branch-archive.js';
import { workerDeleteControl } from './worker-delete.js';
import { ui } from './state.js';
import { agentText } from './text.js';
import { referenceable } from './context-references.js';
import { inputNumber } from './format.js';
import { workerLabel, rememberWorkers } from './worker-label.js';

const progressivePanels = new WeakMap();
const readingHandlers = new WeakMap();
const freezeOf = task => freezeBlocker(task.target_branch, task, ui.lastSnapshot?.status?.merge_freeze || []);
/** 任务依赖：本任务等谁、谁在等它。 */
function renderDeps(task) {
  const section = block('Worker 依赖');
  section.append(el('p', task.deps?.length ? `本 Worker 等这些结算：${task.deps.map(edgeLabel).join('、')}` : '本 Worker 不依赖其他 Worker。', 'hint'));
  section.append(el('p', task.dependents?.length ? `这些 Worker 在等它：${task.dependents.map(edgeLabel).join('、')}` : '没有 Worker 在等它。', 'hint'));
  return section;
}
/** planner 这一轮写下的拆解 / scheduler 这一批取走的 spec：只读，和左侧队列同一套行。 */
function renderTaskSpecs(task) {
  const specs = task.specs || [];
  const section = block('拆解队列', String(specs.length));
  section.append(el('p', task.role === 'scheduler'
    ? '本 Worker 这一批取走的 spec：每一条都要有归宿——spawn 成 Worker，或明确丢弃。'
    : '这一轮写下的拆解（等 scheduler 编排）：scheduler 会把它们一次性编排成真实 Worker，批内没有依赖边的会同时开工。', 'hint'));
  if (!specs.length) section.append(el('p', '这一批是空的。', 'hint'));
  for (const spec of [...specs].sort((a, b) => a.id - b.id)) section.append(specItem(spec));
  return section;
}
/** 详情头部的意图编号（inputs.id）：点开对应意图的 planner 详情。
 *  input_id 为空（如 scheduler）就不显示，免得出现「意图 #null」；对不上意图或它还没有 planner 任务时退化成不可点的普通 badge。 */
function intentBadge(task) {
  const inputId = task.input_id;
  if (inputId === null || inputId === undefined) return null;
  const intent = (ui.lastSnapshot?.inputs || []).find(row => row.id === inputId) || null;
  const node = intent?.task_id ? button(`输入 ${inputNumber(inputId)}`, () => { ui.noticeFocus = null; return detail(intent.task_id); }, 'badge b-neutral') : badge(`输入 ${inputNumber(inputId)}`, 'b-neutral');
  if (intent?.content) node.title = String(intent.content).slice(0, 200);
  if (intent?.task_id) {
    node.classList.add('intent-link');
    node.title = `${node.title ? `${node.title}\n` : ''}点开看这条意图的规划与拆解`;
    node.onclick = () => { ui.noticeFocus = null; return detail(intent.task_id); };
  }
  return node;
}
export function renderDetail(task, history, diff, usage, connections = null, progressive = null) {
  workerLabel(task); rememberWorkers(task.children); rememberWorkers(task.deps); rememberWorkers(task.dependents);
  const panel = $('detail');
  const ownerDocument = globalThis.document;
  progressivePanels.get(panel)?.dispose();
  progressivePanels.delete(panel);
  const sameTask = panel.dataset.taskId === String(task.id);
  const previousConversation = sameTask ? panel.querySelector('.conversation-panel') : null;
  const previousProgressHistory = sameTask ? panel.querySelector('.progress-history-panel') : null;
  const previousDiff = sameTask ? panel.querySelector('.detail-diff') : null;
  const historyFocus = previousProgressHistory && [...previousProgressHistory.querySelectorAll('summary'), ...previousProgressHistory.querySelectorAll('button')]
    .find(node => node === document.activeElement);
  const readingPosition = sameTask ? captureDetailReading(panel) : null;
  const previousHooks = sameTask ? panel.querySelector('.worker-hooks[data-hook-editing="true"]') || panel.querySelector('.worker-hooks[data-completion-editing="true"]') : null;
  const hookManagementOpen = sameTask && panel.querySelector('.hook-management')?.open === true;
  const previousMessages = new Map(sameTask ? [...panel.querySelectorAll('.task-message')].map(node => [node.dataset.messageId, node]) : []);
  const previousDecisions = new Map(sameTask ? [...panel.querySelectorAll('.decision-record')].map(node => [node.dataset.noticeId, node]) : []);
  panel.dataset.view = 'task'; panel.dataset.taskId = String(task.id); panel.replaceChildren();
  referenceable(panel, { kind: 'task', target: { task_id: task.id }, label: `Worker ${workerLabel(task)}`,
    quote: `${task.goal}\n状态：${statusOf(task).label} · ${ROLE[task.role] || task.role}`, location: { view: 'task-detail', task_id: task.id } });
  const breadcrumb = el('div', undefined, 'breadcrumb');
  breadcrumb.append(button('项目概览', () => overview(), 'link'), el('span', '/'), el('span', `${task.role === 'agent' ? 'Worker' : ROLE[task.role] || task.role} ${workerLabel(task)}`));
  panel.append(breadcrumb);
  const hero = el('div', undefined, 'task-hero');
  const head = el('div', undefined, 'head');
  head.append(el('span', workerLabel(task), 'tid-lg'), statusBadge(task),
    ...(task.role === 'agent' ? [] : [roleBadge(task.role)]), ...(task.route ? [routeBadge()] : []), intentBadge(task));
  const management = task.role === 'manager' || task.task_kind === 'management';
  const integration = management ? null : INTEGRATION[task.integration];
  if (integration) head.append(badge(integration, task.integration === 'merged' ? 'b-completed' : 'b-awaiting'));
  if (task.task_kind === 'analysis') head.append(badge('只读分析', 'b-neutral'));
  if (task.agent) head.append(badge(`agent ${task.agent.id}${task.agent.active ? ` · pid ${task.agent.pid ?? '待上报'}` : ' · 空闲'}`, 'b-neutral'));
  hero.append(head, el('h1', taskTitle(task), 'task-title')); panel.append(hero);

  const readOnly = management || isHistoricalDelivery(task);
  if (management) panel.append(el('p', '管理指令详情只读：查看指令、结果、历史与执行过程。绑定启停仅在自动化页面管理；不在这里开始、调整开发运行设置、追加输入、合并、验收或删除。', 'hint management-readonly'));
  const notice = ui.noticeFocus === null ? null : ui.noticeIndex.get(ui.noticeFocus);
  if (!readOnly && notice && notice.task_id === task.id) panel.prepend(noticePanel(notice, task));

  const actions = el('div', undefined, 'actions task-actions');
  if (!readOnly && ['order','child'].includes(workerKind(task)) && !TERMINAL_STATUS.has(task.status)) {
    const help = '将底部输入框切换为向该 Worker 追加输入，并保留已输入的正文；现在不发送、不调用 Agent。冻结期间发送的输入由 Worker 保存，解除冻结且 Agent 静息后投递；暂停中仍需点「开始 / 继续」。';
    actions.append(guardedAction(button('向该 Worker 追加输入', () => appendToWorker(task), undefined, { help }), appendInputBlocker(task)));
  }
  if (!readOnly) actions.append(workerRenameControl(task, { refresh: () => detail(task.id) }));
  const queueText = inputQueueText(task);
  if (queueText) panel.append(el('p', queueText, 'hint worker-input-queue'));
  const stacked = (task.deps || []).filter(edge => edge.kind === 'code');
  const freeze = freezeOf(task);
  const resolver = resolverOf(task);
  const deliveryItem = (ui.lastSnapshot?.ladder?.groups || []).flatMap(group => group.items || []).find(item => item.id === task.id) || null;
  if (!readOnly && !task.task_kind && freeze) {
    // 同一目标分支上有没解决的冲突：这里点合并只会失败，所以禁用并指向那个任务。
    const node = button('合并已被冻结', () => {}, 'ghost');
    node.disabled = true;
    // 禁用的按钮不派发指针事件，data-help 放外层 span.help-host。
    const host = el('span', undefined, 'help-host');
    host.setAttribute('data-help', `${workerLabel(freeze.task_id)} 的合并冲突还没解决：先处理它的待决问题（或让它的解冲突 Worker 作废），${task.target_branch} 上的合并才能继续。`);
    host.append(node);
    actions.append(host);
  } else if (!readOnly && !task.task_kind && task.status === 'completed' && ['pending', 'review', 'conflict'].includes(task.integration)) {
    const live = resolver && !TERMINAL_STATUS.has(resolver.status);
    const readyResolver = resolver && resolver.status === 'completed' && ['pending', 'review'].includes(resolver.integration)
      && deliveryItem?.phase !== 'resolution_stale';
    const retry = task.integration === 'conflict';
    const label = readyResolver ? `审阅并落地解冲突结果 ${workerLabel(resolver)}` : live ? `解冲突 Worker ${workerLabel(resolver)} 进行中`
      : retry ? '重新尝试合并' : task.integration === 'review' ? '检查后重新批准合并' : '批准合并';
    const node = button(label, async () => {
      if (readyResolver) return detail(resolver.id);
      const caveats = [];
      if (stacked.length) caveats.push(`本 Worker stacked 在 ${stacked.map(edge => workerLabel(edge)).join('、')} 之上，必须先合并上游，否则会把它的改动一起带进来。`);
      if (task.resolves_task_id) caveats.push('这是解冲突 Worker：落地用 --ff-only，落地的树就是它测过的那棵树。');
      if (resolver) caveats.push(`解冲突 Worker ${workerLabel(resolver)} 还没落地：重新尝试会明确废弃它（分支与目录仍保留）。`);
      const confirmed = await confirmDialog({
        title: retry ? `重新尝试把 ${task.branch} 合并到 ${task.target_branch}？` : `将 ${task.branch} 合并到 ${task.target_branch}？`,
        message: retry ? '如果还冲突，会再开一轮解冲突 Worker。请先审阅代码和测试结果。' : '请先审阅代码和测试结果。',
        detail: caveats.join('\n\n') || null,
        confirmLabel: retry ? '重新尝试' : '合并',
      });
      if (!confirmed) return;
      const result = await action('worker.merge', { id: task.id });
      if (result?.merge?.status === 'conflict') show(`合并冲突：已开解冲突 Worker ${workerLabel(result.merge.resolution_task_id)}，请处理左侧的待决问题（${task.target_branch} 上的其它合并已冻结）。`, 'error');
      else if (result?.merge?.status === 'resolved') show(`冲突已解决：原 Worker ${workerLabel(result.merge.resolved_task_id)} 也标成已合并。`);
      await detail(task.id);
    });
    if (live) {
      node.disabled = true;
      const host = el('span', undefined, 'help-host');
      host.setAttribute('data-help', `${workerLabel(resolver)} 正在解冲突：等它结束，或者先取消它再重试。`);
      host.append(node);
      actions.append(host);
    } else actions.append(node);
  }
  if (!readOnly && ['failed', 'cancelled'].includes(task.status) && ['order','child'].includes(workerKind(task))
    && !task.divergence_resolution) actions.append(button('检查后重试', async () => {
    // 父侧 #194：重试改为完整 Profile 弹窗（retryTask）；编号展示由 retry-dialog.js 内部沿用。
    if (await retryTask(task)) await detail(task.id);
  }, 'ghost', { agent: true, help: agentHelp('检查失败现场并调整本轮 Agent、模型来源、模型与 Prompt 后再启动一次；不会回滚此前 Agent 的文件副作用。') }));
  // Only failed/cancelled and historical special branches use independent resource cleanup.
  const acceptedWorker = task.accepted === true || (history?.events || []).some(event => event.type === 'task.accepted');
  const cleanableWorker = !['order', 'child'].includes(workerKind(task))
    || ['failed', 'cancelled'].includes(task.status) || (task.status === 'completed' && !acceptedWorker);
  if (!readOnly && task.branch_archive?.archivable && cleanableWorker) actions.append(button('清理资源', () => runBranchArchive(
    { name: task.branch, subtreeBranches: task.branch_archive.subtree_branches }, { refresh: () => detail(task.id) }), 'ghost',
    { help: BRANCH_ARCHIVE_HELP }));
  // 中断只是可撤销的意图；请求期间即可继续、调整下一轮设置或明确放弃。
  const liveWorkTask = !readOnly && ['order','child'].includes(workerKind(task)) && !TERMINAL_STATUS.has(task.status);
  const interruptRequested = task.interrupt_state === 'requested';
  const resuming = task.interrupt_state === 'resuming';
  if (liveWorkTask && !interruptRequested && !['paused', 'awaiting_acceptance'].includes(task.status)) actions.append(button('中断', async () => {
    const confirmed = await confirmDialog({
      title: `中断 Worker ${workerLabel(task)}？`,
      message: '请求当前 Agent 在安全点暂停并保留现场：工作区、提交、pi 会话与消息都不变。Pi 会等本轮工具结束，其他后端等当前调用自然结束；不会因中断等待超时而强杀。请求期间可追加输入、调整下一轮运行设置，或立即点「继续」撤销中断；子 Worker 不受影响。',
      confirmLabel: '中断', cancelLabel: '保留',
    });
    if (!confirmed) return;
    try { await action('worker.interrupt', { id: task.id }); show(`Worker ${workerLabel(task)} 的中断请求已接受；可立即点「继续」，不必等待暂停。`); }
    catch (error) { show(`无法中断：${error.message}`, 'error'); }
    await detail(task.id);
  }, 'ghost', { help: '请求这个 Worker 在安全点暂停，不因中断等待超时而强杀；保留现场且不影响子 Worker，请求期间可立即点「继续」撤销。' }));
  if (!readOnly && !TERMINAL_STATUS.has(task.status) && (task.status === 'paused' || interruptRequested || resuming)) {
    const neverStarted = task.status === 'paused' && !interruptRequested && !resuming && (task.agent_wakes ?? 0) === 0;
    actions.append(button(neverStarted ? '开始' : '继续', async () => {
      try { await action('worker.resume', { id: task.id }); show(`Worker ${workerLabel(task)} 的${neverStarted ? '开始' : '继续'}请求已接受；尚未生效的中断会撤销，需要新调用时由后台调度。`); }
      catch (error) { show(`无法${neverStarted ? '开始' : '继续'}：${error.message}`, 'error'); }
      await detail(task.id);
    }, undefined, { agent: true, help: agentHelp('撤销尚未生效的中断；若已暂停，则请求按当前运行设置调度 Agent。无需等待旧调用释放，重复继续不重复启动；工作区、提交、会话与消息保留。') }));
    if (liveWorkTask && (task.status === 'paused' || interruptRequested)) actions.append(button('调整运行设置', async () => {
      if (await configureTask(task)) await detail(task.id);
    }, 'ghost', { help: '在同一面板调整配置模式、Agent、模型来源、模型与思考深度，高级设置包含 Prompt、扩展、Skills、预算和环境变量；保留未修改设置，不启动 Agent，不改变当前调用。' }));
    actions.append(button('放弃 Worker', async () => {
      const confirmed = await confirmDialog({
        title: '放弃这个 Worker 树？',
        message: '放弃这条 Worker 及所有子 Worker（进入已取消），工作区与分支保留；放弃后不能直接恢复。',
        confirmLabel: '放弃 Worker', cancelLabel: '保留', danger: true,
      });
      if (!confirmed) return;
      await action('worker.cancel', { id: task.id });
      await detail(task.id);
    }, 'danger', { help: '放弃这条 Worker 及它下面的全部子 Worker，工作区与分支保留；这是不可恢复的终态操作。' }));
  }
  if (task.divergence_resolution) {
    actions.append(button(`查看源指令 ${workerLabel(task.parent_id, task.parent_worker_number)}`, () => detail(task.parent_id), 'link'));
  }
  const clearOverride = management ? null : clearOverrideControl(task, () => detail(task.id));
  if (clearOverride) actions.append(clearOverride);
  const deletion = management ? null : workerDeleteControl(task);
  if (deletion) actions.append(deletion);
  actions.append(button('刷新详情', () => detail(task.id), 'ghost'));
  panel.append(actions);
  const source = ['order', 'child'].includes(workerKind(task)) ? modelSourceSummary(task, history?.events, connections) : null;
  if (source) {
    panel.append(source);
    if (progressive && !progressive.loaded?.connections) source.append(el('p', '连接名称加载中…', 'hint detail-connections-status'));
  }
  const interruptHint = management ? null : interruptReason(task);
  if (interruptHint) panel.append(el('p', interruptHint, 'hint interrupt-reason'));
  if (task.divergence_resolution && TERMINAL_STATUS.has(task.status) && task.integration !== 'merged') {
    const archived = task.divergence_resolution.branch_status === 'archived';
    // 三种来源：终态指令的独立解分歧（runtime 驱动）、活动指令自己的合并请求（用户驱动），
    // 或一个已完子任务的固定提交（直接父 Agent 驱动）。
    const terminalOrder = task.resolves_task_id !== null
      && task.resolves_task_id === task.divergence_resolution.source_task_id;
    const repairsOrder = task.divergence_resolution.source_task_id === task.parent_id;
    const retry = terminalOrder
      ? `返回源指令 ${workerLabel(task.divergence_resolution.source_task_id)}，在分歧仍存在且预约可分派时可重新派独立子 Worker。`
      : repairsOrder
        ? '返回源指令，在静息且分歧仍存在时可重新派独立子 Worker。'
        : `由直接父 Agent ${workerLabel(task.parent_id, task.parent_worker_number)} 再派一个以同一固定提交为基线的解分歧子 Worker（worker resolve-child-divergence）。`;
    panel.append(el('p', archived
      ? `解分歧子 Worker 已归档，Worker、固定提交记录和会话仍保留。${retry}`
      : `解分歧成果尚未集成：先检查工作区和固定提交。需要另试时，在 Worker 树或 Worker 详情显式清理这条子分支资源（删除 ref/worktree；未提交文件会丢失），${retry}不会重放本次 Agent。`,
    'hint delivery-reason'));
  }
  const iteration = management ? null : iterationControls(task, { refresh: () => detail(task.id), events: history?.events || [], showParentDistance: true });
  if (iteration) panel.append(iteration);
  const delivery = management ? null : deliveryControls(task, { refresh: () => detail(task.id) });
  if (delivery) panel.append(delivery);
  const hooks = management ? null : previousHooks || workerHooks(task, { refresh: () => detail(task.id) });
  if (hooks) {
    if (hookManagementOpen) hooks.querySelector('.hook-management').open = true;
    panel.append(hooks);
  }

  // Only reading modules below this point get height-limited previews, never actions/forms above.
  const readingStart = panel.children.length;
  // Inputs and invocation results share one conversation, ahead of implementation metadata.
  const conversation = renderConversation(task, history, previousConversation);
  if (conversation) panel.append(conversation);
  const endedAt = [...(task.runs || [])].reverse().find(run => run.ended_at)?.ended_at ?? task.updated_at;
  const progress = renderTaskProgress(task.progress, { status: task.status, endedAt });
  if (progress) panel.append(progress);
  const progressHistory = renderProgressHistory(task, previousProgressHistory);
  if (progressHistory) panel.append(progressHistory);
  if (task.error) { const error = block('错误'); error.classList.add('error-panel'); error.append(agentText(task.error, { className: 'error', plain: 'pre' })); panel.append(error); }
  if (task.integration_error) { const error = block('合并错误'); error.classList.add('error-panel'); error.append(agentText(task.integration_error, { className: 'error', plain: 'pre' })); panel.append(error); }

  const agent = task.calls ? renderAgent(task, usage) : null;
  if (agent) {
    panel.append(agent);
    if (progressive) agent.append(el('p', progressive.loaded?.usage ? '' : '用量加载中…', 'hint detail-usage-status'));
  }

  const stats = block('状态'); stats.classList.add('task-stats');
  const grid = el('div', undefined, 'grid');
  grid.append(kv('调用次数', `${task.calls}（本次尝试）`));
  // 墙钟耗时包含静息等待，单看它会把等待算成 Agent 的处理时间；有 run 时同时给出工作与等待拆分。
  const wallEnd = task.status === 'running' ? new Date().toISOString() : task.updated_at;
  const workMs = runWorkMs(task.runs);
  const wallMs = Date.parse(wallEnd) - Date.parse(task.created_at);
  const waited = Number.isFinite(wallMs) ? Math.max(0, wallMs - workMs) : 0;
  grid.append(kv(task.status === 'running' ? '本次已运行' : '耗时', workMs > 0 && waited > 0
    ? `${duration(task.created_at, wallEnd)}（工作 ${formatProgressDuration(workMs)} · 等待 ${formatProgressDuration(waited)}）`
    : duration(task.created_at, wallEnd)));
  grid.append(kv('创建', `${absolute(task.created_at)}`, 'mono'));
  grid.append(kv('最后更新', `${absolute(task.updated_at)} · ${relative(task.updated_at)}`));
  stats.append(grid); panel.append(stats);
  if (task.specs) panel.append(renderTaskSpecs(task));
  panel.append(renderDeps(task));
  if ((task.resolutions || []).length) panel.append(renderResolutions(task));

  if (task.branch || task.workspace) {
    const workspace = block('工作区');
    const text = [task.branch, task.workspace && `${worktreeLabel(task)}：${task.workspace}`].filter(Boolean).join('\n');
    workspace.append(el('p', text, 'mono'));
    panel.append(workspace);
  }
  let diffSection = null, diffFold = null, diffBody = null;
  const lazyDiff = Boolean(progressive?.requestDiff);
  const loadDiff = () => {
    if (!diffFold?.open || !progressive.current()) return;
    diffFold.dataset.state = 'loading';
    diffBody.querySelector('.detail-diff-status')?.remove();
    if (!diffFold.dataset.signature) diffBody.append(el('p', '改动加载中…', 'hint detail-diff-status'));
    return progressive.requestDiff();
  };
  if (!management) {
    diffSection = progressive ? block('改动概览') : renderDiff(diff, task.id);
    if (lazyDiff) {
      diffFold = previousDiff || el('details', undefined, 'detail-diff');
      if (!previousDiff) {
        diffFold.append(el('summary', '查看改动概览'));
        diffFold.append(el('div', undefined, 'detail-diff-body'));
      }
      diffBody = diffFold.querySelector('.detail-diff-body');
      diffFold.dataset.state = 'idle';
      diffBody.querySelector('.detail-diff-status')?.remove();
      if (!diffFold.dataset.signature) diffBody.append(el('p', diffFold.open ? '改动加载中…' : '打开后读取改动。', 'hint detail-diff-status'));
      diffFold.ontoggle = () => { if (diffFold.open && diffFold.dataset.state === 'idle') void loadDiff(); };
      diffSection.append(diffFold);
      if (diffFold.open) queueMicrotask(loadDiff);
    } else if (progressive) diffSection.append(el('p', '改动加载中…', 'hint'));
    panel.append(diffSection);
  }
  if (task.role === 'verifier' || task.verifications?.length || (task.role === 'worker' && task.status === 'completed' && task.workspace && task.head_commit)) panel.append(renderVerifications(task));

  if (task.children?.length) {
    const children = block('子 Worker', String(task.children.length));
    for (const child of task.children) {
      const row = el('div', undefined, 'row');
      row.append(el('span', statusOf(child).icon, `dot c-${child.status}`), el('span', workerLabel(child), 'tid'));
      const jump = button(`${child.goal}`, () => detail(child.id), 'link');
      row.append(jump, el('span', relative(child.updated_at), 'when'));
      referenceable(row, [
        { kind: 'task', target: { task_id: child.id }, label: `Worker ${workerLabel(child)}`, quote: child.goal, location: { view: 'task-detail', task_id: child.id } },
        { kind: 'task_subtree', target: { task_id: child.id }, label: `Worker 子树 ${workerLabel(child)}`, quote: child.goal, location: { view: 'task-detail', task_id: child.id } },
      ]);
      children.append(row);
    }
    panel.append(children);
  }
  const decisions = (task.notices || []).filter(notice => notice.kind === 'questionnaire');
  if (decisions.length) {
    const record = block('决策记录', String(decisions.length));
    for (const notice of decisions) {
      if (notice.status === 'open' && !readOnly) record.append(button(`待回答：${notice.title}`, () => {
        ui.noticeIndex.set(notice.id, notice); ui.noticeFocus = notice.id; return detail(task.id);
      }, 'ghost'));
      else {
        const signature = JSON.stringify([notice, readOnly]);
        const previous = previousDecisions.get(String(notice.id));
        if (previous?.dataset.signature === signature) { record.append(previous); continue; }
        const fold = el('details', undefined, 'decision-record');
        fold.dataset.noticeId = String(notice.id); fold.dataset.signature = signature;
        const label = { open: '历史待决 · 只读', answered: '已回答', dismissed: '已忽略' }[notice.status] || notice.status;
        fold.append(el('summary', `${notice.title} · ${label}`),
          readOnly && notice.status === 'open' ? el('pre', notice.body) : settledDecision(notice));
        record.append(fold);
      }
    }
    panel.append(record);
  }
  if (task.messages?.length) {
    const messages = block('消息', String(task.messages.length));
    for (const message of task.messages) {
      const item = renderTaskMessage(message, task.id, previousMessages.get(String(message.id)));
      referenceable(item, { kind: 'message', target: { task_id: task.id, message_id: message.id }, label: `Worker ${workerLabel(task)} 的消息`,
        quote: message.body, location: { view: 'task-detail', task_id: task.id, section: 'messages' } });
      messages.append(item);
    }
    panel.append(messages);
  }
  let events = null;
  if (progressive || history?.events?.length) {
    events = block('事件时间线', history?.loading ? undefined : String(history.events.length));
    events.append(history?.loading ? el('p', '历史加载中…', 'hint') : renderHistory(history.events, { running: task.status === 'running', truncated: history.truncated,
      cursor: history.cursor, onMore: history.onMore, taskId: task.id }));
    panel.append(events);
  }
  linkWorkerNumbers(panel);
  limitDetailModules(panel, { taskId: task.id, from: readingStart });
  if (progressHistory && historyFocus && document.activeElement !== historyFocus) historyFocus.focus({ preventScroll: true });
  restoreDetailReading(panel, readingPosition);
  if (!progressive) return;
  // Existing explicit history pagers start their GET synchronously. Bind them to this view,
  // including reused conversation/progress nodes, without changing their write/action contracts.
  if (progressive.signal) for (const area of [conversation, progressHistory]) {
    for (const control of area?.querySelectorAll('button') || []) {
      const start = readingHandlers.get(control) || control.onclick;
      if (typeof start !== 'function') continue;
      readingHandlers.set(control, start);
      control.onclick = event => withReadSignal(progressive.signal, () => start.call(control, event));
    }
  }

  // At most four supplemental patches. Never rebuild the page or replace a live form/reader.
  const pending = new Map();
  let listening = false, observer = null, disposed = false;
  const inside = node => { for (let at = node; at; at = at.parentNode) if (at === panel) return true; return false; };
  const reading = () => {
    const selection = globalThis.window?.getSelection?.();
    return Boolean(selection && !selection.isCollapsed && (inside(selection.anchorNode) || inside(selection.focusNode)))
      || inside(document.activeElement);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; pending.clear();
    disposeDetailModules(panel);
    ownerDocument?.removeEventListener?.('selectionchange', flush);
    panel.removeEventListener?.('focusout', onFocusOut);
    observer?.disconnect();
  };
  function flush() {
    if (disposed) return;
    if (!progressive.current() || panel.dataset.taskId !== String(task.id)) { dispose(); return; }
    if (reading()) return;
    const position = captureDetailReading(panel);
    for (const patch of pending.values()) patch();
    pending.clear();
    restoreDetailReading(panel, position);
    if (listening) {
      ownerDocument?.removeEventListener?.('selectionchange', flush);
      panel.removeEventListener?.('focusout', onFocusOut);
      observer?.disconnect(); listening = false;
    }
  }
  const onFocusOut = () => queueMicrotask(flush);
  const replace = (old, next) => { panel.insertBefore(next, old); old.remove(); return next; };
  const sourcePatch = () => {
    if (!source) return;
    const next = modelSourceSummary(task, history?.events, connections);
    source.replaceChildren(...next.childNodes);
    if (connectionStatus !== 'ready') source.append(el('p', connectionStatus === 'loading' ? '连接名称加载中…' : '连接名称不可用；显示连接 ID。', 'hint detail-connections-status'));
  };
  let connectionStatus = progressive.loaded?.connections ? 'ready' : 'loading';
  const patches = {
    dispose,
    update(kind, value, available) {
      if (disposed || !progressive.current()) { dispose(); return; }
      pending.set(kind, () => {
        if (kind === 'connections') { connections = value; connectionStatus = available ? 'ready' : 'unavailable'; sourcePatch(); }
        if (kind === 'usage' && agent) {
          const next = renderAgent(task, available ? value : null);
          const grid = agent.querySelector('.grid');
          if (grid) grid.remove();
          const nextGrid = next.querySelector('.grid');
          if (nextGrid) (agent.querySelector('.detail-preview-content') || agent).insertBefore(nextGrid, null);
          // Same-Worker refresh already renders the cached preview; replace it, never append a duplicate.
          agent.querySelector('.last-step')?.remove();
          const last = next.querySelector('.last-step');
          if (last) agent.querySelector('.block').insertBefore(last, null);
          const status = agent.querySelector('.detail-usage-status');
          status.textContent = available ? (value?.files?.length ? '' : '未记录会话用量。') : '用量不可用；未读取到数据。';
        }
        if (kind === 'diff' && diffSection) {
          const next = available && value ? renderDiff(value, task.id) : block('改动概览');
          if (!available || !value) next.append(el('p', available ? '改动不可用：尚无可读取的工作区。' : '改动不可用；读取失败。', 'hint'));
          if (lazyDiff) {
            const filesOpen = diffBody.querySelector('.diff-files')?.open === true;
            const signature = JSON.stringify([value, available]);
            diffBody.querySelector('.detail-diff-status')?.remove();
            if (diffFold.dataset.signature !== signature) diffBody.replaceChildren(next);
            diffFold.dataset.signature = signature;
            if (filesOpen && diffBody.querySelector('.diff-files')) diffBody.querySelector('.diff-files').open = true;
            diffFold.dataset.state = available ? 'ready' : 'failed';
            diffBody.querySelector('.detail-diff-retry')?.remove();
            if (!available) diffBody.append(button('重试读取改动', loadDiff, 'ghost detail-diff-retry'));
          } else diffSection = replace(diffSection, next);
        }
        if (kind === 'history') {
          if (available) {
            history = value;
            conversation?.updateConversation(task, value);
            sourcePatch();
          } else {
            conversation?.updateConversation(task, { events: [], unavailable: true });
          }
          const next = block('事件时间线', available ? String(value.events?.length || 0) : undefined);
          next.append(available && value.events?.length ? renderHistory(value.events, { running: task.status === 'running', truncated: value.truncated,
            cursor: value.cursor, onMore: value.onMore, taskId: task.id }) : el('p', available ? '暂无历史事件。' : '历史不可用；读取失败。', 'hint'));
          events = replace(events, next);
        }
        linkWorkerNumbers(panel);
        limitDetailModules(panel, { taskId: task.id, from: readingStart });
      });
      flush();
      if (pending.size && !listening) {
        listening = true;
        ownerDocument?.addEventListener?.('selectionchange', flush);
        // focusout precedes the browser's activeElement change.
        panel.addEventListener('focusout', onFocusOut);
        if (typeof MutationObserver === 'function') {
          observer = new MutationObserver(() => { if (!progressive.current()) dispose(); });
          observer.observe(panel, { attributes: true, childList: true });
        }
      }
    },
  };
  progressivePanels.set(panel, patches);
  return patches;
}
export function renderDetailError(taskId, message) {
  const panel = $('detail');
  progressivePanels.get(panel)?.dispose(); progressivePanels.delete(panel);
  disposeDetailModules(panel);
  panel.replaceChildren(el('h2', `无法打开 ${workerLabel(taskId)}`), el('p', message, 'error'));
}
