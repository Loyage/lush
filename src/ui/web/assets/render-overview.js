import { $, block, button, el, kv } from './dom.js';
import { action } from './api.js';
import { HOT, STATUS, absolute, statusOf } from './format.js';
import { mergeCandidates } from './merge-select.js';
import { detail, overview } from './navigate.js';
import { renderLadder } from './render-ladder.js';
import { openNotice } from './render-notices.js';
import { renderTimeline } from './render-timeline.js';
import { ui } from './state.js';

export function renderOverview(data) {
  // 计划审批（kind='plan'）在「历史输入」的意图行上批，不在这个问答面板里：列出来点开只会是空动作（openNotice 只认非 plan 的 notice）。
  const open = data.notices.filter(notice => notice.status === 'open' && notice.kind !== 'plan');
  const key = JSON.stringify([data.status.tasks, data.status.agents, data.status.agents_idle, data.status.pending_merges, data.status.drafts, open.map(n => n.id),
    data.tasks.length, data.status.project, data.status.version, data.status.fingerprint, data.status.started_at,
    // 时间轴的开口段一直在长，但只在结构变化或每 15 秒才需要重画一次，免得轮询把滚动位置冲掉。
    Math.floor(Date.now() / 15000),
    (data.timeline?.tasks || []).map(task => `${task.id}:${task.status}:${task.segments.length}`).join(','),
    (data.ladder?.nodes || []).map(node => `${node.id}:${node.level}:${node.deps.length}:${node.covered_by.join('|')}`).join(','),
    (data.ladder?.groups || []).flatMap(group => group.items || []).map(item => `${item.id}:${item.source_task_id}:${item.phase}:${item.ready}:${(item.blockers || []).map(blocker => blocker.code).join('|')}`).join(','),
    // 冻结状态一变，可合并集合与勾选可用性就跟着变，所以它也必须进 key。
    (data.status.merge_freeze || []).map(row => `${row.task_id}:${row.target_branch}:${row.resolves_task_id ?? '-'}`).join(',')]);
  if (key === ui.overviewKey) return;
  ui.overviewKey = key;
  const panel = $('detail');
  const expanded = new Set([...panel.querySelectorAll('details[data-fold]')].filter(node => node.open).map(node => node.dataset.fold));
  panel.dataset.view = 'overview'; panel.replaceChildren();
  const count = status => data.status.tasks.find(row => row.status === status)?.count ?? 0;
  const pending = mergeCandidates(data.tasks, { nodes: data.ladder?.nodes || [], groups: data.ladder?.groups || [], freeze: data.status.merge_freeze || [] }).length;
  const head = el('div', undefined, 'overview-hero');
  const intro = el('div');
  intro.append(el('span', 'WORKSPACE / 项目工作台', 'eyebrow'), el('h1', '项目概览'),
    el('p', open.length ? `有 ${open.length} 个问题等待你的决定。先疏通阻塞，让工作继续向前。`
      : pending ? `${pending} 个变更等待交付。审阅成果，再让它们进入目标分支。`
      : count('running') ? 'Agent 正在并行工作。这里汇集进展、决策与交付。' : '一切就绪。写下下一个想法，让项目继续生长。', 'hero-description'));
  const mark = el('div', '✳', 'hero-mark'); mark.setAttribute('aria-hidden', 'true');
  head.append(intro, mark); panel.append(head);

  const metrics = el('div', undefined, 'metrics');
  for (const [label, value, note, tone] of [
    ['正在运行', count('running'), `${data.status.agents.length} 个 agent 在线 · 并发 ${data.status.concurrency}`, 'blue'],
    ['待你决定', open.length, open.length ? '待决问题 · 需要你的判断' : '没有等待答复的问题', 'amber'],
    ['待交付', pending, '完成不等于合并 · 审阅后落地', 'violet'],
    ['已完成', count('completed'), '任务执行完成，交付状态单独追踪', 'green'],
  ]) {
    const card = el('div', undefined, `metric tone-${tone}`);
    card.append(el('span', label, 'metric-label'), el('strong', String(value), 'metric-value'), el('span', note, 'metric-note'));
    metrics.append(card);
  }
  panel.append(metrics);
  const distribution = el('div', undefined, 'status-distribution');
  distribution.append(el('span', '任务状态', 'distribution-label'));
  for (const status of Object.keys(STATUS)) {
    distribution.append(el('span', `${statusOf({ status }).icon} ${statusOf({ status }).label} ${count(status)}`, `status-chip c-${status}`));
  }
  panel.append(distribution);

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
  panel.append(notices, renderLadder(data));
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
      if (!confirm(`删除全部 ${data.tasks.length} 个已结束任务？`)) return;
      if (!confirm('再次确认：库里的任务、输入与事件将不可恢复；已进目标分支的 worktree 目录与分支会一并删除，未合并的保留。')) return;
      const result = await action('task.clear');
      await overview();
      $('error').textContent = `已清空 ${result.cleared.tasks} 个任务、${result.cleared.inputs} 条输入；回收 ${result.reclaimed?.worktrees ?? 0} 个 worktree、${result.reclaimed?.branches ?? 0} 个分支、${result.reclaimed?.anchors ?? 0} 个输入锚点，保留 ${result.retained.tasks.length} 个`;
    }, 'danger'));
    maintenance.append(actions);
  }
  const tools = el('details', undefined, 'disclosure maintenance'); tools.dataset.fold = 'maintenance'; tools.open = expanded.has('maintenance');
  tools.append(el('summary', '维护与安全回收'), maintenance); panel.append(tools);
}
