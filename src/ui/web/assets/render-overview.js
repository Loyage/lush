import { $, block, button, el, kv } from './dom.js';
import { action } from './api.js';
import { confirmDialog } from './dialog.js';
import { HOT, absolute, relative } from './format.js';
import { edgeRelation, graphLayout, graphRenderKey, isWorkingTask } from './graph-layout.js';
import { detail, graph, overview } from './navigate.js';
import { openNotice } from './render-notices.js';
import { show } from './messages.js';
import { renderTimeline } from './render-timeline.js';
import { ui } from './state.js';

/**
 * Intent-first overview: user goals and frozen review candidates are the primary line. Branch data remains a
 * secondary delivery diagnostic for divergence, recovery and explicit Git operations.
 *
 * 分支事实来自 `graph.get`，与「分支图」共用同一份 `ui.lastGraph`（refresh.js 按同一条陈旧规则
 * 决定要不要重拉），概览不新增 RPC、也不各自打 git；拿不到图时先给占位文案、只画快照支撑得住的部分。
 *
 * 与任务为中心的旧版相比：不再有任务状态分布 chips 与按目标分支分组的交付队列（renderLadder）；
 * 「需要你的决定」「运行中的 agent」与时间轴仍保留，但排在分支主线之后，运行时与维护信息照旧折叠。
 */

/** 分支来源 -> 中文描述（与分支图的 BRANCH_ORIGIN 同口径）。 */
const BRANCH_ORIGIN = {
  input: '输入锚点',
  task: '任务分支',
  registered: '已登记',
  local: '本地分支',
  placeholder: '占位',
};

const noticeTime = notice => {
  const ms = Date.parse(notice?.created_at);
  return Number.isFinite(ms) ? ms : 0;
};

/** 分支森林按前序摊平：父在前、子在后，保持谱系顺序。 */
function flattenBranches(forest) {
  const out = [];
  const walk = entry => { out.push(entry); for (const child of entry.children) walk(child); };
  for (const root of forest) walk(root);
  return out;
}

/**
 * 这条分支为什么该被收口（成员判定只看 fork 边上的三个动作标志与 blocker，配合 edgeRelation 的
 * 关系补文案）：可合入父分支 / 分歧需在子分支解决 / 落后父分支可跟上。
 */
function closingReasons(entry) {
  const edge = entry?.incoming;
  if (!edge) return [];
  const relation = edgeRelation(edge);
  const reasons = [];
  if (edge.can_merge || relation?.key === 'ahead') reasons.push({ key: 'merge', label: '待合入父分支' });
  if (edge.can_sync || relation?.key === 'diverged') reasons.push({ key: 'sync', label: '父子已分歧' });
  if (edge.can_catchup || relation?.key === 'behind') reasons.push({ key: 'catchup', label: '落后父分支' });
  return reasons;
}

/** 待收口：三个动作里至少一个可做，或有未收拢的子分支（先收拢子分支）。 */
function needsClosing(entry) {
  return closingReasons(entry).length > 0 || Boolean(entry?.incoming?.blockers?.length);
}

function blockerText(blockers = []) {
  const tasks = blockers.filter(value => String(value).startsWith('task:#')).map(value => String(value).slice('task:'.length));
  const branches = blockers.filter(value => !String(value).startsWith('task:#'));
  return [tasks.length ? `等待任务 ${tasks.join('、')} 完成` : null,
    branches.length ? `先收拢子分支：${branches.join('、')}` : null].filter(Boolean).join('；');
}

/** 一条待收口分支：分支名、与父分支的关系与 ahead/behind、blocker 文案，以及去分支图处理的入口。 */
function closingRow(entry) {
  const edge = entry.incoming;
  const relation = edgeRelation(edge);
  const row = el('div', undefined, 'branch-row closing-row');
  row.dataset.branch = entry.name;
  row.append(el('span', `⎇ ${entry.name}`, 'branch-name mono'));
  if (relation) row.append(el('span', relation.label, `chip relation-${relation.key}`));
  if (edge && (Number.isFinite(edge.ahead) || Number.isFinite(edge.behind))) {
    row.append(el('span', `子分支 +${edge.ahead ?? '?'} / -${edge.behind ?? '?'}`, 'meta'));
  }
  for (const reason of closingReasons(entry)) row.append(el('span', reason.label, `chip reason-${reason.key}`));
  if (edge?.blockers?.length) row.append(el('span', blockerText(edge.blockers), 'hint warn'));
  // 只做导航，不给写动作：合并 / 同步 / 归档都留在分支图上完成。
  row.append(button('去分支图处理', () => graph(), 'link'));
  return row;
}

/** 一条正在工作的分支：分支名、来源或一句话标题、活跃任务数与任务链接（点开任务详情）。 */
function workingRow(entry) {
  const row = el('div', undefined, 'branch-row working-row');
  row.dataset.branch = entry.name;
  row.append(el('span', `⎇ ${entry.name}`, 'branch-name mono'));
  if (entry.title) row.append(el('span', entry.title, 'branch-title'));
  else if (entry.origin) row.append(el('span', `${BRANCH_ORIGIN[entry.origin] || entry.origin}${entry.source_id ? ` #${entry.source_id}` : ''}`, 'meta'));
  const tasks = entry.tasks.filter(isWorkingTask);
  row.append(el('span', `${tasks.length} 个活跃任务`, 'meta'));
  for (const task of tasks.slice(0, 8)) row.append(button(`#${task.id}`, () => detail(task.id), 'link'));
  return row;
}

export function renderOverview(data) {
  const intents = data.inputs || [];
  const candidates = data.candidates || [];
  const candidateByInput = new Map(candidates.map(candidate => [candidate.input_id, candidate]));
  const activeIntentIds = new Set((data.tasks || []).filter(task => HOT.has(task.status)).map(task => task.input_id).filter(Boolean));
  const reviewReady = candidates.filter(candidate => candidate.status === 'ready');
  const reviewPending = candidates.filter(candidate => candidate.status === 'pending'
    || (candidate.status === 'preparing' && !candidate.report_task_id));
  const reviewWaiting = [...reviewPending, ...reviewReady];
  // 计划审批（kind='plan'）在「历史输入」的意图行上批，不在这个问答面板里：列出来点开只会是空动作（openNotice 只认非 plan 的 notice）。
  const open = data.notices.filter(notice => notice.status === 'open' && notice.kind !== 'plan');
  // 纯提醒（kind='info'、任务结算时自动落库）不进任何待决口径，这里只读地列最近 10 条。
  const reminders = (data.notices || []).filter(notice => notice.kind === 'info')
    .sort((a, b) => noticeTime(b) - noticeTime(a) || b.id - a.id).slice(0, 10);

  const graphData = ui.lastGraph;
  const layout = graphData ? graphLayout(graphData) : null;
  const branchesReady = Boolean(layout) && layout.git && !layout.error;
  const entries = branchesReady ? flattenBranches(layout.forest).filter(entry => !entry.archived) : [];
  const closing = entries.filter(needsClosing);
  const working = entries.filter(entry => entry.status === 'active');
  // 提醒行要能写清是哪个分支：任务节点上的 branch / target_branch 是图已知的事实，取不到就不写。
  const branchByTask = new Map((graphData?.nodes || [])
    .filter(node => node.kind === 'task').map(node => [node.id, node.branch || node.target_branch || null]));

  const key = JSON.stringify([data.status.tasks, data.status.agents, data.status.agents_idle, data.status.agents_total,
    data.status.concurrency, data.status.pending_merges, data.status.drafts, data.status.project, data.status.version,
    data.status.fingerprint, data.status.started_at,
    open.map(notice => notice.id), reminders.map(notice => `${notice.id}:${notice.created_at ?? ''}`),
    intents.map(intent => `${intent.id}:${intent.status}:${intent.candidate_status ?? ''}`).join(','),
    candidates.map(candidate => `${candidate.id}:${candidate.status}:${candidate.commit_hash}`).join(','), data.tasks.length,
    // 分支主线要跟着图一起重画：指纹 + 生成时间变了就重建，重画不丢折叠与滚动。
    graphData ? graphRenderKey(graphData) : null, ui.graphFetchedAt,
    // 时间轴的开口段一直在长，但只在结构变化或每 15 秒才需要重画一次，免得轮询把滚动位置冲掉。
    Math.floor(Date.now() / 15000),
    (data.timeline?.tasks || []).map(task => `${task.id}:${task.status}:${task.segments.length}`).join(',')]);
  if (key === ui.overviewKey) return;
  ui.overviewKey = key;
  const panel = $('detail');
  const expanded = new Set([...panel.querySelectorAll('details[data-fold]')].filter(node => node.open).map(node => node.dataset.fold));
  panel.dataset.view = 'overview'; panel.replaceChildren();
  const head = el('div', undefined, 'overview-hero');
  const intro = el('div');
  const heroText = reviewWaiting.length ? `${reviewWaiting.length} 个固定 commit 的候选结果等待你处理。`
    : open.length ? `有 ${open.length} 个问题等待你的决定。先疏通阻塞，让工作继续向前。`
    : activeIntentIds.size ? `${activeIntentIds.size} 个 Intent 正在并行推进；成果会汇总成可验证候选。`
    : intents.length ? '目标都已停下来。检查候选结果，或写下下一个想法。'
    : '从一个 Intent 开始：系统会规划、并行执行、汇总证据，并交付可验收结果。';
  intro.append(el('span', 'INTENT / 目标与成果', 'eyebrow'), el('h1', 'Intent 工作台'), el('p', heroText, 'hero-description'));
  const mark = el('div', '✳', 'hero-mark'); mark.setAttribute('aria-hidden', 'true');
  head.append(intro, mark); panel.append(head);

  // Product metrics are Intent/Candidate based. Git branch metrics live in the diagnostic disclosure below.
  const metrics = el('div', undefined, 'metrics');
  for (const [label, value, note, tone] of [
    ['Intent', intents.length, intents.length ? `${activeIntentIds.size} 个正在推进` : '等待第一个目标', 'blue'],
    ['并行执行', activeIntentIds.size, `${data.status.agents.length} 个 Run 正在调用`, 'violet'],
    ['等待验收', reviewWaiting.length, reviewPending.length ? `${reviewPending.length} 个待你启动验收` : reviewReady.length ? '固定 commit · 报告已就绪' : '暂无待验收候选', 'amber'],
    ['需要你决定', open.length, open.length ? '实质问题需要你的判断' : '没有等待答复的问题', 'green'],
  ]) {
    const card = el('div', undefined, `metric tone-${tone}`);
    card.append(el('span', label, 'metric-label'), el('strong', String(value), 'metric-value'), el('span', note, 'metric-note'));
    metrics.append(card);
  }
  panel.append(metrics);

  const intentBlock = block('Intent 与最新成果', String(intents.length));
  intentBlock.classList.add('intent-overview');
  if (!intents.length) intentBlock.append(el('p', '还没有 Intent。在底部输入框描述目标即可开始。', 'empty-state compact'));
  for (const intent of intents.slice(0, 20)) {
    const candidate = candidateByInput.get(intent.id);
    const row = el('div', undefined, 'branch-row intent-result-row');
    row.append(el('span', `#${intent.id}`, 'tid'), button(intent.content, () => detail(intent.task_id), 'link'));
    if (activeIntentIds.has(intent.id)) row.append(el('span', '执行中', 'chip relation-ahead'));
    if (candidate) {
      row.append(el('span', `候选 v${candidate.version} · ${candidate.status}`, `chip ${candidate.status === 'ready' ? 'c-completed' : ''}`));
      if (candidate.status === 'pending' || (candidate.status === 'preparing' && !candidate.report_task_id)) {
        row.append(button('开始验收', () => action('candidate.verify', { id: candidate.id }), 'primary'));
      } else if (candidate.status === 'failed') {
        row.append(button('重新验收', () => action('candidate.verify', { id: candidate.id }), 'primary'));
      } else if (candidate.status === 'preparing' && candidate.report_task_id) {
        row.append(button(`查看验收任务 #${candidate.report_task_id}`, () => detail(candidate.report_task_id), 'link'));
      } else if (candidate.report_task_id && ['ready','accepted','integrated'].includes(candidate.status)) {
        const report = el('a', '打开结果', 'link'); report.href = `/api/task/${candidate.report_task_id}/report`;
        report.target = '_blank'; report.rel = 'noopener'; row.append(report);
      }
    } else if (intent.flow !== 'explain' && intent.status === 'completed') row.append(el('span', '等待生成候选', 'meta'));
    intentBlock.append(row);
  }
  panel.append(intentBlock);

  // Branch/worktree is a secondary diagnostic, not the product's primary information architecture.
  const branchArea = el('div', undefined, 'branch-overview');
  if (!layout) {
    const box = block('分支'); box.classList.add('branch-loading');
    box.append(el('p', '正在读取分支…', 'empty-state compact'));
    branchArea.append(box);
  } else if (!layout.git || layout.error) {
    const box = block('分支'); box.classList.add('branch-error');
    box.append(el('p', layout.error ? `读取 git 时出错：${layout.error}` : '读取 git 失败：这个项目不是 git 仓库', 'hint warn'));
    branchArea.append(box);
  } else if (!entries.length) {
    const box = block('分支');
    box.append(el('p', '还没有任何分支或 worktree。', 'empty-state compact'));
    branchArea.append(box);
  } else {
    const pending = block('待收口的分支', String(closing.length));
    pending.classList.add('closing-branches');
    if (!closing.length) pending.append(el('p', '没有待收口的分支，分支都已收拢。', 'empty-state compact'));
    for (const entry of closing) pending.append(closingRow(entry));
    branchArea.append(pending);

    const busy = block('正在工作的分支', String(working.length));
    busy.classList.add('working-branches');
    if (!working.length) busy.append(el('p', '当前没有正在工作的分支。', 'empty-state compact'));
    for (const entry of working) busy.append(workingRow(entry));
    branchArea.append(busy);
  }
  const branchDetails = el('details', undefined, 'disclosure');
  branchDetails.dataset.fold = 'branches'; branchDetails.open = expanded.has('branches');
  branchDetails.append(el('summary', `Git 交付诊断 · ${branchesReady ? `${closing.length} 条待收口` : '读取中'}`), branchArea);
  panel.append(branchDetails);

  // 纯提醒：不需要答复，也不进「需要你的决定」。
  const noticeBlock = block('最近提醒', String(reminders.length));
  noticeBlock.classList.add('reminder-panel');
  if (!reminders.length) noticeBlock.append(el('p', '暂无提醒。', 'empty-state compact'));
  for (const notice of reminders) {
    const row = button('', () => detail(notice.task_id), 'reminder-item');
    const branch = branchByTask.get(notice.task_id);
    row.append(el('span', relative(notice.created_at) || absolute(notice.created_at) || '', 'when'));
    if (branch) row.append(el('span', `⎇ ${branch}`, 'branch-name mono'));
    row.append(el('strong', notice.title));
    noticeBlock.append(row);
  }
  panel.append(noticeBlock);

  const notices = block('需要你的决定', String(open.length));
  notices.classList.add('attention-panel');
  if (!open.length) notices.append(el('p', '暂时没有待决问题，可以专注于正在进行的工作。', 'empty-state compact'));
  for (const notice of open) {
    const row = button('', () => openNotice(notice.id), 'attention-item');
    const text = el('span', undefined, 'attention-copy');
    text.append(el('span', `任务 #${notice.task_id} · 等待答复`, 'eyebrow'), el('strong', notice.title));
    row.append(el('span', '?', 'attention-icon'), text, el('span', '去处理 →', 'attention-action'));
    notices.append(row);
  }
  panel.append(notices);

  // 分支主线之后的次要信息：运行中的 agent 与并行时间轴。
  const activity = el('div', undefined, 'activity-grid');
  const agents = block('运行中的 agent', `${data.status.agents.length} / ${data.status.agents_total ?? data.status.agents.length}`);
  if (!data.status.agents.length) agents.append(el('p', `并发额度 ${data.status.concurrency}，当前空闲；另有 ${data.status.agents_idle ?? 0} 个 agent 待唤醒。`, 'hint'));
  else if (data.status.agents_idle) agents.append(el('p', `另有 ${data.status.agents_idle} 个 agent 空闲待唤醒。`, 'hint'));
  for (const agent of data.status.agents) {
    const row = el('div', undefined, 'row');
    row.append(el('span', '●', 'dot c-running'), el('span', agent.id ?? `#${agent.task_id}`, 'tid'),
      button('查看任务', () => detail(agent.task_id), 'link'),
      el('span', `${agent.pid ? `pid ${agent.pid}` : 'pid 待上报'} · 第 ${agent.wakes} 次唤醒`, 'when'));
    agents.append(row);
  }
  agents.classList.add('agents-panel');
  activity.append(agents, renderTimeline(data.timeline)); panel.append(activity);

  const info = block('运行时');
  const meta = el('div', undefined, 'grid');
  meta.append(kv('项目', data.status.project, 'mono'), kv('provider', data.status.provider || '—'), kv('并发额度', String(data.status.concurrency)),
    kv('待提交意图', String(data.status.drafts ?? 0)),
    kv('版本', [data.status.version, data.status.fingerprint].filter(Boolean).join(' · ') || '—', 'mono'),
    kv('状态目录', data.status.home || '—', 'mono'), kv('启动', absolute(data.status.started_at) || '—'));
  info.append(meta);
  const runtime = el('details', undefined, 'disclosure'); runtime.dataset.fold = 'runtime'; runtime.open = expanded.has('runtime');
  runtime.append(el('summary', '运行时与项目配置'), info); panel.append(runtime);

  // 一键清空：删库里的已结束任务，并按 cleanup 的安全门回收 worktree/分支，所以必须二次确认。
  const maintenance = block('维护');
  const live = data.status.tasks.filter(row => HOT.has(row.status)).reduce((sum, row) => sum + row.count, 0);
  if (live) maintenance.append(el('p', `还有 ${live} 个任务没有结束。取消它们或等它们结束之后，才能清空看板。`, 'hint'));
  else if (!data.tasks.length) maintenance.append(el('p', '任务看板是空的。', 'hint'));
  else {
    maintenance.append(el('p', `删除全部 ${data.tasks.length} 个已结束任务，以及 inputs / drafts / notices / events。能安全回收的连 worktree 目录、对照检出与任务分支、输入锚点一起删；有未合并成果或分支被改过的保留在磁盘上，返回值会列出原因。旧 task id 与 input id 不会被复用。`, 'hint'));
    const actions = el('div', undefined, 'actions');
    actions.append(button('清空任务看板', async () => {
      const first = await confirmDialog({
        title: '清空任务看板？',
        message: `删除全部 ${data.tasks.length} 个已结束任务。`,
        confirmLabel: '继续',
        danger: true,
      });
      if (!first) return;
      const second = await confirmDialog({
        title: '再次确认：清空看板',
        message: '库里的任务、输入与事件将不可恢复；已进目标分支的 worktree 目录与分支会一并删除，未合并的保留。',
        confirmLabel: '清空',
        danger: true,
      });
      if (!second) return;
      const result = await action('task.clear');
      await overview();
      show(`已清空 ${result.cleared.tasks} 个任务、${result.cleared.inputs} 条输入；回收 ${result.reclaimed?.worktrees ?? 0} 个 worktree、${result.reclaimed?.branches ?? 0} 个分支、${result.reclaimed?.anchors ?? 0} 个输入锚点，保留 ${result.retained.tasks.length} 个`);
    }, 'danger'));
    maintenance.append(actions);
  }
  const tools = el('details', undefined, 'disclosure maintenance'); tools.dataset.fold = 'maintenance'; tools.open = expanded.has('maintenance');
  tools.append(el('summary', '维护与安全回收'), maintenance); panel.append(tools);
}
