import { check, isPlainObject, LushError } from '../types.js';
import { PARAMS } from '../../rpc/registry.js';
import { safeManagementCLICommand } from '../../cli/catalog.js';
import { managementState } from './management-data.js';
import { managementDiagnostic, safeManagementDiagnostic, managementDiagnosticErrorMessage, MANAGEMENT_DIAGNOSTIC_CODE } from '../management-diagnostic.js';
import { diagnosticCorrelation, projectDiagnostic, publicCapabilityDiagnostic } from './management-diagnostic.js';
import { findManagementCapability, findManagementAction, managementInputEmitFacts } from './management-receipt.js';

const START = 'management.call_started', FINISH = 'management.call_finished';
const positive = value => Number.isSafeInteger(value) && value > 0;
const statuses = new Set(['succeeded','waiting','skipped','unknown','pending_confirmation','approved','rejected','failed','running','cancelled']);
const numericKeys = ['id','parent','before','after','limit','offset','seq','days','expected_revision','draft_id','receipt_id'];
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

export function beginManagementCall(project, actorTask, transport, method, params, cliCommand = null) {
  const state = managementState(actorTask), run = project.running.get(actorTask.id);
  const info = { method, transport_method: transport, cli_command: safeManagementCLICommand(cliCommand, method), actor_id: actorTask.id, worker_number: actorTask.worker_number ?? null,
    run_id: run?.recordId ?? null,
    occurrence_id: state?.pending_signal?.id ?? null, started_at: new Date().toISOString(),
    ...target(project, method, params), params: safeParams(params) };
  const callId = project.store.event(actorTask.id, START, info);
  return { ...info, call_id: callId, request_event_id: callId };
}

export function finishManagementCall(project, actorId, info, result, error, parameterRejection = false) {
  const finished = new Date().toISOString(), summary = safeResult(result);
  const lookupId = info.method === 'worker.lookup' ? result?.id ?? result?.result?.id : null;
  if (positive(lookupId)) summary.id = lookupId;
  const status = error ? (parameterRejection ? 'rejected' : 'failed') : 'succeeded';
  const task = project.store.task(actorId), receiptId = summary.receipt_id ?? info.receipt_id;
  const call = findManagementCapability(project, task, receiptId) ?? findManagementAction(project, task, receiptId);
  const sampled = (receiptId === info.action_receipt_id ? info.action_diagnostic : info.capability_diagnostic)
    ?? (call ? publicCapabilityDiagnostic(project, task, call) : null);
  const readOnly = info.effect === 'not_applicable' || info.effect === undefined
    && ['manager.query','manager.history','manager.catalog','worker.lookup'].includes(info.method);
  const correlation = { ...diagnosticCorrelation(project, actorId), ...info, actor_id: actorId,
    receipt_id: receiptId, request_event_id: info.call_id };
  const diagnostic = sampled ? safeManagementDiagnostic({ ...sampled, correlation: { ...sampled.correlation,
    ...correlation } }) : managementDiagnostic(error ? (parameterRejection ? 'invalid_parameters' : info.failure_code ?? 'request_failed')
      : readOnly ? 'read_completed' : 'request_returned', parameterRejection ? 'parameters' : info.stage ?? 'return',
    parameterRejection ? 'not_started' : error ? info.effect ?? 'unknown' : readOnly ? 'not_applicable' : 'unknown',
    parameterRejection ? 'trusted_pre_dispatch' : error ? info.evidence ?? 'completion_not_observed' : readOnly ? 'read_only' : 'completion_not_observed', correlation);
  // Persist only the start whitelist, never mutable execution context or exception payloads.
  const snapshot = Object.fromEntries(['method','transport_method','cli_command','actor_id','worker_number','run_id','occurrence_id','started_at',
    'target_id','target_worker_number','params','call_id','request_event_id'].map(key => [key, info[key]]));
  try { project.store.event(actorId, FINISH, { ...snapshot, phase: 'finished', status, diagnostic,
    finished_at: finished, duration_ms: Math.max(0, Date.parse(finished) - Date.parse(info.started_at)),
    result: summary, ...(positive(receiptId) ? { receipt_id: receiptId } : {}),
    ...(summary.action ? { action: summary.action } : {}),
    ...(info.method === 'worker.lookup' && positive(summary.id) ? target(project, 'worker.inspect', { id: summary.id }) : {}),
    // Never persist exception messages, error data, rejected values or raw results.
    reason: error ? (parameterRejection ? 'invalid_parameters' : 'request_failed_or_denied') : null });
  } catch {
    // Loss of the audit/return path must neither leak an exception nor repeat an effect.
    const interrupted = managementDiagnostic('persistence_failed', 'return', diagnostic.effect, diagnostic.evidence, diagnostic.correlation, diagnostic);
    throw new LushError(managementDiagnosticErrorMessage(projectDiagnostic(project, task, interrupted)), MANAGEMENT_DIAGNOSTIC_CODE);
  }
  return projectDiagnostic(project, task, diagnostic);
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
      const raw = JSON.parse(row.data);
      const method = typeof raw.method === 'string' && Object.hasOwn(PARAMS, raw.method) ? raw.method : null;
      const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ? value : null;
      const data = { method, transport_method: ['manager.call','manager.query','manager.start','manager.retry','manager.catalog','manager.history','worker.lookup'].includes(raw.transport_method) ? raw.transport_method : null,
        cli_command: safeManagementCLICommand(raw.cli_command, method),
        actor_id: task.id, worker_number: task.worker_number ?? null,
        ...Object.fromEntries(['run_id','occurrence_id','call_id','request_event_id','receipt_id'].map(key => [key, positive(raw[key]) ? raw[key] : null])),
        started_at: date(raw.started_at), ...target(project, 'worker.inspect', { id: raw.target_id }), params: safeParams(raw.params),
        ...(row.type === FINISH ? { phase: 'finished', status: statuses.has(raw.status) ? raw.status : 'unknown',
          finished_at: date(raw.finished_at), duration_ms: Number.isSafeInteger(raw.duration_ms) && raw.duration_ms >= 0 ? raw.duration_ms : null,
          result: safeResult(raw.result), ...(raw.action ? { action: safeResult(raw.action) } : {}),
          reason: ['invalid_parameters','request_failed_or_denied'].includes(raw.reason) ? raw.reason : null,
          ...(raw.diagnostic ? { diagnostic: safeManagementDiagnostic(raw.diagnostic) } : {}) } : {}) };
      if (row.type === FINISH) {
        const capability = findManagementCapability(project, task, data.receipt_id) ?? findManagementAction(project, task, data.receipt_id);
        const current = capability ? publicCapabilityDiagnostic(project, task, capability) : null;
        return { ...data, seq: row.id,
          diagnostic: current ? safeManagementDiagnostic({ ...current, correlation: { ...current.correlation,
            call_id: data.call_id, request_event_id: data.call_id, run_id: data.run_id, occurrence_id: data.occurrence_id } })
            : projectDiagnostic(project, task, data.diagnostic ?? managementDiagnostic('legacy_unknown', 'legacy', 'unknown', 'legacy_missing',
              { actor_id: task.id, call_id: data.call_id, receipt_id: data.receipt_id, run_id: data.run_id, occurrence_id: data.occurrence_id })),
          ...(capability?.method === 'input.emit' ? { input_emit: managementInputEmitFacts(project, capability) } : {}) };
      }
      const completed = project.store.get(`SELECT id FROM events WHERE task_id=? AND type=? AND id>? AND json_extract(data,'$.call_id')=? LIMIT 1`, task.id, FINISH, row.id, row.id);
      const run = project.running.get(task.id);
      const active = task.status === 'running' && run && run.recordId === data.run_id
        && !run.invocationEnded && !run.parked && !run.controller?.signal.aborted;
      return { ...data, seq: row.id, call_id: row.id, phase: 'started',
        status: completed || active ? 'running' : 'unknown',
        reason: !completed && !active ? 'completion_not_observed' : null,
        diagnostic: projectDiagnostic(project, task, managementDiagnostic(completed || active ? 'in_progress' : 'completion_not_observed', 'return', 'unknown', 'completion_not_observed',
          { actor_id: task.id, worker_number: task.worker_number, call_id: row.id, request_event_id: row.id, run_id: data.run_id,
            occurrence_id: data.occurrence_id, target_id: data.target_id, target_worker_number: data.target_worker_number })) };
    });
    return { items, next_cursor: (forward ? items.at(-1)?.seq : items[0]?.seq) ?? null,
      latest_cursor: items.at(-1)?.seq ?? null, has_more: rows.length > limit,
      coverage: 'trusted_management_rpc_events_only', history_complete: false };
  });
}
