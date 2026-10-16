import { timelineEventCategory, timelineEventEntry } from './timeline-event.js';

// Read-only lifecycle projection. A received input batch is not a unique wake-up cause.
// No elapsed time or historical wait reason is reconstructed from task.updated_at.
const terminal = new Set(['completed', 'failed', 'cancelled']);
const isSettled = child => terminal.has(child.status) || child.status === 'awaiting_acceptance'
  && (child.task_kind === 'integration' || ['merged', 'none'].includes(child.integration));
const positive = value => Number.isSafeInteger(value) && value > 0;
const clock = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const elapsed = (start, end) => clock(start) !== null && clock(end) !== null && clock(end) >= clock(start) ? clock(end) - clock(start) : null;
export const PHASE_LABELS = { queued: '排队等待准入', running: '正在调用 Agent', awaiting: '等待决定',
  waiting: '静息等待', waiting_notice: '等待决定', waiting_children: '等待子 Worker', idle: '静息 · 等待原因未知',
  awaiting_acceptance: '等待验收', paused: '已暂停', completed: '已结束', failed: '失败', cancelled: '已取消' };

function phaseLabel(phase) {
  if (phase.to === 'waiting' && phase.child_ids?.length) return '等待子 Worker';
  if (phase.to === 'awaiting' && phase.notice_ids?.length) return '等待决定';
  return PHASE_LABELS[phase.to] || '阶段未知';
}
function sameWorker(row, task) { return row.task_id == null || row.task_id === task.id; }
function knownNumber(task, id, supplied) {
  return typeof supplied === 'string' && supplied ? supplied
    : (task.children || []).find(child => child.id === id)?.worker_number || (id === task.id ? task.worker_number : null) || null;
}
function workerName(task, id, supplied) { return knownNumber(task, id, supplied) || (positive(id) ? `#${id}` : '编号未知'); }
function noticeName(id, kind) { return `${['question', 'questionnaire', 'plan'].includes(kind) ? 'D' : 'N'}${id}`; }
function sourceLabel(source, task) {
  if (positive(source.notice_id)) {
    const who = source.source === 'user' ? '你' : source.source === 'system' ? '系统' : '来源未知';
    return `${who}答复 ${noticeName(source.notice_id, source.notice_kind)}`;
  }
  if (source.source === 'system') return `系统信号${source.signal_type ? ` ${source.signal_type}` : ''}${positive(source.sender_id) ? ` · ${workerName(task, source.sender_id, source.sender_worker_number)}` : ''}`;
  if (source.source === 'worker') return `Worker ${workerName(task, source.sender_id, source.sender_worker_number)}`;
  if (source.source === 'user') return '你的追加输入';
  return '输入来源未知';
}
function inputSources(task, start, messages, events) {
  const data = start?.data || {}, ids = Array.isArray(data.message_ids) ? [...new Set(data.message_ids.filter(positive))] : [];
  const persisted = data.source_scope === 'delivered_batch' && Array.isArray(data.input_sources) ? data.input_sources : [];
  return ids.map(messageId => {
    const saved = persisted.find(source => source.message_id === messageId);
    const message = messages.find(row => row.id === messageId && sameWorker(row, task));
    const linked = events.filter(event => event.data?.message_id === messageId && ['message', 'task.signal', 'notice.answered'].includes(event.type));
    const answer = linked.find(event => event.type === 'notice.answered');
    const evidence = linked.find(event => event.type === 'message');
    const signal = linked.find(event => event.type === 'task.signal');
    let source = { message_id: messageId, source: 'unknown' };
    // A runtime-authored start receipt can prove provenance even when the inbox page is not loaded.
    if (saved && ['user', 'worker', 'system', 'unknown'].includes(saved.source)) source = { ...saved, message_id: messageId };
    else if (answer) source = { ...source, source: answer.data.answer_source === 'user' ? 'user' : answer.data.answer_source === 'lush' ? 'system' : 'unknown',
      notice_id: answer.data.notice_id, notice_kind: answer.data.notice_kind };
    else if (signal || message?.signal_type) source = { ...source, source: 'system', sender_id: signal?.data.source_task_id ?? message?.sender_id,
      sender_worker_number: message?.sender_worker_number, signal_type: signal?.data.signal ?? message?.signal_type };
    else if (positive(message?.sender_id) && (!evidence || evidence.data.sender === message.sender_id)) source = { ...source, source: 'worker',
      sender_id: message.sender_id, sender_worker_number: message.sender_worker_number };
    else if (positive(evidence?.data.sender) && !message) source = { ...source, source: 'worker', sender_id: evidence.data.sender };
    else if (evidence && evidence.data.sender === null && evidence.data.user_append === true && (!message || message.sender_id === null)) source = { ...source, source: 'user' };
    else if (message?.sender_id === null && /^A[1-9]\d*-[1-9]\d*$/.test(message.append_number || '')) source = { ...source, source: 'user' };
    return { ...source, label: sourceLabel(source, task), event_id: saved?.evidence_event_id ?? answer?.id ?? evidence?.id ?? signal?.id ?? null };
  });
}

/** ranges are contiguous Event windows, not merely the min/max of arbitrary reference hits. */
export function lifecycleModel(task, rawEvents = [], rawMessages = [], { now = new Date().toISOString(), ranges = [] } = {}) {
  const events = [...new Map(rawEvents.filter(event => sameWorker(event, task) && positive(event.id)).map(event => [event.id, event])).values()].sort((a, b) => a.id - b.id);
  const messages = rawMessages.filter(message => sameWorker(message, task));
  const covered = (a, b) => a === b || ranges.some(([low, high]) => low <= Math.min(a, b) && high >= Math.max(a, b));
  const records = (task.runs || []).filter(run => sameWorker(run, task) && positive(run.id));
  const starts = events.filter(event => event.type === 'invocation.started');
  const completions = events.filter(event => ['invocation.completed', 'invocation.preempted'].includes(event.type));
  const runs = new Map(records.map(run => [run.id, { ...run }])), calls = [];
  for (const completion of completions) if (positive(completion.data?.run_id) && !runs.has(completion.data.run_id)) {
    runs.set(completion.data.run_id, { id: completion.data.run_id, ended_at: completion.created_at,
      status: completion.data.suspended ? 'suspended' : completion.type === 'invocation.preempted' ? 'preempted' : 'completed' });
  }
  for (const start of starts) {
    const matches = records.filter(run => run.attempt === start.data?.call);
    const runId = positive(start.data?.run_id) ? start.data.run_id : matches.length === 1 ? matches[0].id : null;
    const run = runId ? runs.get(runId) || { id: runId } : {};
    const finished = runId ? completions.filter(event => event.data?.run_id === runId) : [];
    // Old suspension rows lacked run_id. Only an uninterrupted, complete serial
    // invocation window proves their association; nearby timestamps never do.
    const legacy = finished.length ? [] : completions.filter(event => !positive(event.data?.run_id) && event.data?.suspended === true
      && positive(event.data?.notice_id) && event.id > start.id && covered(start.id, event.id)
      && !events.some(other => other.id > start.id && other.id < event.id
        && (other.type === 'invocation.started' || terminal.has(other.type) || completions.includes(other))));
    const completion = finished.length === 1 ? finished[0] : legacy.length === 1 ? legacy[0] : null;
    const input = inputSources(task, start, messages, events);
    const delivered = runId && events.find(event => event.type === 'invocation.inputs_delivered' && event.data?.run_id === runId);
    const end = run.ended_at || completion?.created_at || null;
    const suspended = completion?.data?.suspended === true;
    calls.push({ key: `call:${runId ?? `event-${start.id}`}`, kind: 'call', run_id: runId, call: start.data?.call ?? run.attempt ?? null,
      start: run.started_at || start.created_at, end, duration_ms: elapsed(run.started_at || start.created_at, end || (run.status === 'running' && task.status === 'running' ? now : null)),
      open: run.status === 'running' && task.status === 'running' && !end,
      status: suspended ? 'suspended' : completion?.type === 'invocation.preempted' ? 'preempted' : run.status || (completion ? 'completed' : 'unknown'),
      suspension_evidence: completion && legacy.includes(completion) ? 'serial_window' : null,
      inputs: input, initial_input: ['order', 'say'].includes(task.task_kind) && start.data?.call === 1 && input.length === 0 && positive(task.input_id),
      inputs_delivered: Boolean(delivered && Array.isArray(delivered.data.message_ids)
        && (start.data?.message_ids || []).every(id => delivered.data.message_ids.includes(id))), evidence_limited: Boolean(start.limitations?.length || start.data?.input_sources_truncated),
      start_event_id: start.id, result_event_id: completion?.id ?? null,
      notice_id: suspended ? completion.data.notice_id : null, event_ids: [start.id, ...new Set([...finished, ...(completion ? [completion] : [])].map(event => event.id))], at: run.started_at || start.created_at });
    if (runId) runs.delete(runId);
  }
  for (const run of runs.values()) calls.push({ key: `call:${run.id}`, kind: 'call', run_id: run.id, call: run.attempt ?? null,
    start: run.started_at || null, end: run.ended_at || null, duration_ms: elapsed(run.started_at, run.ended_at || (run.status === 'running' && task.status === 'running' ? now : null)),
    open: run.status === 'running' && task.status === 'running' && !run.ended_at, status: run.status || 'unknown', inputs: [], initial_input: false,
    inputs_delivered: false, result_event_id: completions.find(event => event.data?.run_id === run.id)?.id ?? null,
    event_ids: completions.filter(event => event.data?.run_id === run.id).map(event => event.id), at: run.started_at || run.ended_at || null });

  const boundaries = events.filter(event => event.type === 'worker.phase_changed' || event.type === 'invocation.started' || terminal.has(event.type));
  const phaseEvents = events.filter(event => event.type === 'worker.phase_changed' && event.data?.version === 1 && typeof event.data.to === 'string');
  const newestWindow = [...ranges].sort((a, b) => b[1] - a[1])[0];
  const currentRun = records.filter(run => !Number.isInteger(task.calls) || run.attempt === task.calls).sort((a, b) => b.attempt - a.attempt)[0];
  const isCurrentPhase = event => event === phaseEvents.at(-1) && event.data.to_status === task.status
    && (!newestWindow || newestWindow[0] <= event.id && newestWindow[1] >= event.id)
    && (!currentRun || event.data.run_id === currentRun.id)
    && !events.some(later => later.id > event.id && (later.type === 'invocation.started' || terminal.has(later.type)));
  const phases = phaseEvents.filter(event => event.data.to !== 'running').map(event => {
    const next = boundaries.find(boundary => boundary.id > event.id);
    const continuous = next && covered(event.id, next.id);
    const open = !next && isCurrentPhase(event) && !terminal.has(task.status);
    const end = continuous ? next.created_at : open ? now : null;
    return { key: `phase:${event.id}`, kind: 'phase', state: event.data.to, label: phaseLabel(event.data), reason: event.data.reason || 'unknown',
      child_ids: Array.isArray(event.data.child_ids) ? event.data.child_ids.filter(positive) : [],
      notice_ids: Array.isArray(event.data.notice_ids) ? event.data.notice_ids.filter(positive) : [],
      children: Array.isArray(event.data.children) ? event.data.children : [], notices: Array.isArray(event.data.notices) ? event.data.notices : [],
      evidence_limited: Boolean(event.limitations?.length),
      start: event.created_at, end, duration_ms: terminal.has(event.data.to_status) ? null : elapsed(event.created_at, end), open, boundary_unknown: Boolean(next && !continuous),
      event_ids: [event.id], at: event.created_at };
  });
  // Legacy Run timestamps prove only an interval between calls, not its historical cause.
  const ordered = [...calls].filter(row => clock(row.start) !== null).sort((a, b) => clock(a.start) - clock(b.start));
  const gaps = [];
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1], next = ordered[index];
    if (elapsed(previous.end, next.start) <= 0 || elapsed(previous.end, next.start) === null) continue;
    if (phaseEvents.some(event => clock(event.created_at) >= clock(previous.end) && clock(event.created_at) <= clock(next.start))) continue;
    gaps.push({ key: `gap:${previous.key}:${next.key}`, kind: 'gap', label: '调用间隔 · 等待原因未知', start: previous.end, end: next.start,
      duration_ms: elapsed(previous.end, next.start), at: previous.end, event_ids: [] });
  }
  // Point facts remain visible (failure, blocked admission, delivery, decisions), without
  // pretending that a timestamp alone proves a duration or a historical waiting state.
  const pointEvents = events.filter(event => !['worker.phase_changed', 'invocation.started', 'invocation.completed', 'invocation.preempted'].includes(event.type)
    && ['lifecycle', 'failure', 'delivery', 'decision'].includes(timelineEventCategory(event))).map(event => {
    const entry = timelineEventEntry(event);
    return { key: `point:${event.id}`, kind: 'event', label: entry.kind, detail: entry.summary, category: entry.category,
      start: event.created_at, at: event.created_at, event_ids: [event.id] };
  });
  const latestPhase = phaseEvents.at(-1);
  const currentPhase = latestPhase && isCurrentPhase(latestPhase) ? latestPhase : null;
  const currentChildren = task.status === 'waiting' ? (task.children || []).filter(child => !isSettled(child)) : [];
  const currentNotices = task.status === 'awaiting' ? (task.notices || []).filter(notice => notice.status === 'open') : [];
  const snapshot = { state: task.status || 'unknown', label: currentPhase ? phaseLabel(currentPhase.data)
    : task.status === 'waiting' && currentChildren.length ? '等待子 Worker（当前快照）' : PHASE_LABELS[task.status] || '状态未知',
    start: currentPhase?.created_at ?? null, duration_ms: currentPhase && !terminal.has(task.status) ? elapsed(currentPhase.created_at, now) : null,
    child_ids: currentPhase?.data.child_ids ?? currentChildren.map(child => child.id),
    notice_ids: currentPhase?.data.notice_ids ?? currentNotices.map(notice => notice.id),
    children: currentPhase?.data.children ?? currentChildren, notices: currentPhase?.data.notices ?? currentNotices,
    evidence_limited: Boolean(currentPhase?.limitations?.length), historical_reason_known: Boolean(currentPhase), sampled_at: now };
  return { calls, phases, rows: [...calls, ...phases, ...gaps, ...pointEvents].sort((a, b) => (clock(a.at) ?? -Infinity) - (clock(b.at) ?? -Infinity) || a.key.localeCompare(b.key)),
    current: snapshot, workerName: (id, supplied) => workerName(task, id, supplied) };
}
