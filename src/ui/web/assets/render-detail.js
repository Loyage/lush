import { $, badge, block, button, el, kv, roleBadge, routeBadge, statusBadge } from './dom.js';
import { action } from './api.js';
import { confirmDialog, promptDialog } from './dialog.js';
import { INTEGRATION, ROLE, TERMINAL_STATUS, absolute, duration, edgeLabel, relative, resolverOf, statusOf, taskTitle, worktreeLabel } from './format.js';
import { agentHelp } from './help.js';
import { freezeBlocker } from './merge-select.js';
import { show } from './messages.js';
import { detail, overview } from './navigate.js';
import { renderAgent } from './render-agent.js';
import { renderDiff } from './render-diff.js';
import { deliveryControls } from './render-delivery.js';
import { renderHistory } from './render-history.js';
import { renderTaskProgress } from './render-progress.js';
import { noticePanel } from './render-notices.js';
import { questionnairePanel } from './render-questionnaire.js';
import { renderResolutions } from './render-resolutions.js';
import { specItem } from './render-specs.js';
import { renderVerifications } from './render-verify.js';
import { renderShowcase } from './render-showcase.js';
import { retryTask } from './retry-dialog.js';
import { ui } from './state.js';
import { agentText } from './text.js';
import { referenceable } from './context-references.js';

const freezeOf = task => freezeBlocker(task.target_branch, task, ui.lastSnapshot?.status?.merge_freeze || []);
/** 任务依赖：本任务等谁、谁在等它。 */
function renderDeps(task) {
  const section = block('任务依赖');
  section.append(el('p', task.deps?.length ? `本任务等这些结算：${task.deps.map(edgeLabel).join('、')}` : '本任务不依赖其他任务。', 'hint'));
  section.append(el('p', task.dependents?.length ? `这些任务在等它：${task.dependents.map(edgeLabel).join('、')}` : '没有任务在等它。', 'hint'));
  return section;
}
/** planner 这一轮写下的拆解 / scheduler 这一批取走的 spec：只读，和左侧队列同一套行。 */
function renderTaskSpecs(task) {
  const specs = task.specs || [];
  const section = block('拆解队列', String(specs.length));
  section.append(el('p', task.role === 'scheduler'
    ? '本任务这一批取走的 spec：每一条都要有归宿——spawn 成任务，或明确丢弃。'
    : '这一轮写下的拆解（等 scheduler 编排）：scheduler 会把它们一次性编排成真实任务，批内没有依赖边的会同时开工。', 'hint'));
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
  const node = intent?.task_id ? button(`意图 #${inputId}`, () => { ui.noticeFocus = null; return detail(intent.task_id); }, 'badge b-neutral') : badge(`意图 #${inputId}`, 'b-neutral');
  if (intent?.content) node.title = String(intent.content).slice(0, 200);
  if (intent?.task_id) {
    node.classList.add('intent-link');
    node.title = `${node.title ? `${node.title}\n` : ''}点开看这条意图的规划与拆解`;
    node.onclick = () => { ui.noticeFocus = null; return detail(intent.task_id); };
  }
  return node;
}
export function renderDetail(task, history, diff, usage) {
  const panel = $('detail');
  const reading = panel.dataset.taskId === String(task.id) ? panel.querySelector('.transcript') : null;
  panel.dataset.view = 'task'; panel.dataset.taskId = String(task.id); panel.replaceChildren();
  referenceable(panel, { kind: 'task', target: { task_id: task.id }, label: `任务 #${task.id}`,
    quote: `${task.goal}\n状态：${statusOf(task).label} · ${ROLE[task.role] || task.role}`, location: { view: 'task-detail', task_id: task.id } });
  const breadcrumb = el('div', undefined, 'breadcrumb');
  breadcrumb.append(button('项目概览', () => overview(), 'link'), el('span', '/'), el('span', `${ROLE[task.role] || task.role} #${task.id}`));
  panel.append(breadcrumb);
  const hero = el('div', undefined, 'task-hero');
  const head = el('div', undefined, 'head');
  head.append(el('span', `#${task.id}`, 'tid-lg'), statusBadge(task),
    roleBadge(task.role), ...(task.route ? [routeBadge()] : []), intentBadge(task));
  const integration = INTEGRATION[task.integration];
  if (integration) head.append(badge(integration, task.integration === 'merged' ? 'b-completed' : 'b-awaiting'));
  if (task.task_kind === 'analysis') head.append(badge('只读分析', 'b-neutral'));
  if (task.agent) head.append(badge(`agent ${task.agent.id}${task.agent.active ? ` · pid ${task.agent.pid ?? '待上报'}` : ' · 空闲'}`, 'b-neutral'));
  hero.append(head, el('h1', taskTitle(task), 'task-title')); panel.append(hero);

  const notice = ui.noticeFocus === null ? null : ui.noticeIndex.get(ui.noticeFocus);
  if (notice && notice.task_id === task.id) panel.prepend(noticePanel(notice, task));

  const actions = el('div', undefined, 'actions task-actions');
  const stacked = (task.deps || []).filter(edge => edge.kind === 'code');
  const freeze = freezeOf(task);
  const resolver = resolverOf(task);
  const deliveryItem = (ui.lastSnapshot?.ladder?.groups || []).flatMap(group => group.items || []).find(item => item.id === task.id) || null;
  if (!task.task_kind && freeze) {
    // 同一目标分支上有没解决的冲突：这里点合并只会失败，所以禁用并指向那个任务。
    const node = button('合并已被冻结', () => {}, 'ghost');
    node.disabled = true;
    // 禁用的按钮不派发指针事件，data-help 放外层 span.help-host。
    const host = el('span', undefined, 'help-host');
    host.setAttribute('data-help', `#${freeze.task_id} 的合并冲突还没解决：先处理它的待决问题（或让它的解冲突任务作废），${task.target_branch} 上的合并才能继续。`);
    host.append(node);
    actions.append(host);
  } else if (!task.task_kind && task.status === 'completed' && ['pending', 'review', 'conflict'].includes(task.integration)) {
    const live = resolver && !TERMINAL_STATUS.has(resolver.status);
    const readyResolver = resolver && resolver.status === 'completed' && ['pending', 'review'].includes(resolver.integration)
      && deliveryItem?.phase !== 'resolution_stale';
    const retry = task.integration === 'conflict';
    const label = readyResolver ? `审阅并落地解冲突结果 #${resolver.id}` : live ? `解冲突任务 #${resolver.id} 进行中`
      : retry ? '重新尝试合并' : task.integration === 'review' ? '检查后重新批准合并' : '批准合并';
    const node = button(label, async () => {
      if (readyResolver) return detail(resolver.id);
      const caveats = [];
      if (stacked.length) caveats.push(`本任务 stacked 在 #${stacked.map(edge => edge.id).join('、')} 之上，必须先合并上游，否则会把它的改动一起带进来。`);
      if (task.resolves_task_id) caveats.push('这是解冲突任务：落地用 --ff-only，落地的树就是它测过的那棵树。');
      if (resolver) caveats.push(`解冲突任务 #${resolver.id} 还没落地：重新尝试会明确废弃它（分支与目录仍保留）。`);
      const confirmed = await confirmDialog({
        title: retry ? `重新尝试把 ${task.branch} 合并到 ${task.target_branch}？` : `将 ${task.branch} 合并到 ${task.target_branch}？`,
        message: retry ? '如果还冲突，会再开一轮解冲突任务。请先审阅代码和测试结果。' : '请先审阅代码和测试结果。',
        detail: caveats.join('\n\n') || null,
        confirmLabel: retry ? '重新尝试' : '合并',
      });
      if (!confirmed) return;
      const result = await action('task.merge', { id: task.id });
      if (result?.merge?.status === 'conflict') show(`合并冲突：已开解冲突任务 #${result.merge.resolution_task_id}，请处理左侧的待决问题（${task.target_branch} 上的其它合并已冻结）。`, 'error');
      else if (result?.merge?.status === 'resolved') show(`冲突已解决：原任务 #${result.merge.resolved_task_id} 也标成已合并。`);
      await detail(task.id);
    });
    if (live) {
      node.disabled = true;
      const host = el('span', undefined, 'help-host');
      host.setAttribute('data-help', `#${resolver.id} 正在解冲突：等它结束，或者先取消它再重试。`);
      host.append(node);
      actions.append(host);
    } else actions.append(node);
  }
  const settledShowcase = task.task_kind === 'say' && task.reservation?.kind === 'showcase'
    && ['completed','failed','cancelled'].includes(task.reservation.status);
  if (['failed', 'cancelled'].includes(task.status) && task.task_kind !== 'showcase' && !settledShowcase
    && !task.divergence_resolution) actions.append(button('检查后重试', async () => {
    if (await retryTask(task)) await detail(task.id);
  }));
  const reclaimable = task.status === 'completed' && ['merged', 'none', 'superseded'].includes(task.integration) && (task.workspace || task.branch);
  if (reclaimable) actions.append(button('回收工作区与分支', async () => {
    const plan = [task.workspace && `删除 ${task.workspace}`, task.branch && `回收分支 ${task.branch}`].filter(Boolean).join('\n');
    const confirmed = await confirmDialog({
      title: '回收工作区与分支？',
      message: `只有分支顶端就是审阅过的那次提交、且已经进入 ${task.target_branch} 时才删；否则分支保留并在事件里说明原因。`,
      detail: plan || null,
      confirmLabel: '回收',
      danger: true,
    });
    if (!confirmed) return;
    await action('task.cleanup', { id: task.id }); await detail(task.id);
  }, 'ghost', { help: '删除这条任务的 worktree 与本地分支；只有分支已进入目标分支且顶端就是审阅过的提交时才真删，否则保留并在事件里说明原因。' }));
  if (reclaimable && task.workspace && task.branch) actions.append(button('只回收 worktree（保留分支）', async () => { await action('task.cleanup', { id: task.id, keep_branch: true }); await detail(task.id); }, 'ghost',
    { help: '只删除 worktree、保留本地分支；未提交的改动会随 worktree 一起丢失。' }));
  const verifications = task.verifications || [];
  if (!['completed', 'failed', 'cancelled'].includes(task.status)) actions.append(button('取消任务树', async () => {
    const confirmed = await confirmDialog({
      title: '取消这个任务树？',
      message: '取消这个任务及所有子任务；工作区会保留。',
      confirmLabel: '取消任务',
      cancelLabel: '保留',
      danger: true,
    });
    if (confirmed) await action('task.cancel', { id: task.id });
    await detail(task.id);
  }, 'danger', { help: '取消这个任务及它下面的全部子任务，工作区与分支保留；取消后无法恢复。' }));
  if (task.divergence_resolution) {
    actions.append(button(`查看源 say #${task.parent_id}`, () => detail(task.parent_id), 'link'));
  }
  // 分支所有者（main/owner）没有自己的 Agent，但可以按需跑一次**只读分析**：不建分支，答案成为新 Task 的结果。
  if (['main','owner'].includes(task.task_kind) && !['completed','failed','cancelled'].includes(task.status)) {
    actions.append(button('问这条分支', async () => {
      const question = await promptDialog({
        title: `向 ${task.branch} 提一个只读问题`,
        message: '会新建一个只读分析子 Task：工作区是这条分支最新提交的分离检出，不创建分支、不产生待合并改动。',
        label: '问题', placeholder: '例如：现在这条分支上最大的回归风险是什么？', confirmLabel: '开始分析',
        agent: true,
        confirmHelp: agentHelp('启动一次受限的分析 Agent：能在隔离检出里读文件、跑命令取证，但没有分支可写、不能派工或合并；答案成为新 Task 的结果。'),
      });
      if (!question) return;
      const created = await action('task.analyze', { id: task.id, question });
      show(`已开始分析 #${created.task.id}`);
      await detail(created.task.id);
    }, 'ghost', { agent: true, help: agentHelp('对这条分支跑一次只读分析（不建分支、不改提交）；结论存成一个子 Task 的结果，另留一条提醒。') }));
  }
  actions.append(button('刷新详情', () => detail(task.id), 'ghost'));
  panel.append(actions);
  if (task.divergence_resolution && TERMINAL_STATUS.has(task.status) && task.integration !== 'merged') {
    const archived = task.divergence_resolution.branch_status === 'archived';
    // 三种来源：终态 say 的独立解分歧（runtime 驱动）、活动 say 自己的合并请求（用户驱动），
    // 或一个已完子任务的固定提交（直接父 Agent 驱动）。
    const terminalSay = task.resolves_task_id !== null
      && task.resolves_task_id === task.divergence_resolution.source_task_id;
    const repairsSay = task.divergence_resolution.source_task_id === task.parent_id;
    const retry = terminalSay
      ? `返回源 say #${task.divergence_resolution.source_task_id}，在分歧仍存在且预约可分派时可重新派独立子任务。`
      : repairsSay
        ? '返回源 say，在静息且分歧仍存在时可重新派独立子任务。'
        : `由直接父 Agent #${task.parent_id} 再派一个以同一固定提交为基线的解分歧子任务（task resolve-child-divergence）。`;
    panel.append(el('p', archived
      ? `解分歧子任务已归档，Task、固定提交记录和会话仍保留。${retry}`
      : `解分歧成果尚未集成：先检查工作区和固定提交。需要另试时，在分支图显式归档这条子分支（删除 ref/worktree；未提交文件会丢失），${retry}不会重放本次 Agent。`,
    'hint delivery-reason'));
  }
  const delivery = deliveryControls(task, { refresh: () => detail(task.id) });
  if (delivery) panel.append(delivery);

  // 结果与失败原因优先于调用次数、目录等底层元数据。完整目标（goal）以 Markdown 正文排在结果之前。
  if (task.goal) {
    const goal = block('任务目标'); goal.classList.add('goal-panel');
    goal.append(agentText(task.goal, { className: 'goal-text', plain: 'div' }));
    panel.append(goal);
  }
  const endedAt = [...(task.runs || [])].reverse().find(run => run.ended_at)?.ended_at ?? task.updated_at;
  const progress = renderTaskProgress(task.progress, { status: task.status, endedAt });
  if (progress) panel.append(progress);
  if (task.role === 'showcase') panel.append(renderShowcase(task));
  if (task.result) {
    const result = block('结果'); result.classList.add('result-panel'); result.append(agentText(task.result, { plain: 'pre' }));
    referenceable(result, { kind: 'result', target: { task_id: task.id, section: 'result' }, label: `任务结果 #${task.id}`,
      quote: task.result, location: { view: 'task-detail', task_id: task.id, section: 'result' } });
    panel.append(result);
  }
  if (task.error) { const error = block('错误'); error.classList.add('error-panel'); error.append(agentText(task.error, { className: 'error', plain: 'pre' })); panel.append(error); }
  if (task.integration_error) { const error = block('合并错误'); error.classList.add('error-panel'); error.append(agentText(task.integration_error, { className: 'error', plain: 'pre' })); panel.append(error); }

  if (task.calls) panel.append(renderAgent(task, usage, reading));

  const stats = block('状态'); stats.classList.add('task-stats');
  const grid = el('div', undefined, 'grid');
  grid.append(kv('调用次数', `${task.calls}（本次尝试）`));
  grid.append(kv(task.status === 'running' ? '本次已运行' : '耗时', duration(task.created_at, task.status === 'running' ? new Date().toISOString() : task.updated_at)));
  grid.append(kv('创建', `${absolute(task.created_at)}`, 'mono'));
  grid.append(kv('最后更新', `${absolute(task.updated_at)} · ${relative(task.updated_at)}`));
  stats.append(grid); panel.append(stats);
  if (task.specs) panel.append(renderTaskSpecs(task));
  panel.append(renderDeps(task));
  if ((task.resolutions || []).length) panel.append(renderResolutions(task));

  if (task.branch || task.workspace) {
    const workspace = block('工作区');
    // 展示任务的检出是 detached worktree，不是分支工作区：这里必须写明，不能让一行裸路径被误认成源分支。
    const text = task.role === 'showcase' && task.workspace
      ? `${worktreeLabel(task)}：${task.workspace}`
      : [task.branch, task.workspace].filter(Boolean).join('\n');
    workspace.append(el('p', text, 'mono'));
    panel.append(workspace);
  }
  panel.append(renderDiff(diff, task.id));
  if (task.role === 'verifier' || verifications.length || (task.role === 'worker' && task.status === 'completed' && task.workspace && task.head_commit)) panel.append(renderVerifications(task));

  if (task.children?.length) {
    const children = block('子任务', String(task.children.length));
    for (const child of task.children) {
      const row = el('div', undefined, 'row');
      row.append(el('span', statusOf(child).icon, `dot c-${child.status}`), el('span', `#${child.id}`, 'tid'));
      const jump = button(`${child.goal}`, () => detail(child.id), 'link');
      row.append(jump, el('span', relative(child.updated_at), 'when'));
      referenceable(row, [
        { kind: 'task', target: { task_id: child.id }, label: `任务 #${child.id}`, quote: child.goal, location: { view: 'task-detail', task_id: child.id } },
        { kind: 'task_subtree', target: { task_id: child.id }, label: `任务子树 #${child.id}`, quote: child.goal, location: { view: 'task-detail', task_id: child.id } },
      ]);
      children.append(row);
    }
    panel.append(children);
  }
  const decisions = (task.notices || []).filter(notice => notice.kind === 'questionnaire');
  if (decisions.length) {
    const record = block('决策记录', String(decisions.length));
    for (const notice of decisions) {
      if (notice.status === 'open') record.append(button(`待回答：${notice.title}`, () => {
        ui.noticeIndex.set(notice.id, notice); ui.noticeFocus = notice.id; return detail(task.id);
      }, 'ghost'));
      else {
        const fold = el('details');
        fold.append(el('summary', `${notice.title} · ${notice.status === 'answered' ? '已回答' : '已忽略'}`), questionnairePanel(notice));
        record.append(fold);
      }
    }
    panel.append(record);
  }
  if (task.messages?.length) {
    const messages = block('消息', String(task.messages.length));
    for (const message of task.messages) {
      const item = el('div', undefined, 'msg');
      item.append(el('small', `${message.sender_id ? `来自 #${message.sender_id}` : '来自你'} · ${absolute(message.created_at)}`), el('p', message.body));
      referenceable(item, { kind: 'message', target: { task_id: task.id, message_id: message.id }, label: `任务 #${task.id} 的消息`,
        quote: message.body, location: { view: 'task-detail', task_id: task.id, section: 'messages' } });
      messages.append(item);
    }
    panel.append(messages);
  }
  if (history?.events?.length) {
    const events = block('事件时间线', String(history.events.length));
    events.append(renderHistory(history.events, { running: task.status === 'running', truncated: history.truncated,
      cursor: history.cursor, onMore: history.onMore, taskId: task.id }));
    panel.append(events);
  }

  if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
    const follow = block('追加说明');
    const form = el('form'), input = el('textarea');
    input.placeholder = '追加要求；Agent 正在调用时会在本轮结束后立即读到'; input.required = true; input.rows = 3;
    input.addEventListener('input', () => { ui.detailDirty = true; });
    form.append(input, button('追加说明', async () => { await action('task.message', { id: task.id, body: input.value }); ui.detailDirty = false; await detail(task.id); }, undefined,
      { agent: true, help: agentHelp('把这条补充说明发给该任务的 Agent。若它正在调用，会请它在当前一轮工具都结束后收尾（不杀进程、不打断正在执行的命令），下一轮先看这条说明。') }));
    form.onsubmit = event => { event.preventDefault(); form.querySelector('button').click(); };
    follow.append(form); panel.append(follow);
  }
}
export function renderDetailError(taskId, message) {
  const panel = $('detail');
  panel.replaceChildren(el('h2', `无法打开 #${taskId}`), el('p', message, 'error'));
}
