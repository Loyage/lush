import { block, el } from './dom.js';

export function progressStats(progress) {
  const items = Array.isArray(progress?.items) ? progress.items.filter(item => item && typeof item.key === 'string' && typeof item.label === 'string') : [];
  if (items.length) {
    const completed = items.filter(item => item.status === 'completed').length;
    const current = items.find(item => item.status !== 'completed') || null;
    return { items, completed, total: items.length, current };
  }
  const total = Number(progress?.total), completed = Number(progress?.completed);
  if (Number.isInteger(total) && total > 0 && Number.isInteger(completed) && completed >= 0 && completed <= total) {
    const current = progress?.current && typeof progress.current.label === 'string' ? progress.current : null;
    return { items: [], completed, total, current };
  }
  return { items: [], completed: 0, total: 0, current: null };
}

export function formatProgressDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}

function runningDuration(startedAt, now = Date.now()) {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? formatProgressDuration(Math.max(0, now - started)) : '计时中';
}

function liveDuration(startedAt, className = 'task-progress-duration is-running-duration') {
  const node = el('span', `已执行 ${runningDuration(startedAt)}`, className);
  if (startedAt) node.dataset.progressStartedAt = startedAt;
  return node;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const STOPPED_LABEL = { completed: '任务结束时未完成', failed: '失败时中止', cancelled: '取消时中止' };

function stoppedDuration(startedAt, endedAt, status) {
  const started = Date.parse(startedAt), ended = Date.parse(endedAt);
  const label = STOPPED_LABEL[status] || '任务结束时中止';
  return Number.isFinite(started) && Number.isFinite(ended)
    ? `${label} · 已执行 ${formatProgressDuration(Math.max(0, ended - started))}` : label;
}

/** 不重画计划，只更新正在执行步骤的计时文本；由全局 live tick 驱动。 */
export function refreshProgressDurations(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  const now = Date.now();
  for (const node of root.querySelectorAll('[data-progress-started-at]')) {
    node.textContent = `已执行 ${runningDuration(node.dataset.progressStartedAt, now)}`;
  }
}

export function renderCompactProgress(progress) {
  const stats = progressStats(progress);
  if (!stats.total) return null;
  const node = el('div', undefined, 'task-progress-compact');
  const meter = el('progress', undefined, 'task-progress-meter'); meter.max = stats.total; meter.value = stats.completed;
  node.append(meter, el('span', `${stats.completed}/${stats.total}`, 'task-progress-count'),
    el('span', stats.current ? `当前：${stats.current.label}` : '计划已全部完成', 'task-progress-current'));
  if (stats.current) node.append(liveDuration(stats.current.started_at, 'task-progress-duration is-running-duration compact-duration'));
  return node;
}

export function renderGraphProgress(progress, { running = false, status = null } = {}) {
  const stats = progressStats(progress);
  if (!stats.total && !running) return null;
  const terminal = TERMINAL.has(status);
  const indeterminate = !stats.total;
  const node = el('div', undefined, `graph-task-progress${running ? ' is-running' : ''}${terminal ? ' is-terminal' : ''}${indeterminate ? ' is-indeterminate' : ''}`);
  const caption = el('div', undefined, 'graph-task-progress-caption');
  const label = indeterminate ? '等待 Agent 汇报计划'
    : stats.current ? `${stats.current.label}${terminal ? ` · ${STOPPED_LABEL[status] || '已中止'}` : ''}` : '计划已全部完成';
  caption.append(el('span', label, 'graph-task-progress-label'));
  if (!indeterminate && stats.current && !terminal) caption.append(liveDuration(stats.current.started_at, 'graph-task-progress-duration is-running-duration'));
  caption.append(el('span', indeterminate ? '进行中' : `${stats.completed}/${stats.total}`, 'graph-task-progress-count'));
  const track = el('div', undefined, 'graph-task-progress-track');
  const meter = el('progress', undefined, 'graph-task-progress-meter');
  if (!indeterminate) { meter.max = stats.total; meter.value = stats.completed; }
  track.append(meter); node.append(caption, track);
  return node;
}

export function renderTaskProgress(progress, { status = null, endedAt = null } = {}) {
  const stats = progressStats(progress);
  if (!stats.total) return null;
  const terminal = TERMINAL.has(status);
  const section = block('任务计划', `${stats.completed}/${stats.total}`);
  section.classList.add('task-progress-panel');
  if (terminal) section.classList.add('is-terminal', `is-terminal-${status}`);
  const meter = el('progress', undefined, 'task-progress-meter'); meter.max = stats.total; meter.value = stats.completed;
  section.append(meter);
  const list = el('ol', undefined, 'task-progress-list');
  let reachedCurrent = false;
  for (const item of stats.items) {
    const done = item.status === 'completed';
    const current = !done && !reachedCurrent;
    if (current) reachedCurrent = true;
    const state = done ? 'is-complete' : current ? (terminal ? 'is-interrupted' : 'is-current') : 'is-pending';
    const row = el('li', undefined, `task-progress-step ${state}`);
    row.append(el('span', done ? '✓' : current ? (terminal ? '×' : '●') : '○', 'task-progress-icon'),
      el('span', item.label, 'task-progress-label'), el('code', item.key, 'task-progress-key'));
    if (done) row.append(el('span', item.duration_ms === null ? '用时未知' : `用时 ${formatProgressDuration(item.duration_ms)}`,
      'task-progress-duration is-complete-duration'));
    else if (current && terminal) row.append(el('span', stoppedDuration(item.started_at, endedAt, status),
      'task-progress-duration is-stopped-duration'));
    else if (current) row.append(liveDuration(item.started_at));
    else row.append(el('span', terminal ? '未执行' : '尚未开始', 'task-progress-duration is-pending-duration'));
    list.append(row);
  }
  section.append(list);
  return section;
}
