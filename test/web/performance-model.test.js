import { expect, test } from 'bun:test';
import { analyzePerformance } from '../../src/ui/web/assets/performance-model.js';
import { createPerformanceData } from '../../src/ui/web/assets/performance-data.js';

const at = seconds => new Date(Date.parse('2026-10-17T00:00:00Z') + seconds * 1000).toISOString();
const task = { id: 7, status: 'completed', updated_at: at(1000) };
const coverage = { history: true, runs: true, steps: true, progress: true };
const run = (id, start, end, extra = {}) => ({ id, task_id: 7, attempt: id, started_at: at(start), ended_at: end == null ? null : at(end), status: 'completed', ...extra });
const phase = (id, seconds, to = 'queued', status = to, extra = {}) => ({ id, task_id: 7, created_at: at(seconds), type: 'worker.phase_changed', data: { version: 1, to, to_status: status, ...extra } });
const start = (id, seconds, runId) => ({ id, task_id: 7, created_at: at(seconds), type: 'invocation.started', data: { run_id: runId, call: runId } });
const tool = (seq, seconds, extra = {}) => ({ seq, kind: 'tool', file: 'session-a', call_id: `call-${seq}`, tool_name: 'bash', at: at(seconds), ...extra });
const result = (seq, seconds, call, extra = {}) => ({ seq, kind: 'result', file: call.file, call_id: call.call_id, at: at(seconds), ...extra });
const analyze = (options = {}) => analyzePerformance({ task, now: at(100), coverage, ...options });

function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}

test('all invocation windows rank longest first, dedupe page overlap and join exact Run identities', () => {
  const runs = [run(1, 0, 2), run(2, 5, 12), run(1, 0, 2), run(9, 0, 100, { task_id: 99 }), run(3, 50, 51, { started_at: 'invalid' })];
  const events = [start(10, 0, 1), start(11, 0, 1), start(12, 5, 2)];
  const value = analyze({ runs, events });
  expect(value.calls.map(row => row.run_id)).toEqual([2, 1, 3]);
  expect(value.calls.map(row => row.duration_ms)).toEqual([7000, 2000, null]);
  expect(value.calls[0].source).toEqual({ kind: 'run', run_id: 2 });
  expect(value.summary.call_ms).toBe(9000); expect(value.summary.unknown_intervals).toBeGreaterThan(0);
});

test('valid overlapping and zero-duration invocations use an interval union, not summed durations', () => {
  const value = analyze({ runs: [run(1, 0, 10), run(2, 5, 12), run(3, 12, 12)] });
  expect(value.summary.call_ms).toBe(12000); expect(value.calls.at(-1).duration_ms).toBe(0);
  expect(analyze({ runs: [run(1, 0, 0)] }).summary.call_ms).toBe(0);
});

test('known non-execution phases use continuous event ranges and subtract invocation overlap', () => {
  const events = [phase(1, 0), phase(2, 10, 'waiting_children', 'waiting', { child_ids: [8] }), phase(3, 20, 'running')];
  const value = analyze({ events, ranges: [[1, 3]], runs: [run(1, 5, 12)] });
  expect(value.waits.map(row => row.duration_ms)).toEqual([10000, 10000]);
  expect(value.waits.find(row => row.state === 'waiting_children')).toMatchObject({ confirmed: true, source: { kind: 'history_event', event_id: 2 } });
  expect(value.summary.wait_ms).toBe(13000); expect(value.summary.call_ms).toBe(7000);
  expect(value.notes.join('')).toContain('剔除');
});

test('missing history ranges and discontinuous references never invent wait duration', () => {
  const events = [phase(1, 0, 'waiting_notice', 'awaiting'), phase(9, 30, 'running')];
  for (const ranges of [[], [[1, 1], [9, 9]]]) {
    const value = analyze({ events, ranges });
    expect(value.waits[0]).toMatchObject({ duration_ms: null, end: null, boundary_unknown: true });
    expect(value.summary.wait_ms).toBeNull(); expect(value.summary.unknown_intervals).toBe(1);
  }
});

test('adjacent and overlapping continuous page ranges combine without bridging missing Event IDs', () => {
  const events = [phase(1, 0), phase(10, 10, 'running')];
  for (const ranges of [[[1, 4], [5, 10]], [[1, 7], [6, 10]]]) {
    expect(analyze({ events, ranges }).summary.wait_ms).toBe(10000);
  }
  expect(analyze({ events, ranges: [[1, 4], [6, 10]] }).waits[0].duration_ms).toBeNull();
});

test('overlapping wait intervals form a union and reverse phase clocks remain unknown', () => {
  const events = [phase(1, 0), phase(2, 10, 'idle', 'waiting'), phase(3, 5, 'queued'), phase(4, 20, 'running')];
  const value = analyze({ events, ranges: [[1, 4]] });
  expect(value.summary.wait_ms).toBe(20000); expect(value.waits.at(-1).duration_ms).toBeNull();
  expect(value.summary.unknown_intervals).toBe(1);
});

test('unknown gaps retain duration without claiming a known wait category or adding it to wait totals', () => {
  const value = analyze({ runs: [run(1, 0, 5), run(2, 20, 25)], task: { ...task, children: [{ id: 9, status: 'running' }] } });
  expect(value.waits).toHaveLength(1);
  expect(value.waits[0]).toMatchObject({ kind: 'unknown', state: 'unknown', confirmed: false, duration_ms: 15000, source: null });
  expect(value.waits[0].label).toContain('未知'); expect(value.summary.wait_ms).toBeNull();
  expect(value.summary.unknown_intervals).toBe(1);
});

test('idle and unknown observation phases do not inherit reasons from current Worker children', () => {
  const events = [phase(1, 0, 'idle', 'waiting'), phase(2, 10, 'unknown', 'awaiting'), phase(3, 20, 'running')];
  const value = analyze({ events, ranges: [[1, 3]], task: { ...task, children: [{ id: 8 }] } });
  expect(value.waits.find(row => row.state === 'idle')).toMatchObject({ kind: 'wait', reason_known: false });
  expect(value.waits.find(row => row.state === 'unknown')).toMatchObject({ kind: 'unknown', reason_known: false });
  expect(value.summary.wait_ms).toBe(10000);
});

test('open calls and observed waits sample now only when lifecycle evidence proves they are current', () => {
  const running = analyze({ task: { ...task, status: 'running' }, runs: [run(1, 90, null, { status: 'running' })] });
  expect(running.calls[0]).toMatchObject({ duration_ms: 10000, open: true, end: null });
  expect(running.summary.call_ms).toBe(10000);
  const events = [phase(1, 70, 'waiting_notice', 'awaiting', { notice_ids: [42] })];
  const waiting = analyze({ task: { ...task, status: 'awaiting' }, events });
  expect(waiting.waits[0]).toMatchObject({ duration_ms: 30000, open: true }); expect(waiting.summary.wait_ms).toBe(30000);
  const stale = analyze({ task: { ...task, status: 'awaiting', calls: 2 }, events, runs: [run(2, 80, 90)] });
  expect(stale.waits[0].duration_ms).toBeNull();
});

test('malformed, missing and reverse invocation clocks remain unknown, never updated_at-derived', () => {
  const runs = [run(1, 20, 10), run(2, 0, 2, { started_at: null }), run(3, 0, null), run(4, 0, 3, { ended_at: 'invalid' })];
  const value = analyze({ runs });
  expect(value.calls.every(row => row.duration_ms === null)).toBe(true);
  expect(value.summary.call_ms).toBeNull(); expect(value.summary.unknown_intervals).toBe(4);
});

test('event-only invocations remain navigable and duplicate results or start receipts do not add calls', () => {
  const events = [start(1, 0, 20), start(2, 0, 20), { id: 3, task_id: 7, created_at: at(4), type: 'invocation.completed', data: { run_id: 20 } }];
  const value = analyze({ events });
  expect(value.calls).toHaveLength(1); expect(value.calls[0]).toMatchObject({ duration_ms: 4000, source: { kind: 'history_event', event_id: 1 } });
});

test('cross-page tools reuse same-file unique pairing, dedupe identical page rows and sort by interval', () => {
  const first = tool(1, 0), second = tool(2, 2, { tool_name: 'read' });
  const steps = [first, second, result(3, 3, second), result(4, 10, first), first];
  const value = analyze({ steps });
  expect(value.tools.map(row => row.duration_ms)).toEqual([10000, 1000]);
  expect(value.tools[0]).toMatchObject({ estimated: true, source: { kind: 'transcript_step', seq: 1 }, result_seq: 4 });
  expect(value.summary.call_ms).toBe(0); expect(value.notes.join('')).toContain('估算');
});

test('duplicate tool identities, cross-file results and duplicate outputs never guess pairings', () => {
  const call = tool(1, 0);
  for (const steps of [[call, result(2, 5, call, { file: 'other' })],
    [call, { ...call, seq: 2 }, result(3, 5, call)],
    [call, result(2, 5, call), result(3, 6, call)]]) {
    const value = analyze({ steps }); expect(value.tools.every(row => row.duration_ms === null)).toBe(true);
  }
  const other = tool(2, 0, { file: 'other', call_id: call.call_id });
  const value = analyze({ steps: [call, other, result(3, 5, call), result(4, 2, other)] });
  expect(value.tools.map(row => row.duration_ms)).toEqual([5000, 2000]);
});

test('tools preserve true zero intervals and leave inverse, missing or unordered evidence unknown', () => {
  const call = tool(2, 5);
  expect(analyze({ steps: [call, result(3, 5, call)] }).tools[0].duration_ms).toBe(0);
  for (const steps of [[call], [call, result(3, 4, call)], [call, result(1, 8, call)],
    [{ ...call, at: null }, result(3, 8, call)], [{ ...call, call_id: null }, result(3, 8, call)],
    [{ ...call, file: null }, result(3, 8, call, { file: null })]]) {
    expect(analyze({ steps }).tools[0].duration_ms).toBeNull();
  }
});

test('current and archived milestones use net projection, frozen versions cannot keep ticking', () => {
  const progress = { items: [
    { key: 'build', label: '实现', kind: 'step', status: 'pending', work_ms: 2000, active_since: at(90), started_at: at(0) },
    { key: 'test', label: '测试', kind: 'step', status: 'completed', work_ms: 3000, duration_ms: 90000 },
    { key: 'legacy', label: '旧墙钟', status: 'completed', duration_ms: 100000, started_at: at(0), completed_at: at(100) },
    { key: '__wait__', label: '等信号', kind: 'wait', status: 'pending', wait_ms: 7000, waiting_since: at(95) },
  ] };
  const historical = { id: 9, archived_at: at(50), progress: { items: [{ ...progress.items[0], work_ms: 4000 }] } };
  const value = analyze({ task: { ...task, status: 'running', progress }, progressVersions: [historical, historical] });
  expect(value.stages.map(row => row.duration_ms)).toEqual([12000, 4000, 3000, null]);
  expect(value.stages.find(row => row.frozen)).toMatchObject({ duration_ms: 4000, open: false, end: at(50), source: { kind: 'progress', plan_id: 9, step_key: 'build' } });
  expect(value.progress_waits[0]).toMatchObject({ kind: 'wait', duration_ms: 12000 });
  expect(value.summary.call_ms).toBe(0); expect(value.summary.wait_ms).toBe(0);
});

test('unconfirmed/timing-unknown stages never use stale active clocks; unprojected completed wall clocks stay unknown', () => {
  const value = analyze({ task: { ...task, progress: { frozen: true, frozen_at: at(80), items: [
    { key: 'missed', label: '漏报', kind: 'step', work_ms: 9, duration_ms: 10, timing_unknown: true, active_since: at(0) },
    { key: 'unconfirmed', label: '未确认', kind: 'step', work_ms: 5, unconfirmed: true },
    { key: 'done', label: '完成', kind: 'step', duration_ms: 6000, status: 'completed' },
  ] } } });
  expect(value.stages.map(row => row.duration_ms)).toEqual([6000, null, null]);
  expect(value.stages.every(row => row.open === false)).toBe(true);
});

test('empty complete statistics are zero, unknown/incomplete statistics are explicitly partial', () => {
  expect(analyze().summary).toEqual({ call_ms: 0, wait_ms: 0, unknown_intervals: 0 });
  const value = analyzePerformance({ task });
  expect(value.coverage).toEqual({ history: false, runs: false, steps: false, progress: false });
  expect(value.summary.call_ms).toBeNull(); expect(value.summary.wait_ms).toBeNull(); expect(value.notes.join('')).toContain('仅分析已读取范围');
});

test('known historical calls without durable timing evidence are missing, not zero-duration work', () => {
  const value = analyze({ task: { ...task, calls: 3 } });
  expect(value.summary.call_ms).toBeNull(); expect(value.summary.unknown_intervals).toBe(3);
  expect(value.notes.join('')).toContain('缺失调用不当作零耗时');
  const partial = analyze({ task: { ...task, calls: 3 }, runs: [run(1, 0, 5)] });
  expect(partial.summary.call_ms).toBe(5000); expect(partial.summary.unknown_intervals).toBe(2);
});

test('fixed-parent collector snapshots feed the model across bounded and complete evidence windows', async () => {
  const call = tool(1, 5);
  const data = createPerformanceData(7, { read: async route => {
    const url = new URL(route, 'http://fixture');
    if (url.pathname.endsWith('/7')) return { ...task, progress: { items: [{ key: 'current', label: '当前阶段', kind: 'step', work_ms: 1000 }] } };
    if (url.pathname.endsWith('/reading-page')) return { events: [phase(1, 0), start(2, 5, 1),
      { id: 3, type: 'invocation.completed', task_id: 7, created_at: at(10), data: { run_id: 1 } }, phase(4, 10, 'completed')],
      has_more_events: false, event_cursor: 0 };
    if (url.pathname.endsWith('/runs-page')) return url.searchParams.has('before')
      ? { items: [run(1, 5, 10)], has_more: false, cursor: 1 }
      : { items: [run(2, 20, 25)], has_more: true, cursor: 2 };
    if (url.pathname.endsWith('/transcript-search')) return { steps: [call, result(2, 7, call)], has_more: false, next: 2 };
    return { items: [{ id: 10, archived_at: at(15), progress: { items: [{ key: 'prior', label: '历史阶段', kind: 'step', work_ms: 3000 }] } }], has_more: false, cursor: 10 };
  } });
  const bounded = analyzePerformance(await data.load());
  expect(bounded.coverage.runs).toBe(false); expect(bounded.notes.join('')).toContain('仅分析已读取范围');
  const full = analyzePerformance(await data.load({ all: true }));
  expect(full.coverage).toEqual(coverage); expect(full.summary).toEqual({ call_ms: 10000, wait_ms: 5000, unknown_intervals: 0 });
  expect(full.calls.every(row => row.source?.kind === 'run')).toBe(true);
  expect(full.tools[0]).toMatchObject({ duration_ms: 2000, source: { kind: 'transcript_step', seq: 1 } });
  expect(full.stages.map(row => row.duration_ms)).toEqual([3000, 1000]);
  expect(full.stages.find(row => !row.frozen).source.plan_id).toBe('current');
});

test('model and its shared rule dependencies compile for browsers without server runtime imports', async () => {
  const built = await Bun.build({ entrypoints: [new URL('../../src/ui/web/assets/performance-model.js', import.meta.url).pathname], target: 'browser', write: false });
  expect(built.success).toBe(true); expect(built.outputs).toHaveLength(1);
  const code = await built.outputs[0].text();
  expect(code).not.toContain('bun:'); expect(code).not.toContain('node:');
});

test('malicious labels are text only, no DOM/model execution, and all inputs remain untouched', () => {
  const label = '<img src=x onerror=alert(1)>';
  const call = tool(1, 0, { tool_name: label });
  const input = freeze({ task: { ...task, progress: { items: [{ key: 'safe', label, kind: 'step', duration_ms: 1000 }] } },
    events: [start(1, 0, 1)], runs: [run(1, 0, 3)], steps: [call, result(2, 1, call)], ranges: [[1, 1]], coverage, now: at(100) });
  const before = JSON.stringify(input), value = analyzePerformance(input);
  expect(JSON.stringify(input)).toBe(before); expect(value.stages[0].label).toBe(label); expect(value.tools[0].label).toBe(label);
  value.stages[0].label = 'changed'; expect(input.task.progress.items[0].label).toBe(label);
});
