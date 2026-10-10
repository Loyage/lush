import { el } from './dom.js';
import { STATUS, INTEGRATION, taskTitle, workerNumber } from './format.js';
import { projectHref } from './route.js';

/** Read-only project card: full-project counts never inferred from the recent window. */
export function projectDevelopment(row) {
  const root = el('section', undefined, 'project-development');
  root.setAttribute('aria-label', `${row.name || '项目'}开发状态`);
  const summary = row.running === true && !row.error ? row.summary?.development : null;
  if (!summary) {
    root.append(el('p', row.running === true && !row.error
      ? '开发摘要暂不可用，请更新项目后台后刷新。'
      : '后台未运行或不可达，当前开发状态未确认。', 'hint'));
    return root;
  }
  const metrics = el('div', undefined, 'project-development-metrics');
  for (const [label, value, note, tone] of [
    ['Worker', summary.workers_total, '指令、派生与分支所有者（含历史）', 'blue'],
    ['进行中', summary.active, `${summary.agents_running} 个 Agent 正在调用`, 'violet'],
    ['待验收', summary.awaiting_acceptance, `${summary.parent_confirmation} 个派生 Worker 待父确认`, 'violet'],
    ['待我处理', row.summary.notices, '需要答复的问题', 'green'],
  ]) {
    const metric = el('div', undefined, `project-development-metric tone-${tone}`);
    metric.append(el('span', label, 'metric-label'), el('strong', String(value), 'project-development-value'), el('small', note));
    metrics.append(metric);
  }
  const distribution = el('div', undefined, 'project-development-distribution');
  distribution.setAttribute('aria-label', '全部 Worker 状态分布');
  for (const status of Object.keys(STATUS)) {
    const count = summary.counts.find(item => item.status === status)?.count;
    if (count > 0) distribution.append(el('span', `${STATUS[status].label} ${count}`, `chip c-${status}`));
  }
  const delivery = el('p', `待合并 ${summary.pending_merges} · 合并中 ${summary.merging} · 合并冲突 ${summary.merge_conflicts}`, 'hint project-development-delivery');
  const recent = el('div', undefined, 'project-development-recent');
  recent.append(el('h3', '最近 Worker'));
  if (!summary.recent_workers.length) recent.append(el('p', '还没有指令或派生 Worker。', 'hint'));
  for (const task of summary.recent_workers) {
    const item = el('div', undefined, 'project-development-worker');
    const link = el('a', undefined, 'project-development-worker-link');
    link.href = projectHref(row.id, `/#worker-${task.id}`); link.target = '_blank'; link.rel = 'noopener';
    // Use supplied metadata directly; a root-page cache cannot disambiguate project-local IDs.
    link.append(el('span', workerNumber(task), 'tid'), el('span', taskTitle(task)));
    item.append(link, el('span', STATUS[task.status]?.label || '状态未知', `chip c-${task.status}`));
    if (task.integration && task.integration !== 'none') item.append(el('span', INTEGRATION[task.integration] || '合并状态未知', 'chip'));
    recent.append(item);
  }
  root.append(metrics, distribution, delivery, recent);
  return root;
}
