import { block, el } from './dom.js';

export function progressStats(progress) {
  const items = Array.isArray(progress?.items) ? progress.items.filter(item => item && typeof item.key === 'string' && typeof item.label === 'string') : [];
  if (items.length) {
    // 运行时插入的等待行不占计划完成度：完成数 / 总数只数 Agent 汇报的步骤，否则进度条会被等待撑歪。
    const steps = items.filter(item => item.kind !== 'wait');
    const counted = steps.length ? steps : items;
    const completed = counted.filter(item => item.status === 'completed').length;
    const current = items.find(item => item.status !== 'completed') || null;
    return { items, completed, total: counted.length, current };
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

/**
 * 读模型给出的实际耗时：优先用「工作用时 + 当前调用起点」的投影（等待已经被 runtime 排除），
 * 只有旧数据没有 work_ms 时才回落到 started_at 的墙钟计时，保证历史任务和 DOM fixture 仍能显示。
 */
export function liveProgressMs(item, now = Date.now()) {
  if (!item) return 0;
  if (item.kind === 'wait') {
    const since = Date.parse(item.waiting_since);
    return (Number(item.wait_ms) || 0) + (Number.isFinite(since) ? Math.max(0, now - since) : 0);
  }
  if (item.work_ms !== undefined && item.work_ms !== null) {
    const since = Date.parse(item.active_since);
    return (Number(item.work_ms) || 0) + (Number.isFinite(since) ? Math.max(0, now - since) : 0);
  }
  const started = Date.parse(item.started_at);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

/** 只在项目前真的在跑时挂上实时计时所需的 dataset，已完成 / 暂停的条目保持静态。 */
function applyLiveTiming(node, item) {
  if (!item) return;
  if (item.kind === 'wait') {
    if (item.waiting_since) { node.dataset.progressWaitMs = String(Number(item.wait_ms) || 0); node.dataset.progressWaitingSince = item.waiting_since; }
    return;
  }
  if (item.work_ms !== undefined && item.work_ms !== null) {
    if (item.active_since) { node.dataset.progressWorkMs = String(Number(item.work_ms) || 0); node.dataset.progressActiveSince = item.active_since; }
    return;
  }
  if (item.started_at) node.dataset.progressStartedAt = item.started_at;
}

function liveDuration(item, className = 'task-progress-duration is-running-duration', prefix = '已执行') {
  const node = el('span', `${prefix} ${formatProgressDuration(liveProgressMs(item))}`, className);
  applyLiveTiming(node, item);
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
  // 只按一个类选择实时节点：DOM stub 只认单个属性 / 类，且暂停的当前步骤没有 dataset，不能碰。
  for (const node of root.querySelectorAll('.is-running-duration')) {
    const { progressWorkMs, progressActiveSince, progressWaitMs, progressWaitingSince, progressStartedAt } = node.dataset;
    if (progressWorkMs !== undefined) {
      const since = Date.parse(progressActiveSince);
      const ms = (Number(progressWorkMs) || 0) + (Number.isFinite(since) ? Math.max(0, now - since) : 0);
      node.textContent = `已执行 ${formatProgressDuration(ms)}`;
    } else if (progressWaitMs !== undefined) {
      const since = Date.parse(progressWaitingSince);
      const ms = (Number(progressWaitMs) || 0) + (Number.isFinite(since) ? Math.max(0, now - since) : 0);
      node.textContent = `已等待 ${formatProgressDuration(ms)}`;
    } else if (progressStartedAt !== undefined) {
      node.textContent = `已执行 ${runningDuration(progressStartedAt, now)}`;
    }
  }
}

export function renderCompactProgress(progress) {
  const stats = progressStats(progress);
  if (!stats.total) return null;
  const node = el('div', undefined, 'task-progress-compact');
  const meter = el('progress', undefined, 'task-progress-meter'); meter.max = stats.total; meter.value = stats.completed;
  node.append(meter, el('span', `${stats.completed}/${stats.total}`, 'task-progress-count'),
    el('span', stats.current ? `当前：${stats.current.label}` : '计划已全部完成', 'task-progress-current'));
  if (stats.current) node.append(stats.current.kind === 'wait'
    ? liveDuration(stats.current, 'task-progress-duration is-running-duration compact-duration', '已等待')
    : liveDuration(stats.current, 'task-progress-duration is-running-duration compact-duration'));
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
  if (!indeterminate && stats.current && !terminal) caption.append(stats.current.kind === 'wait'
    ? liveDuration(stats.current, 'graph-task-progress-duration is-running-duration', '已等待')
    : liveDuration(stats.current, 'graph-task-progress-duration is-running-duration'));
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
    const wait = item.kind === 'wait';
    const done = item.status === 'completed';
    const current = !done && !reachedCurrent;
    if (current) reachedCurrent = true;
    const state = done ? 'is-complete' : current ? (terminal ? 'is-interrupted' : 'is-current') : 'is-pending';
    const row = el('li', undefined, `task-progress-step ${state}${wait ? ' is-wait' : ''}`);
    row.append(el('span', wait ? '⏳' : done ? '✓' : current ? (terminal ? '×' : '●') : '○', 'task-progress-icon'),
      el('span', item.label, 'task-progress-label'));
    if (!wait) row.append(el('code', item.key, 'task-progress-key'));
    if (wait) {
      if (done) row.append(el('span', `等待 ${formatProgressDuration(item.duration_ms ?? item.wait_ms)}`, 'task-progress-duration is-wait-duration'));
      else if (current && terminal) row.append(el('span', stoppedDuration(item.waiting_since ?? item.started_at, endedAt, status), 'task-progress-duration is-stopped-duration'));
      else if (current) row.append(liveDuration(item, 'task-progress-duration is-running-duration is-wait-duration', '已等待'));
      else row.append(el('span', '尚未发生', 'task-progress-duration is-pending-duration'));
    } else if (done) row.append(el('span', item.duration_ms === null ? '用时未知' : `用时 ${formatProgressDuration(item.duration_ms)}`,
      'task-progress-duration is-complete-duration'));
    else if (current && terminal) row.append(el('span', stoppedDuration(item.started_at, endedAt, status),
      'task-progress-duration is-stopped-duration'));
    else if (current || item.started_at) row.append(liveDuration(item));
    else row.append(el('span', terminal ? '未执行' : '尚未开始', 'task-progress-duration is-pending-duration'));
    list.append(row);
  }
  section.append(list);
  return section;
}
