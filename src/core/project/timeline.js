import { check, TERMINAL, bounded } from '../types.js';

/** 时间轴窗口：再老的调用线段画成一堆像素没有意义，所以只展示最近一段。 */
const TIMELINE_WINDOW_MS = 6 * 3600 * 1000;
/**
 * 一段空隙的原因。库里只留下两边的状态，所以历史上只能按"起点时上游是否已结算"近似：
 * 起点还有上游没结束 ⇒ 等依赖；否则就是排队等并发槽（等子任务/等你决定只对当前状态精确）。
 */
function waitSegment(start, end, deps, status = null, children = []) {
  if (status === 'waiting') return { kind: 'wait', start, end, reason: 'children', blocked_by: children.map(child => child.id) };
  if (status === 'awaiting') return { kind: 'wait', start, end, reason: 'user' };
  // 父任务停着不动时，先看是不是在等子任务：子任务的存活区间和这段空隙重叠就是了。
  const covering = children.filter(child => child.created_at <= end && (!child.terminal_at || child.terminal_at >= start));
  if (covering.length) return { kind: 'wait', start, end, reason: 'children', blocked_by: covering.map(child => child.id) };
  const pending = deps.filter(dep => !dep.terminal_at || dep.terminal_at > start);
  if (pending.length) return { kind: 'wait', start, end, reason: 'dep', blocked_by: pending.map(dep => dep.id) };
  return { kind: 'wait', start, end, reason: 'slot' };
}
/** 把 lifecycle 事件配成 run/wait 区间；最后一段没闭合的就是"现在还在跑/还在等"。 */
function timelineSegments(task, events, deps, children, now) {
  const segments = [];
  let cursor = task.created_at, open = null, started = false;
  for (const event of events) {
    if (event.type === 'invocation.started') {
      if (cursor < event.created_at) segments.push(waitSegment(cursor, event.created_at, deps, null, children));
      open = event.created_at; started = true;
    } else {
      // invocation.completed 与终态事件（completed/failed/cancelled）都闭合当前这段调用。
      if (open && open < event.created_at) segments.push({ kind: 'run', start: open, end: event.created_at });
      open = null; cursor = event.created_at;
    }
  }
  // 一行事件都没有就结束的任务（比如建 worktree 就失败了）不能画成空白：它就是“没跑起来”。
  if (!segments.length && !started && TERMINAL.has(task.status)) return [{ kind: 'wait', start: task.created_at, end: cursor, reason: 'setup' }];
  if (open) segments.push({ kind: 'run', start: open, end: now, open: true });
  else if (!TERMINAL.has(task.status) && cursor < now) segments.push({ ...waitSegment(cursor, now, deps, task.status, children), open: true });
  return segments;
}

/** 并发时间轴（run/wait 区间与原因）。 */
export default {
  /**
   * 只读时间轴：面板上看不出"谁和谁同时在跑"，因为并行只是并发池的副产品、串行只是依赖边的后果。
   * 这里把 events 配成真实的调用区间，空隙就是排队（等依赖或等并发槽），界面据此画泳道与槽位。
   */
  timeline({ limit = 40 } = {}) {
    const size = Number(limit);
    check(Number.isInteger(size) && size >= 1 && size <= 200, 'timeline limit must be 1..200');
    const tasks = this.store.timelineTasks(size);
    const ids = tasks.map(task => task.id);
    const edges = this.store.edgesOf(ids);
    const upstreamIds = edges.map(edge => edge.depends_on).filter(depId => !ids.includes(depId));
    const events = this.store.lifecycleEvents([...new Set([...ids, ...upstreamIds])]);
    const children = new Map();
    for (const row of this.store.childSpans(ids)) {
      if (!children.has(row.parent_id)) children.set(row.parent_id, []);
      children.get(row.parent_id).push(row);
    }
    const byTask = new Map();
    for (const event of events) {
      if (!byTask.has(event.task_id)) byTask.set(event.task_id, []);
      byTask.get(event.task_id).push(event);
    }
    const terminalAt = taskId => (byTask.get(taskId) || []).filter(row => TERMINAL.has(row.type)).at(-1)?.created_at ?? null;
    const now = new Date().toISOString();
    const rows = tasks.map(task => {
      const deps = edges.filter(edge => edge.task_id === task.id)
        .map(edge => ({ id: edge.depends_on, kind: edge.kind, terminal_at: terminalAt(edge.depends_on) }));
      return { id: task.id, parent_id: task.parent_id, input_id: task.input_id, role: task.role, name: task.name,
        status: task.status, integration: task.integration, created_at: task.created_at, updated_at: task.updated_at,
        terminal_at: terminalAt(task.id), deps, segments: timelineSegments(task, byTask.get(task.id) || [], deps, children.get(task.id) || [], now) };
    });
    const floor = Date.parse(now) - TIMELINE_WINDOW_MS;
    const earliest = Math.min(...rows.map(row => Date.parse(row.created_at)), Date.parse(now));
    const oldest = tasks[0]?.id ?? null;
    const truncated = oldest !== null && Boolean(this.store.get('SELECT id FROM tasks WHERE id<? ORDER BY id DESC LIMIT 1', oldest));
    return { now, concurrency: this.config.concurrency, start: new Date(Math.max(earliest, floor)).toISOString(), end: now,
      clamped: earliest < floor, truncated, tasks: bounded(rows, 300000) };
  }
};
