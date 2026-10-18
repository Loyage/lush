import { check, isPlainObject } from '../types.js';
import { managementState } from './management-data.js';

const START = 'management.call_started', FINISH = 'management.call_finished';
const positive = value => Number.isSafeInteger(value) && value > 0;
const statuses = new Set(['succeeded','waiting','skipped','unknown','pending_confirmation','approved','rejected','failed','running','cancelled']);
const numericKeys = ['id','parent','before','after','limit','offset','seq','days','expected_revision'];
const booleanKeys = ['enabled','start','defer','history','keep_branch','force'];
const enumKeys = { scope: ['all','tree','work','device','project'], access: ['read','automatic','confirmation','unavailable'],
  action: ['start','retry'], level: ['off','merge','accept','archive'] };

// This is deliberately NOT a generic secret-key filter. Arbitrary strings,
// nested objects, model request IDs, instructions, configuration and output never
// enter public Events, even when supplied under an otherwise innocuous key.
function safeParams(params) {
  if (!isPlainObject(params)) return {};
  const result = {};
  for (const key of numericKeys) if (Number.isSafeInteger(params[key]) && params[key] >= 0) result[key] = params[key];
  for (const key of booleanKeys) if (typeof params[key] === 'boolean') result[key] = params[key];
  for (const [key, values] of Object.entries(enumKeys)) if (values.includes(params[key])) result[key] = params[key];
  return result;
}
function target(project, method, params) {
  const value = method === 'worker.spawn' ? params?.parent
    : method?.startsWith('worker.') || ['manager.query','manager.history'].includes(method) ? params?.id : null;
  const row = positive(value) ? project.store.get('SELECT id,worker_number FROM tasks WHERE id=?', value) : null;
  return { target_id: row?.id ?? null, target_worker_number: row?.worker_number ?? null };
}
function safeResult(value, includeAction = true) {
  if (!isPlainObject(value)) return {};
  const result = {};
  for (const key of ['id','receipt_id','target_id','notice_id']) if (positive(value[key])) result[key] = value[key];
  if (statuses.has(value.status)) result.status = value.status;
  if (['start','retry'].includes(value.action)) result.action = value.action;
  if (includeAction && isPlainObject(value.action)) result.action = safeResult(value.action, false);
  // Capability results may link a separately executing lifecycle action.
  if (includeAction && isPlainObject(value.result?.action)) result.action = safeResult(value.result.action, false);
  return result;
}

export function beginManagementCall(project, actorTask, transport, method, params) {
  const state = managementState(actorTask), run = project.running.get(actorTask.id);
  const info = { method, transport_method: transport, run_id: run?.recordId ?? null,
    occurrence_id: state?.pending_signal?.id ?? null, started_at: new Date().toISOString(),
    ...target(project, method, params), params: safeParams(params) };
  const callId = project.store.event(actorTask.id, START, info);
  return { ...info, call_id: callId };
}

export function finishManagementCall(project, actorId, info, result, error, parameterRejection = false) {
  const finished = new Date().toISOString(), summary = safeResult(result);
  const status = error ? (parameterRejection ? 'rejected' : 'failed') : 'succeeded';
  project.store.event(actorId, FINISH, { ...info, phase: 'finished', status,
    finished_at: finished, duration_ms: Math.max(0, Date.parse(finished) - Date.parse(info.started_at)),
    result: summary, ...(summary.receipt_id ? { receipt_id: summary.receipt_id } : {}),
    ...(summary.action ? { action: summary.action } : {}),
    ...(info.method === 'worker.lookup' && positive(summary.id) ? target(project, 'worker.inspect', { id: summary.id }) : {}),
    // Never persist exception messages, error data, rejected values or raw results.
    reason: error ? (parameterRejection ? 'invalid_parameters' : 'request_failed_or_denied') : null });
}

/** User-only Event stream; every finish carries its original start snapshot. */
export function managementCalls(project, params) {
  check(positive(params.id), 'id must be a positive integer');
  const task = project.store.task(params.id);
  check(task.role === 'manager' && task.task_kind === 'management', 'management calls require a management Worker');
  const { before, after, limit = 50 } = params;
  check(before === undefined || positive(before), 'invalid management calls before cursor');
  check(after === undefined || (Number.isSafeInteger(after) && after >= 0), 'invalid management calls after cursor');
  check(before === undefined || after === undefined, 'before and after are mutually exclusive');
  check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'management calls limit must be 1..100');
  return project.store.transaction(() => {
    const forward = after !== undefined;
    const rows = project.store.all(`SELECT id,type,data FROM events WHERE task_id=? AND type IN (?,?)
      ${forward ? 'AND id>?' : before !== undefined ? 'AND id<?' : ''} ORDER BY id ${forward ? 'ASC' : 'DESC'} LIMIT ?`,
    task.id, START, FINISH, ...(forward ? [after] : before !== undefined ? [before] : []), limit + 1);
    const selected = rows.slice(0, limit);
    if (!forward) selected.reverse();
    const items = selected.map(row => {
      const data = JSON.parse(row.data);
      if (row.type === FINISH) return { ...data, seq: row.id };
      const completed = project.store.get(`SELECT id FROM events WHERE task_id=? AND type=? AND id>? AND json_extract(data,'$.call_id')=? LIMIT 1`, task.id, FINISH, row.id, row.id);
      const run = project.running.get(task.id);
      const active = task.status === 'running' && run && run.recordId === data.run_id
        && !run.invocationEnded && !run.parked && !run.controller?.signal.aborted;
      return { ...data, seq: row.id, call_id: row.id, phase: 'started',
        status: completed || active ? 'running' : 'unknown',
        reason: !completed && !active ? 'completion_not_observed' : null };
    });
    return { items, next_cursor: (forward ? items.at(-1)?.seq : items[0]?.seq) ?? null,
      latest_cursor: items.at(-1)?.seq ?? null, has_more: rows.length > limit,
      coverage: 'trusted_management_rpc_events_only', history_complete: false };
  });
}
