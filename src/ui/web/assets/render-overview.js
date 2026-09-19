import { $, block, button, el, kv } from './dom.js';
import { action } from './api.js';
import { HOT, STATUS, absolute, statusOf } from './format.js';
import { detail, overview } from './navigate.js';
import { renderLadder } from './render-ladder.js';
import { openNotice } from './render-notices.js';
import { renderTimeline } from './render-timeline.js';
import { ui } from './state.js';

export function renderOverview(data) {
  const open = data.notices.filter(notice => notice.status === 'open');
  const key = JSON.stringify([data.status.tasks, data.status.agents, data.status.agents_idle, data.status.pending_merges, data.status.drafts, open.map(n => n.id),
    data.tasks.length, data.status.project, data.status.version, data.status.fingerprint, data.status.started_at,
    // 时间轴的开口段一直在长，但只在结构变化或每 15 秒才需要重画一次，免得轮询把滚动位置冲掉。
    Math.floor(Date.now() / 15000),
    (data.timeline?.tasks || []).map(task => `${task.id}:${task.status}:${task.segments.length}`).join(','),
    (data.ladder?.nodes || []).map(node => `${node.id}:${node.level}:${node.deps.length}:${node.covered_by.join('|')}`).join(','),
    // 冻结状态一变，可合并集合与勾选可用性就跟着变，所以它也必须进 key。
    (data.status.merge_freeze || []).map(row => `${row.task_id}:${row.target_branch}:${row.resolves_task_id ?? '-'}`).join(',')]);
  if (key === ui.overviewKey) return;
  ui.overviewKey = key;
  const panel = $('detail'); panel.replaceChildren();
  const head = el('div', undefined, 'head');
  head.append(el('span', '项目概览', 'tid-lg'));
  panel.append(head, el('p', '从左侧选择任务，查看结果、改动、子任务与事件时间线。', 'hint'));

  const counts = block('任务');
  const grid = el('div', undefined, 'grid');
  for (const status of Object.keys(STATUS)) {
    const row = data.status.tasks.find(entry => entry.status === status);
    const cell = kv(`${statusOf({ status }).icon} ${statusOf({ status }).label}`, String(row?.count ?? 0));
    cell.querySelector('span').className = `c-${status}`;
    grid.append(cell);
  }
  counts.append(grid); panel.append(counts);

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
  panel.append(agents);

  panel.append(renderLadder(data));
  panel.append(renderTimeline(data.timeline));

  const notices = block('待决问题', String(open.length));
  if (!open.length) notices.append(el('p', '没有等你决定的问题。', 'hint'));
  for (const notice of open) {
    const row = el('div', undefined, 'row');
    row.append(el('span', `#${notice.task_id}`, 'tid'), button(notice.title, () => openNotice(notice.id), 'link'));
    notices.append(row);
  }
  panel.append(notices);

  const info = block('运行时');
  const meta = el('div', undefined, 'grid');
  meta.append(kv('项目', data.status.project, 'mono'), kv('provider', data.status.provider || '—'), kv('并发额度', String(data.status.concurrency)),
    kv('待提交意图', String(data.status.drafts ?? 0)),
    kv('版本', [data.status.version, data.status.fingerprint].filter(Boolean).join(' · ') || '—', 'mono'),
    kv('状态目录', data.status.home || '—', 'mono'), kv('启动', absolute(data.status.started_at) || '—'));
  info.append(meta); panel.append(info);

  // 一键清空：删库里的已结束任务，并按 cleanup 的安全门回收 worktree/分支，所以必须二次确认。
  const maintenance = block('维护');
  const live = data.status.tasks.filter(row => HOT.has(row.status)).reduce((sum, row) => sum + row.count, 0);
  if (live) maintenance.append(el('p', `还有 ${live} 个任务没有结束。取消它们或等它们结束之后，才能清空看板。`, 'hint'));
  else if (!data.tasks.length) maintenance.append(el('p', '任务看板是空的。', 'hint'));
  else {
    maintenance.append(el('p', `删除全部 ${data.tasks.length} 个已结束任务，以及 inputs / drafts / notices / events。能安全回收的连 worktree 目录、对照检出与任务分支一起删；有未合并成果或分支被改过的保留在磁盘上，返回值会列出原因。旧 task id 不会被新任务复用。`, 'hint'));
    const actions = el('div', undefined, 'actions');
    actions.append(button('清空任务看板', async () => {
      if (!confirm(`删除全部 ${data.tasks.length} 个已结束任务？`)) return;
      if (!confirm('再次确认：库里的任务、输入与事件将不可恢复；已进目标分支的 worktree 目录与分支会一并删除，未合并的保留。')) return;
      const result = await action('task.clear');
      await overview();
      $('error').textContent = `已清空 ${result.cleared.tasks} 个任务、${result.cleared.inputs} 条输入；回收 ${result.reclaimed?.worktrees ?? 0} 个 worktree、${result.reclaimed?.branches ?? 0} 个分支，保留 ${result.retained.tasks.length} 个`;
    }, 'danger'));
    maintenance.append(actions);
  }
  panel.append(maintenance);
}
