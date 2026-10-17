import { lifecycleModel } from './worker-lifecycle-model.js';
import { groupSteps, toolDurationMs } from './transcript-model.js';

const clock = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const milliseconds = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonExecuting = new Set(['queued', 'waiting', 'awaiting', 'waiting_notice', 'waiting_children', 'idle', 'paused', 'awaiting_acceptance']);
const terminal = new Set(['completed', 'failed', 'cancelled']);
const text = (value, fallback) => typeof value === 'string' && value ? value : fallback;
const order = rows => rows.sort((a, b) => (b.duration_ms ?? -1) - (a.duration_ms ?? -1) || a.key.localeCompare(b.key));
const eventSource = id => positive(id) ? { kind: 'history_event', event_id: id } : null;

function union(spans) {
  const merged = [];
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
function interval(row, now) {
  if (row.duration_ms === null) return null;
  const start = clock(row.start), end = clock(row.end ?? (row.open ? now : null));
  return start !== null && end !== null && end >= start ? [start, end] : null;
}
function subtract(spans, excluded) {
  const result = [];
  for (const [start, end] of spans) {
    let cursor = start;
    for (const [low, high] of excluded) {
      if (high <= cursor || low >= end) continue;
      if (low > cursor) result.push([cursor, Math.min(low, end)]);
      cursor = Math.max(cursor, high);
    }
    if (cursor <= end) result.push([cursor, end]);
  }
  return result;
}
const total = spans => spans.reduce((sum, [start, end]) => sum + end - start, 0);
function unique(rows, key) { return [...new Map(rows.map(row => [key(row), row])).values()]; }
function eventRanges(ranges) {
  const merged = [];
  const valid = ranges.filter(range => Array.isArray(range) && range.length === 2
    && range.every(value => Number.isSafeInteger(value) && value >= 0) && range[0] <= range[1]);
  for (const [low, high] of [...valid].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && low <= last[1] + 1) last[1] = Math.max(last[1], high);
    else merged.push([low, high]);
  }
  return merged;
}

function progressRows(task, versions, now) {
  const stages = [], waits = [];
  // Archive event IDs identify frozen versions; a current plan is a separate identity.
  const plans = unique(versions.filter(version => version?.progress && version.id != null), version => version.id)
    .map(version => ({ ...version, frozen: true }));
  if (task.progress && !plans.some(plan => plan.progress === task.progress)) {
    plans.push({ id: 'current', progress: task.progress, frozen: task.progress.frozen === true });
  }
  for (const plan of plans) {
    const frozen = plan.frozen;
    for (const item of unique((plan.progress.items || []).filter(item => item && typeof item.key === 'string'), item => item.key)) {
      const wait = item.kind === 'wait', unknown = item.timing_unknown === true || item.unconfirmed === true;
      // A legacy progress.completed wall-clock duration is not net Agent work.
      let duration = unknown ? null : milliseconds(wait ? item.wait_ms ?? item.duration_ms
        : item.work_ms ?? (item.kind === 'step' ? item.duration_ms : null));
      const since = clock(wait ? item.waiting_since : item.active_since), sampled = clock(now);
      const open = !frozen && item.status !== 'completed' && !unknown && since !== null
        && sampled !== null && sampled >= since && (wait ? !terminal.has(task.status) : task.status === 'running');
      if (open && duration !== null) duration += sampled - since;
      const row = { key: `progress:${plan.id}:${item.key}`, label: text(item.label, item.key), duration_ms: duration,
        start: item.started_at ?? null, end: item.completed_at ?? (frozen ? plan.progress.frozen_at ?? plan.archived_at ?? null : null),
        open, estimated: false, source: { kind: 'progress', plan_id: plan.id, step_key: item.key },
        kind: wait ? 'wait' : 'stage', frozen, timing_unknown: unknown || duration === null, unconfirmed: item.unconfirmed === true };
      (wait ? waits : stages).push(row);
    }
  }
  return { stages: order(stages), progress_waits: order(waits) };
}

/** Pure sampled statistics. Groups overlap conceptually and must never be added together. */
export function analyzePerformance({ task, events = [], runs = task.runs || [], steps = [], ranges = [], progressVersions = [],
  now = new Date().toISOString(), coverage = {} }) {
  const scope = Object.fromEntries(['history', 'runs', 'steps', 'progress'].map(key => [key, coverage[key] === true]));
  const records = unique(runs.filter(run => run && (run.task_id == null || run.task_id === task.id) && positive(run.id)), run => run.id);
  const model = lifecycleModel({ ...task, runs: records }, events, [], { now, ranges: eventRanges(ranges) });
  // Multiple page receipts of a start must not produce a second invocation.
  const callsByKey = new Map();
  for (const call of model.calls) {
    const prior = callsByKey.get(call.key);
    if (!prior || prior.duration_ms === null && call.duration_ms !== null) callsByKey.set(call.key, call);
  }
  const calls = order([...callsByKey.values()].map(call => ({ key: call.key,
    label: `调用 ${positive(call.call) ? `#${call.call}` : positive(call.run_id) ? `Run #${call.run_id}` : '轮次未知'}`,
    duration_ms: milliseconds(call.duration_ms), start: call.start, end: call.end, open: Boolean(call.open), estimated: false,
    source: records.some(run => run.id === call.run_id) ? { kind: 'run', run_id: call.run_id } : eventSource(call.start_event_id ?? call.result_event_id),
    run_id: call.run_id, status: call.status })));
  const waits = order(model.rows.filter(row => row.kind === 'gap' || row.kind === 'phase' && !terminal.has(row.state)).map(row => {
    const confirmed = row.kind === 'phase' && nonExecuting.has(row.state);
    return { key: row.key, label: row.label, duration_ms: milliseconds(row.duration_ms), start: row.start, end: row.end,
      open: Boolean(row.open), estimated: false, source: eventSource(row.event_ids?.[0]),
      kind: confirmed ? 'wait' : 'unknown', state: row.state ?? 'unknown', reason_known: confirmed && !['idle', 'waiting', 'awaiting'].includes(row.state),
      confirmed, boundary_unknown: Boolean(row.boundary_unknown) };
  }));
  // Step seq is globally stable; identical page overlap is not a duplicate tool identity.
  const wireSteps = unique(steps.filter(step => step && positive(step.seq)), step => step.seq);
  const tools = order(groupSteps(wireSteps).filter(step => step.kind === 'tool').map(step => {
    const duration = typeof step.file === 'string' && step.file ? toolDurationMs(step) : null;
    const paired = duration !== null ? step.results[0] : null;
    return { key: `tool:${step.seq}`, label: text(step.tool_name, text(step.title, '工具名称未知')), duration_ms: duration,
      start: step.at ?? null, end: paired?.at ?? null, open: false, estimated: true,
      source: { kind: 'transcript_step', seq: step.seq }, file: step.file ?? null, call_id: step.call_id ?? null,
      result_seq: paired?.seq ?? null, is_error: Boolean(step.is_error || paired?.is_error) };
  }));
  const progress = progressRows(task, progressVersions, now);
  const callSpans = union(calls.map(row => interval(row, now)).filter(Boolean));
  const waitSpans = union(waits.filter(row => row.confirmed).map(row => interval(row, now)).filter(Boolean));
  const missingCalls = Number.isSafeInteger(task.calls) && task.calls > calls.length ? task.calls - calls.length : 0;
  const unknownIntervals = [...calls, ...waits, ...tools, ...progress.stages, ...progress.progress_waits]
    .filter(row => row.duration_ms === null || row.kind === 'unknown').length + missingCalls;
  const notes = [];
  const partial = Object.entries(scope).filter(([, complete]) => !complete).map(([key]) => key);
  if (partial.length) notes.push(`仅分析已读取范围；尚未完整覆盖：${partial.join('、')}。排行和合计不代表完整历史。`);
  notes.push('调用总用时按有效起止区间并集统计；已证实的非执行等待按并集统计，并剔除与调用重叠的区间。未知原因的调用间隔不计入已证实等待合计。');
  notes.push('工具耗时是同文件唯一调用与结果之间的估算间隔，可能包含排队、并行等待及记录开销，不代表纯工具执行时间。');
  notes.push('里程碑、调用、等待与工具可能重叠，不能相加；不以调用减工具推算模型思考，不递归统计子 Worker。');
  if (missingCalls) notes.push(`Worker 记录了 ${task.calls} 次调用，但当前只读到 ${calls.length} 次的计时证据；缺失调用不当作零耗时。`);
  if (unknownIntervals) notes.push('存在缺失、无效或不连续的计时证据；未知耗时保留为空，不当作零秒。');
  return { sampled_at: now, coverage: scope,
    summary: { call_ms: callSpans.length ? total(callSpans) : scope.runs && !calls.length && !missingCalls ? 0 : null,
      wait_ms: waitSpans.length ? total(subtract(waitSpans, callSpans)) : scope.history && !waits.length ? 0 : null,
      unknown_intervals: unknownIntervals },
    stages: progress.stages, calls, waits, tools, progress_waits: progress.progress_waits, notes };
}

/** Actual Bash attempts only. Server fingerprints describe full parameters, never display previews. */
export function analyzeShellCommands({ steps = [], coverage = {} } = {}) {
  const wireSteps = unique(steps.filter(step => step && positive(step.seq)), step => step.seq);
  const commands = groupSteps(wireSteps).filter(step => step.kind === 'tool' && (step.tool_name || step.title) === 'bash')
    .sort((a, b) => a.seq - b.seq);
  const groupsByKey = new Map();
  for (const step of commands) {
    const shell = step.shell || {};
    const identity = shell.identity_complete === true && typeof shell.fingerprint === 'string'
      && /^[a-f0-9]{64}$/.test(shell.fingerprint) && typeof shell.command === 'string' && shell.command.length > 0;
    const key = identity ? `shell:${shell.fingerprint}` : `shell:step-${step.seq}`;
    if (!groupsByKey.has(key)) groupsByKey.set(key, { key, command: text(shell.command, '命令不可读取'),
      command_truncated: shell.command_truncated === true, parameters: structuredClone(shell.parameters ?? null),
      parameters_truncated: shell.parameters_truncated === true, identity_complete: identity,
      fingerprint: identity ? shell.fingerprint : null, attempts: [] });
    // Pairing identity and sequence are independent of clock readability. A failed
    // command with missing timestamps is still failed, not an unknown result.
    const paired = typeof step.file === 'string' && step.file && step.results.length === 1
      && step.results[0].seq > step.seq ? step.results[0] : null;
    // The compatibility projection may coerce malformed old flags; require original boolean evidence here.
    const outcome = paired?.error_known === true && paired.is_error === true ? 'failed'
      : paired?.is_error === false && paired.error_known === true ? 'succeeded' : 'unknown';
    groupsByKey.get(key).attempts.push({ key: `shell-attempt:${step.seq}`, seq: step.seq, result_seq: paired?.seq ?? null,
      start: step.at ?? null, end: paired?.at ?? null, duration_ms: paired ? toolDurationMs(step) : null,
      outcome, source: { kind: 'transcript_step', seq: step.seq } });
  }
  const sumKnown = attempts => {
    const known = attempts.filter(attempt => attempt.duration_ms !== null);
    return known.length ? known.reduce((sum, attempt) => sum + attempt.duration_ms, 0) : null;
  };
  const groups = [...groupsByKey.values()].map(group => {
    const attempts = group.attempts, failures = attempts.filter(attempt => attempt.outcome === 'failed');
    const known = attempts.filter(attempt => attempt.duration_ms !== null);
    return { ...group, count: attempts.length, failure_count: failures.length,
      success_count: attempts.filter(attempt => attempt.outcome === 'succeeded').length,
      unknown_count: attempts.filter(attempt => attempt.outcome === 'unknown').length,
      total_ms: sumKnown(attempts), max_ms: known.length ? Math.max(...known.map(attempt => attempt.duration_ms)) : null,
      failed_ms: failures.length ? sumKnown(failures) : attempts.every(attempt => attempt.outcome === 'succeeded') ? 0 : null,
      unknown_durations: attempts.length - known.length,
      unknown_failed_durations: failures.filter(attempt => attempt.duration_ms === null).length,
      last_outcome: attempts.at(-1).outcome };
  }).sort((a, b) => (b.max_ms ?? -1) - (a.max_ms ?? -1) || a.key.localeCompare(b.key));
  const attempts = groups.flatMap(group => group.attempts), failures = attempts.filter(attempt => attempt.outcome === 'failed');
  const summary = { commands: groups.length, attempts: attempts.length, failures: failures.length,
    unknown_results: attempts.filter(attempt => attempt.outcome === 'unknown').length,
    ungrouped_attempts: groups.filter(group => !group.identity_complete).reduce((sum, group) => sum + group.count, 0),
    known_failed_ms: failures.length ? sumKnown(failures)
      : attempts.length && attempts.every(attempt => attempt.outcome === 'succeeded') ? 0 : null,
    unknown_durations: attempts.filter(attempt => attempt.duration_ms === null).length,
    unknown_failed_durations: failures.filter(attempt => attempt.duration_ms === null).length };
  const notes = [
    '仅统计实际 Bash/Shell 命令调用，不计计划阶段、read/edit 工具或模型思考。',
    '仅按完整命令与参数的可核验精确指纹归组；空白、路径或 timeout 改变即为不同身份。预览相同不代表命令相同，不推断改参数后属于同一问题。',
    '耗时是同文件唯一调用到结果的记录间隔估算；累计时间包含可能重叠的尝试，不是墙钟耗时，不包含尝试间隙。失败尝试累计仅是返工线索，不代表已确认的返工时间。',
    '重复失败排行只应纳入明确失败次数至少 2 次的命令；一次失败后成功不算屡次失败。',
  ];
  if (coverage.steps !== true) notes.push('仅分析已读取的部分 steps 范围，排行与累计不代表全部历史。');
  if (summary.ungrouped_attempts) notes.push('部分命令身份不可核验，逐次独立成组，不按正文、工具名或截断预览合并。');
  if (summary.unknown_results || summary.unknown_durations) notes.push('存在结果证据或耗时未知的尝试；仅原始结果明确记录了布尔错误标记才分类成功／失败，缺结果不代表成功、失败或仍在运行，未知耗时不补零。');
  if (!attempts.length) notes.push('当前范围没有实际 Bash 命令证据，不以空列表伪装完整零耗时。');
  return { groups, summary, notes };
}
