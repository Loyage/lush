import { $, badge, block, button, el, kv, statusBadge } from './dom.js';
import { action } from './api.js';
import { confirmDialog } from './dialog.js';
import { INTEGRATION, ROLE, TERMINAL_STATUS, absolute, duration, edgeLabel, relative, resolverOf, statusOf, taskTitle } from './format.js';
import { freezeBlocker } from './merge-select.js';
import { show } from './messages.js';
import { detail, overview } from './navigate.js';
import { renderAgent } from './render-agent.js';
import { renderDiff } from './render-diff.js';
import { renderHistory } from './render-history.js';
import { renderTaskProgress } from './render-progress.js';
import { noticePanel } from './render-notices.js';
import { questionnairePanel } from './render-questionnaire.js';
import { renderResolutions } from './render-resolutions.js';
import { specItem } from './render-specs.js';
import { renderVerifications } from './render-verify.js';
import { startBranchShowcase, renderShowcase } from './render-showcase.js';
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
    badge(ROLE[task.role] || task.role, 'b-neutral'), intentBadge(task));
  const integration = INTEGRATION[task.integration];
  if (integration) head.append(badge(integration, task.integration === 'merged' ? 'b-completed' : 'b-awaiting'));
  if (task.agent) head.append(badge(`agent ${task.agent.id}${task.agent.active ? ` · pid ${task.agent.pid ?? '待上报'}` : ' · 空闲'}`, 'b-neutral'));
  hero.append(head, el('h1', taskTitle(task), 'task-title')); panel.append(hero);

  const notice = ui.noticeFocus === null ? null : ui.noticeIndex.get(ui.noticeFocus);
  if (notice && notice.task_id === task.id) panel.prepend(noticePanel(notice, task));

  const actions = el('div', undefined, 'actions task-actions');
  const stacked = (task.deps || []).filter(edge => edge.kind === 'code');
  const freeze = freezeOf(task);
  const resolver = resolverOf(task);
  const deliveryItem = (ui.lastSnapshot?.ladder?.groups || []).flatMap(group => group.items || []).find(item => item.id === task.id) || null;
  if (freeze) {
    // 同一目标分支上有没解决的冲突：这里点合并只会失败，所以禁用并指向那个任务。
    const node = button('合并已被冻结', () => {}, 'ghost');
    node.disabled = true;
    node.title = `#${freeze.task_id} 的合并冲突还没解决：先处理它的待决问题（或让它的解冲突任务作废），${task.target_branch} 上的合并才能继续。`;
    actions.append(node);
  } else if (task.status === 'completed' && ['pending', 'review', 'conflict'].includes(task.integration)) {
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
    if (live) { node.disabled = true; node.title = `#${resolver.id} 正在解冲突：等它结束，或者先取消它再重试。`; }
    actions.append(node);
  }
  if (['failed', 'cancelled'].includes(task.status)) actions.append(button('检查后重试', async () => { await action('task.retry', { id: task.id }); await detail(task.id); }));
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
  }, 'ghost'));
  if (reclaimable && task.workspace && task.branch) actions.append(button('只回收 worktree（保留分支）', async () => { await action('task.cleanup', { id: task.id, keep_branch: true }); await detail(task.id); }, 'ghost'));
  const verifications = task.verifications || [];
  if (task.branch && ['worker','merger'].includes(task.role)) {
    actions.append(button('效果展示', () => startBranchShowcase(task.branch), 'primary'));
  }
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
  }, 'danger'));
  if (task.parent_id === null && task.role === 'planner') actions.append(
    button('标记为开发', async () => { await action('input.flow', { id: task.id, flow: 'develop' }); await detail(task.id); }, 'ghost'),
    button('标记为了解', async () => { await action('input.flow', { id: task.id, flow: 'explain' }); await detail(task.id); }, 'ghost'));
  actions.append(button('刷新详情', () => detail(task.id), 'ghost'));
  panel.append(actions);

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
    workspace.append(el('p', [task.branch, task.workspace].filter(Boolean).join('\n'), 'mono'));
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
    input.placeholder = '追加要求，不打断当前 agent'; input.required = true; input.rows = 3;
    input.addEventListener('input', () => { ui.detailDirty = true; });
    form.append(input, button('追加说明', async () => { await action('task.message', { id: task.id, body: input.value }); ui.detailDirty = false; await detail(task.id); }));
    form.onsubmit = event => { event.preventDefault(); form.querySelector('button').click(); };
    follow.append(form); panel.append(follow);
  }
}
export function renderDetailError(taskId, message) {
  const panel = $('detail');
  panel.replaceChildren(el('h2', `无法打开 #${taskId}`), el('p', message, 'error'));
}
