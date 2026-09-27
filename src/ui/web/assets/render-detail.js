import { $, badge, block, button, el, kv, roleBadge, routeBadge, statusBadge } from './dom.js';
import { action } from './api.js';
import { confirmDialog, promptDialog } from './dialog.js';
import { INTEGRATION, ROLE, TERMINAL_STATUS, absolute, duration, edgeLabel, relative, resolverOf, runWorkMs, statusOf, apTitle, worktreeLabel } from './format.js';
import { agentHelp } from './help.js';
import { freezeBlocker } from './merge-select.js';
import { show } from './messages.js';
import { detail, overview } from './navigate.js';
import { renderAgent } from './render-agent.js';
import { renderDiff } from './render-diff.js';
import { deliveryControls } from './render-delivery.js';
import { renderHistory } from './render-history.js';
import { formatProgressDuration, renderAPProgress } from './render-progress.js';
import { noticePanel } from './render-notices.js';
import { questionnairePanel } from './render-questionnaire.js';
import { renderResolutions } from './render-resolutions.js';
import { specItem } from './render-specs.js';
import { renderVerifications } from './render-verify.js';
import { renderShowcase } from './render-showcase.js';
import { ui } from './state.js';
import { agentText } from './text.js';
import { referenceable } from './context-references.js';

const freezeOf = ap => freezeBlocker(ap.target_branch, ap, ui.lastSnapshot?.status?.merge_freeze || []);
/** AP 依赖：本 AP 等谁、谁在等它。 */
function renderDeps(ap) {
  const section = block('AP 依赖');
  section.append(el('p', ap.deps?.length ? `本 AP 等这些结算：${ap.deps.map(edgeLabel).join('、')}` : '本 AP 不依赖其他 AP。', 'hint'));
  section.append(el('p', ap.dependents?.length ? `这些 AP 在等它：${ap.dependents.map(edgeLabel).join('、')}` : '没有 AP 在等它。', 'hint'));
  return section;
}
/** planner 这一轮写下的拆解 / scheduler 这一批取走的 spec：只读，和左侧队列同一套行。 */
function renderAPSpecs(ap) {
  const specs = ap.specs || [];
  const section = block('拆解队列', String(specs.length));
  section.append(el('p', ap.role === 'scheduler'
    ? '本 AP 这一批取走的 spec：每一条都要有归宿——spawn 成 AP，或明确丢弃。'
    : '这一轮写下的拆解（等 scheduler 编排）：scheduler 会把它们一次性编排成真实 AP，批内没有依赖边的会同时开工。', 'hint'));
  if (!specs.length) section.append(el('p', '这一批是空的。', 'hint'));
  for (const spec of [...specs].sort((a, b) => a.id - b.id)) section.append(specItem(spec));
  return section;
}
/** 详情头部的意图编号（inputs.id）：点开对应意图的 planner 详情。
 *  input_id 为空（如 scheduler）就不显示，免得出现「意图 #null」；对不上意图或它还没有 planner AP 时退化成不可点的普通 badge。 */
function intentBadge(ap) {
  const inputId = ap.input_id;
  if (inputId === null || inputId === undefined) return null;
  const intent = (ui.lastSnapshot?.inputs || []).find(row => row.id === inputId) || null;
  const node = intent?.ap_id ? button(`意图 #${inputId}`, () => { ui.noticeFocus = null; return detail(intent.ap_id); }, 'badge b-neutral') : badge(`意图 #${inputId}`, 'b-neutral');
  if (intent?.content) node.title = String(intent.content).slice(0, 200);
  if (intent?.ap_id) {
    node.classList.add('intent-link');
    node.title = `${node.title ? `${node.title}\n` : ''}点开看这条意图的规划与拆解`;
    node.onclick = () => { ui.noticeFocus = null; return detail(intent.ap_id); };
  }
  return node;
}
export function renderDetail(ap, history, diff, usage) {
  const panel = $('detail');
  const reading = panel.dataset.apId === String(ap.id) ? panel.querySelector('.transcript') : null;
  panel.dataset.view = 'ap'; panel.dataset.apId = String(ap.id); panel.replaceChildren();
  referenceable(panel, { kind: 'ap', target: { ap_id: ap.id }, label: `AP #${ap.id}`,
    quote: `${ap.goal}\n状态：${statusOf(ap).label} · ${ROLE[ap.role] || ap.role}`, location: { view: 'ap-detail', ap_id: ap.id } });
  const breadcrumb = el('div', undefined, 'breadcrumb');
  breadcrumb.append(button('项目概览', () => overview(), 'link'), el('span', '/'), el('span', `${ROLE[ap.role] || ap.role} #${ap.id}`));
  panel.append(breadcrumb);
  const hero = el('div', undefined, 'ap-hero');
  const head = el('div', undefined, 'head');
  head.append(el('span', `#${ap.id}`, 'tid-lg'), statusBadge(ap),
    roleBadge(ap.role), ...(ap.route ? [routeBadge()] : []), intentBadge(ap));
  const integration = INTEGRATION[ap.integration];
  if (integration) head.append(badge(integration, ap.integration === 'merged' ? 'b-completed' : 'b-awaiting'));
  if (ap.ap_kind === 'analysis') head.append(badge('只读分析', 'b-neutral'));
  if (ap.agent) head.append(badge(`agent ${ap.agent.id}${ap.agent.active ? ` · pid ${ap.agent.pid ?? '待上报'}` : ' · 空闲'}`, 'b-neutral'));
  hero.append(head, el('h1', apTitle(ap), 'ap-title')); panel.append(hero);

  const notice = ui.noticeFocus === null ? null : ui.noticeIndex.get(ui.noticeFocus);
  if (notice && notice.ap_id === ap.id) panel.prepend(noticePanel(notice, ap));

  const actions = el('div', undefined, 'actions ap-actions');
  const stacked = (ap.deps || []).filter(edge => edge.kind === 'code');
  const freeze = freezeOf(ap);
  const resolver = resolverOf(ap);
  const deliveryItem = (ui.lastSnapshot?.ladder?.groups || []).flatMap(group => group.items || []).find(item => item.id === ap.id) || null;
  if (!ap.ap_kind && freeze) {
    // 同一目标分支上有没解决的冲突：这里点合并只会失败，所以禁用并指向那个 AP。
    const node = button('合并已被冻结', () => {}, 'ghost');
    node.disabled = true;
    // 禁用的按钮不派发指针事件，data-help 放外层 span.help-host。
    const host = el('span', undefined, 'help-host');
    host.setAttribute('data-help', `#${freeze.ap_id} 的合并冲突还没解决：先处理它的待决问题（或让它的解冲突 AP 作废），${ap.target_branch} 上的合并才能继续。`);
    host.append(node);
    actions.append(host);
  } else if (!ap.ap_kind && ap.status === 'completed' && ['pending', 'review', 'conflict'].includes(ap.integration)) {
    const live = resolver && !TERMINAL_STATUS.has(resolver.status);
    const readyResolver = resolver && resolver.status === 'completed' && ['pending', 'review'].includes(resolver.integration)
      && deliveryItem?.phase !== 'resolution_stale';
    const retry = ap.integration === 'conflict';
    const label = readyResolver ? `审阅并落地解冲突结果 #${resolver.id}` : live ? `解冲突 AP #${resolver.id} 进行中`
      : retry ? '重新尝试合并' : ap.integration === 'review' ? '检查后重新批准合并' : '批准合并';
    const node = button(label, async () => {
      if (readyResolver) return detail(resolver.id);
      const caveats = [];
      if (stacked.length) caveats.push(`本 AP stacked 在 #${stacked.map(edge => edge.id).join('、')} 之上，必须先合并上游，否则会把它的改动一起带进来。`);
      if (ap.resolves_ap_id) caveats.push('这是解冲突 AP：落地用 --ff-only，落地的树就是它测过的那棵树。');
      if (resolver) caveats.push(`解冲突 AP #${resolver.id} 还没落地：重新尝试会明确废弃它（分支与目录仍保留）。`);
      const confirmed = await confirmDialog({
        title: retry ? `重新尝试把 ${ap.branch} 合并到 ${ap.target_branch}？` : `将 ${ap.branch} 合并到 ${ap.target_branch}？`,
        message: retry ? '如果还冲突，会再开一轮解冲突 AP。请先审阅代码和测试结果。' : '请先审阅代码和测试结果。',
        detail: caveats.join('\n\n') || null,
        confirmLabel: retry ? '重新尝试' : '合并',
      });
      if (!confirmed) return;
      const result = await action('ap.merge', { id: ap.id });
      if (result?.merge?.status === 'conflict') show(`合并冲突：已开解冲突 AP #${result.merge.resolution_ap_id}，请处理左侧的待决问题（${ap.target_branch} 上的其它合并已冻结）。`, 'error');
      else if (result?.merge?.status === 'resolved') show(`冲突已解决：原 AP #${result.merge.resolved_ap_id} 也标成已合并。`);
      await detail(ap.id);
    });
    if (live) {
      node.disabled = true;
      const host = el('span', undefined, 'help-host');
      host.setAttribute('data-help', `#${resolver.id} 正在解冲突：等它结束，或者先取消它再重试。`);
      host.append(node);
      actions.append(host);
    } else actions.append(node);
  }
  const settledShowcase = ap.ap_kind === 'say' && ap.reservation?.kind === 'showcase'
    && ['completed','failed','cancelled'].includes(ap.reservation.status);
  if (['failed', 'cancelled'].includes(ap.status) && ['say','child'].includes(ap.ap_kind)
    && !settledShowcase && !ap.divergence_resolution) actions.append(button('检查后重试', async () => {
    const confirmed = await confirmDialog({ title: `重试 AP #${ap.id}？`,
      message: '先检查失败工作区与提交。重试不会回滚此前 Agent 的文件副作用。', confirmLabel: '重试',
      agent: true, confirmHelp: agentHelp('重新启动这条 AP 的 Agent；已有工作区和历史保留。') });
    if (!confirmed) return;
    await action('ap.retry', { id: ap.id }); await detail(ap.id);
  }, 'ghost', { agent: true, help: agentHelp('检查失败现场后再启动一次 Agent，不清理历史或用户改动。') }));
  const reclaimable = ap.status === 'completed' && ['merged', 'none', 'superseded'].includes(ap.integration) && (ap.workspace || ap.branch);
  if (reclaimable) actions.append(button('回收工作区与分支', async () => {
    const plan = [ap.workspace && `删除 ${ap.workspace}`, ap.branch && `回收分支 ${ap.branch}`].filter(Boolean).join('\n');
    const confirmed = await confirmDialog({
      title: '回收工作区与分支？',
      message: `只有分支顶端就是审阅过的那次提交、且已经进入 ${ap.target_branch} 时才删；否则分支保留并在事件里说明原因。`,
      detail: plan || null,
      confirmLabel: '回收',
      danger: true,
    });
    if (!confirmed) return;
    await action('ap.cleanup', { id: ap.id }); await detail(ap.id);
  }, 'ghost', { help: '删除这条 AP 的 worktree 与本地分支；只有分支已进入目标分支且顶端就是审阅过的提交时才真删，否则保留并在事件里说明原因。' }));
  if (reclaimable && ap.workspace && ap.branch) actions.append(button('只回收 worktree（保留分支）', async () => { await action('ap.cleanup', { id: ap.id, keep_branch: true }); await detail(ap.id); }, 'ghost',
    { help: '只删除 worktree、保留本地分支；未提交的改动会随 worktree 一起丢失。' }));
  const verifications = ap.verifications || [];
  // 没有代码改动的 say 给一个与「取消」区分的收尾：已解决=没有别的需求，取消=因别的原因放弃。
  const noCommittedChange = !ap.head_commit || !ap.base_commit || ap.head_commit === ap.base_commit;
  if (ap.ap_kind === 'say' && !TERMINAL_STATUS.has(ap.status) && noCommittedChange
    && ap.reservation?.kind !== 'showcase') actions.append(button('已解决', async () => {
    const confirmed = await confirmDialog({
      title: `把 say #${ap.id} 标记为已解决？`,
      message: '适用于这次输入只是想了解/确认、没有代码改动的情况：AP 结算为「已完成」，答案作为结果保留，并解除它占用的唤醒。它与「取消 AP 树」不同——那是因别的原因放弃正在进行的工作；这里代表你确认没有别的需求了。如需继续追问，请在标记前直接给这个 AP 发消息；标记后请作为新的 say 发送。',
      confirmLabel: '标记已解决',
      confirmHelp: '仅在没有提交、工作区干净时允许；AP 变为已完成，不发起合并请求，也不删除分支与工作区。',
    });
    if (!confirmed) return;
    try { await action('ap.resolve', { id: ap.id }); show(`say #${ap.id} 已标记为已解决`); }
    catch (error) { show(error.message, 'error'); }
    await detail(ap.id);
  }, 'ghost', { help: '把没有代码改动的 say 结算为已完成（保留答案），用来区分「没有别的要求」和「取消 AP 树」；有提交时请改用请求合并或取消。' }));
  if (['say','child'].includes(ap.ap_kind) && !['completed', 'failed', 'cancelled'].includes(ap.status)) actions.append(button('取消 AP 树', async () => {
    const confirmed = await confirmDialog({
      title: '取消这个 AP 树？',
      message: '取消这个 AP 及所有子 AP；工作区会保留。',
      confirmLabel: '取消 AP',
      cancelLabel: '保留',
      danger: true,
    });
    if (confirmed) await action('ap.cancel', { id: ap.id });
    await detail(ap.id);
  }, 'danger', { help: '取消这个 AP 及它下面的全部子 AP，工作区与分支保留；取消后无法恢复。' }));
  if (ap.divergence_resolution) {
    actions.append(button(`查看源 say #${ap.parent_id}`, () => detail(ap.parent_id), 'link'));
  }
  actions.append(button('刷新详情', () => detail(ap.id), 'ghost'));
  panel.append(actions);
  if (ap.divergence_resolution && TERMINAL_STATUS.has(ap.status) && ap.integration !== 'merged') {
    const archived = ap.divergence_resolution.branch_status === 'archived';
    // 三种来源：终态 say 的独立解分歧（runtime 驱动）、活动 say 自己的合并请求（用户驱动），
    // 或一个已完子 AP 的固定提交（直接父 Agent 驱动）。
    const terminalSay = ap.resolves_ap_id !== null
      && ap.resolves_ap_id === ap.divergence_resolution.source_ap_id;
    const repairsSay = ap.divergence_resolution.source_ap_id === ap.parent_id;
    const retry = terminalSay
      ? `返回源 say #${ap.divergence_resolution.source_ap_id}，在分歧仍存在且预约可分派时可重新派独立子 AP。`
      : repairsSay
        ? '返回源 say，在静息且分歧仍存在时可重新派独立子 AP。'
        : `由直接父 Agent #${ap.parent_id} 再派一个以同一固定提交为基线的解分歧子 AP（ap resolve-child-divergence）。`;
    panel.append(el('p', archived
      ? `解分歧子 AP 已归档，AP、固定提交记录和会话仍保留。${retry}`
      : `解分歧成果尚未集成：先检查工作区和固定提交。需要另试时，在分支图显式归档这条子分支（删除 ref/worktree；未提交文件会丢失），${retry}不会重放本次 Agent。`,
    'hint delivery-reason'));
  }
  const delivery = deliveryControls(ap, { refresh: () => detail(ap.id) });
  if (delivery) panel.append(delivery);

  // 结果与失败原因优先于调用次数、目录等底层元数据。完整目标（goal）以 Markdown 正文排在结果之前。
  if (ap.goal) {
    const goal = block('AP 目标'); goal.classList.add('goal-panel');
    goal.append(agentText(ap.goal, { className: 'goal-text', plain: 'div' }));
    panel.append(goal);
  }
  const endedAt = [...(ap.runs || [])].reverse().find(run => run.ended_at)?.ended_at ?? ap.updated_at;
  const progress = renderAPProgress(ap.progress, { status: ap.status, endedAt });
  if (progress) panel.append(progress);
  if (ap.role === 'showcase') panel.append(renderShowcase(ap));
  if (ap.result) {
    const result = block('结果'); result.classList.add('result-panel'); result.append(agentText(ap.result, { plain: 'pre' }));
    referenceable(result, { kind: 'result', target: { ap_id: ap.id, section: 'result' }, label: `AP 结果 #${ap.id}`,
      quote: ap.result, location: { view: 'ap-detail', ap_id: ap.id, section: 'result' } });
    panel.append(result);
  }
  if (ap.error) { const error = block('错误'); error.classList.add('error-panel'); error.append(agentText(ap.error, { className: 'error', plain: 'pre' })); panel.append(error); }
  if (ap.integration_error) { const error = block('合并错误'); error.classList.add('error-panel'); error.append(agentText(ap.integration_error, { className: 'error', plain: 'pre' })); panel.append(error); }

  if (ap.calls) panel.append(renderAgent(ap, usage, reading));

  const stats = block('状态'); stats.classList.add('ap-stats');
  const grid = el('div', undefined, 'grid');
  grid.append(kv('调用次数', `${ap.calls}（本次尝试）`));
  // 墙钟耗时包含静息等待，单看它会把等待算成 Agent 的处理时间；有 run 时同时给出工作与等待拆分。
  const wallEnd = ap.status === 'running' ? new Date().toISOString() : ap.updated_at;
  const workMs = runWorkMs(ap.runs);
  const wallMs = Date.parse(wallEnd) - Date.parse(ap.created_at);
  const waited = Number.isFinite(wallMs) ? Math.max(0, wallMs - workMs) : 0;
  grid.append(kv(ap.status === 'running' ? '本次已运行' : '耗时', workMs > 0 && waited > 0
    ? `${duration(ap.created_at, wallEnd)}（工作 ${formatProgressDuration(workMs)} · 等待 ${formatProgressDuration(waited)}）`
    : duration(ap.created_at, wallEnd)));
  grid.append(kv('创建', `${absolute(ap.created_at)}`, 'mono'));
  grid.append(kv('最后更新', `${absolute(ap.updated_at)} · ${relative(ap.updated_at)}`));
  stats.append(grid); panel.append(stats);
  if (ap.specs) panel.append(renderAPSpecs(ap));
  panel.append(renderDeps(ap));
  if ((ap.resolutions || []).length) panel.append(renderResolutions(ap));

  if (ap.branch || ap.workspace) {
    const workspace = block('工作区');
    // 展示 AP 的检出是 detached worktree，不是分支工作区：这里必须写明，不能让一行裸路径被误认成源分支。
    const text = ap.role === 'showcase' && ap.workspace
      ? `${worktreeLabel(ap)}：${ap.workspace}`
      : [ap.branch, ap.workspace].filter(Boolean).join('\n');
    workspace.append(el('p', text, 'mono'));
    panel.append(workspace);
  }
  panel.append(renderDiff(diff, ap.id));
  if (ap.role === 'verifier' || verifications.length || (ap.role === 'worker' && ap.status === 'completed' && ap.workspace && ap.head_commit)) panel.append(renderVerifications(ap));

  if (ap.children?.length) {
    const children = block('子 AP', String(ap.children.length));
    for (const child of ap.children) {
      const row = el('div', undefined, 'row');
      row.append(el('span', statusOf(child).icon, `dot c-${child.status}`), el('span', `#${child.id}`, 'tid'));
      const jump = button(`${child.goal}`, () => detail(child.id), 'link');
      row.append(jump, el('span', relative(child.updated_at), 'when'));
      referenceable(row, [
        { kind: 'ap', target: { ap_id: child.id }, label: `AP #${child.id}`, quote: child.goal, location: { view: 'ap-detail', ap_id: child.id } },
        { kind: 'ap_subtree', target: { ap_id: child.id }, label: `AP 子树 #${child.id}`, quote: child.goal, location: { view: 'ap-detail', ap_id: child.id } },
      ]);
      children.append(row);
    }
    panel.append(children);
  }
  const decisions = (ap.notices || []).filter(notice => notice.kind === 'questionnaire');
  if (decisions.length) {
    const record = block('决策记录', String(decisions.length));
    for (const notice of decisions) {
      if (notice.status === 'open') record.append(button(`待回答：${notice.title}`, () => {
        ui.noticeIndex.set(notice.id, notice); ui.noticeFocus = notice.id; return detail(ap.id);
      }, 'ghost'));
      else {
        const fold = el('details');
        fold.append(el('summary', `${notice.title} · ${notice.status === 'answered' ? '已回答' : '已忽略'}`), questionnairePanel(notice));
        record.append(fold);
      }
    }
    panel.append(record);
  }
  if (ap.messages?.length) {
    const messages = block('消息', String(ap.messages.length));
    for (const message of ap.messages) {
      const item = el('div', undefined, 'msg');
      item.append(el('small', `${message.sender_id ? `来自 #${message.sender_id}` : '来自你'} · ${absolute(message.created_at)}`), el('p', message.body));
      referenceable(item, { kind: 'message', target: { ap_id: ap.id, message_id: message.id }, label: `AP #${ap.id} 的消息`,
        quote: message.body, location: { view: 'ap-detail', ap_id: ap.id, section: 'messages' } });
      messages.append(item);
    }
    panel.append(messages);
  }
  if (history?.events?.length) {
    const events = block('事件时间线', String(history.events.length));
    events.append(renderHistory(history.events, { running: ap.status === 'running', truncated: history.truncated,
      cursor: history.cursor, onMore: history.onMore, apId: ap.id }));
    panel.append(events);
  }

  if (['say','child'].includes(ap.ap_kind) && !['completed', 'failed', 'cancelled'].includes(ap.status)) {
    const follow = block('追加说明');
    const form = el('form'), input = el('textarea');
    input.placeholder = '追加要求；Agent 正在调用时会在本轮结束后立即读到'; input.required = true; input.rows = 3;
    input.addEventListener('input', () => { ui.detailDirty = true; });
    form.append(input, button('追加说明', async () => { await action('ap.message', { id: ap.id, body: input.value }); ui.detailDirty = false; await detail(ap.id); }, undefined,
      { agent: true, help: agentHelp('把这条补充说明发给该 AP 的 Agent。若它正在调用，会请它在当前一轮工具都结束后收尾（不杀进程、不打断正在执行的命令），下一轮先看这条说明。') }));
    form.onsubmit = event => { event.preventDefault(); form.querySelector('button').click(); };
    follow.append(form); panel.append(follow);
  }
}
export function renderDetailError(apId, message) {
  const panel = $('detail');
  panel.replaceChildren(el('h2', `无法打开 #${apId}`), el('p', message, 'error'));
}
