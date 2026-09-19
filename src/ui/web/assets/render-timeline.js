import { block, el } from './dom.js';
import { ROLE, WAIT_REASON, clock, duration } from './format.js';

/** 并行时间轴：实心＝真的在跑，虚线＝排队，最下面一行是同时占用槽的数量。 */
export function renderTimeline(timeline) {
  const section = block('并行时间轴', `${timeline?.tasks?.length ?? 0} 个任务`);
  const tasks = timeline?.tasks || [];
  if (!tasks.length) { section.append(el('p', '还没有任务。', 'hint')); return section; }
  const start = Date.parse(timeline.start), end = Date.parse(timeline.end);
  const span = Math.max(end - start, 1);
  const pct = at => ((at - start) / span) * 100;
  section.append(el('p', `${clock(timeline.start)} → ${clock(timeline.end)}（最近 ${tasks.length} 个任务${timeline.clamped ? '，窗口已截断' : ''}）· 上限 ${timeline.concurrency} 个并发${timeline.truncated ? ' · 更早的任务没有列出' : ''}`, 'hint'));
  const chart = el('div', undefined, 'gantt');
  for (const task of tasks) {
    const row = el('div', undefined, 'gantt-row');
    row.append(el('span', `#${task.id} ${ROLE[task.role] || task.role}`, 'gantt-label'));
    const track = el('div', undefined, 'gantt-track');
    for (const segment of task.segments) {
      const left = pct(Date.parse(segment.start));
      const width = Math.max(pct(Date.parse(segment.end)) - left, 0.35);
      if (segment.kind === 'wait' && width < 0.6) continue;   // 毫秒级的调度延迟不画
      const bar = el('span', undefined, `gantt-seg ${segment.kind}${segment.open ? ' open' : ''}${segment.reason ? ` r-${segment.reason}` : ''}`);
      bar.style.left = `${left}%`; bar.style.width = `${width}%`;
      const what = segment.kind === 'run' ? '运行' : WAIT_REASON[segment.reason] || '排队';
      bar.title = `${what} ${clock(segment.start)} → ${clock(segment.end)}（${duration(segment.start, segment.end)}）${segment.blocked_by?.length ? `\n在等：${segment.blocked_by.map(taskId => `#${taskId}`).join('、')}` : ''}`;
      track.append(bar);
    }
    row.append(track); chart.append(row);
  }
  // 槽位行：按所有区间边界采样，看每个时刻到底有几个 agent 在跑。
  const limit = timeline.concurrency || 1;
  const points = [...new Set(tasks.flatMap(task => task.segments.flatMap(segment => [Date.parse(segment.start), Date.parse(segment.end)])))].sort((a, b) => a - b);
  const slotRow = el('div', undefined, 'gantt-row');
  const slotTrack = el('div', undefined, 'gantt-track slot-track');
  let peak = 0;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const from = points[index], to = points[index + 1], mid = (from + to) / 2;
    const busy = tasks.reduce((sum, task) => sum + task.segments.filter(segment => segment.kind === 'run' && Date.parse(segment.start) <= mid && Date.parse(segment.end) >= mid).length, 0);
    peak = Math.max(peak, busy);
    const bar = el('span', undefined, `gantt-seg slot-${busy === 0 ? 'idle' : busy >= limit ? 'full' : 'busy'}`);
    const left = pct(from);
    bar.style.left = `${left}%`; bar.style.width = `${Math.max(pct(to) - left, 0.2)}%`;
    bar.title = `${clock(new Date(from).toISOString())} 起同时 ${busy} 个在跑（上限 ${limit}）`;
    slotTrack.append(bar);
  }
  slotRow.append(el('span', `槽位 峰值 ${peak}/${limit}`, 'gantt-label'), slotTrack);
  chart.append(slotRow);
  section.append(chart);
  const axis = el('div', undefined, 'gantt-axis');
  axis.append(el('span', clock(timeline.start)), el('span', clock(timeline.end)));
  section.append(axis);
  section.append(el('p', '实心＝agent 真的在跑（来自 invocation 事件）；虚线＝排队，颜色区分等依赖 / 等子任务 / 等并发槽 / 等你决定。', 'hint'));
  return section;
}
