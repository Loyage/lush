import { check, id } from '../types.js';
import { managementDiagnostic, safeManagementDiagnostic, validManagementReceiptParams } from '../management-diagnostic.js';
import { publicCapabilityDiagnostic, projectDiagnostic, capabilityDiagnosticSnapshot } from './management-diagnostic.js';
import { definitionHash, requestKey } from './input-emission-data.js';
import { PARAMS } from '../../rpc/registry.js';
import { projectAdministratorReadOnly } from '../../administrator/project-read-methods.js';

const parse = row => { try { return JSON.parse(row?.data ?? 'null'); } catch { return null; } };
const positive = value => Number.isSafeInteger(value) && value > 0;
const types = ['management.call_started','management.call_finished','management.capability_requested','management.capability_started',
  'management.capability_completed','management.capability_failed','management.capability_confirmation','management.capability_revoked',
  'management.capability_policy_rechecked','management.action_submitted','management.action_started','management.action_completed',
  'management.action_failed','management.action_skipped'];
const dispositions = ['management.unknown','management.failed','management.settled','management.binding_updated',
  'management.emergency_requested','management.emergency_isolated'];
const statuses = ['succeeded','waiting','skipped','unknown','pending_confirmation','approved','rejected','failed','running','cancelled'];
const methodName = value => typeof value === 'string' && Object.hasOwn(PARAMS, value) ? value : null;

/** Current and archived occurrence receipts; historical Events are never rewritten. */
export function findManagementCapability(project, task, receiptId) {
  if (!positive(receiptId)) return null;
  let state; try { state = JSON.parse(task.management); } catch { state = null; }
  const call = [...(state?.control_calls ?? []), ...(state?.last_execution?.control_calls ?? [])].find(item => item.receipt_id === receiptId);
  if (call) {
    const diagnostic = capabilityDiagnosticSnapshot(project, task, call);
    return diagnostic === call.diagnostic ? call : { ...call, diagnostic,
      status: call.status === 'running' ? projectAdministratorReadOnly(call) ? 'failed' : 'unknown' : call.status };
  }
  const requested = project.store.get("SELECT data FROM events WHERE id=? AND task_id=? AND type='management.capability_requested'", receiptId, task.id);
  if (!requested) return null;
  const data = parse(requested);
  const latest = project.store.get(`SELECT type,data FROM events WHERE task_id=? AND id>? AND type IN (${types.slice(3).map(() => '?').join(',')})
    AND json_extract(data,'$.receipt_id')=? ORDER BY id DESC LIMIT 1`, task.id, receiptId, ...types.slice(3), receiptId);
  const last = parse(latest);
  // A later confirmation/revocation can lack diagnostics. Find the latest sampled
  // execution diagnostic independently, retaining its original failure.
  const sampled = project.store.get(`SELECT data FROM events WHERE task_id=? AND id>? AND type IN ('management.capability_completed','management.capability_failed','management.call_finished')
    AND json_extract(data,'$.receipt_id')=? AND json_type(data,'$.diagnostic')='object'
    ORDER BY (json_type(data,'$.diagnostic.original_failure')='object') DESC,
      CASE WHEN json_type(data,'$.diagnostic.original_failure')='object' THEN id ELSE -id END ASC LIMIT 1`, task.id, receiptId, receiptId);
  return { receipt_id: receiptId, method: methodName(data?.method), occurrence_id: data?.occurrence_id,
    call_id: data?.call_id, run_id: data?.run_id, diagnostic: parse(sampled)?.diagnostic,
    status: statuses.includes(last?.status) ? last.status : latest?.type === 'management.capability_completed' ? 'succeeded'
      : latest?.type === 'management.capability_started' ? 'unknown' : 'unknown' };
}

export function findManagementAction(project, task, receiptId) {
  if (!positive(receiptId)) return null;
  let state; try { state = JSON.parse(task.management); } catch { state = null; }
  const action = [...(state?.receipts ?? []), ...(state?.last_execution?.actions ?? [])].find(item => item.receipt_id === receiptId);
  if (action) {
    const diagnostic = capabilityDiagnosticSnapshot(project, task, action);
    return diagnostic === action.diagnostic ? action : { ...action, diagnostic, status: action.status === 'running' ? 'unknown' : action.status };
  }
  const start = project.store.get("SELECT data FROM events WHERE id=? AND task_id=? AND type='management.action_submitted'", receiptId, task.id);
  if (!start) return null;
  const data = parse(start) ?? {};
  const last = project.store.get(`SELECT type,data FROM events WHERE task_id=? AND id>? AND type IN
    ('management.action_started','management.action_completed','management.action_failed','management.action_skipped')
    AND json_extract(data,'$.receipt_id')=? ORDER BY id DESC LIMIT 1`, task.id, receiptId, receiptId);
  const sampled = project.store.get(`SELECT data FROM events WHERE task_id=? AND id>? AND type IN
    ('management.action_started','management.action_completed','management.action_failed','management.action_skipped','management.call_finished')
    AND json_extract(data,'$.receipt_id')=? AND json_type(data,'$.diagnostic')='object'
    ORDER BY (json_type(data,'$.diagnostic.original_failure')='object') DESC,
      CASE WHEN json_type(data,'$.diagnostic.original_failure')='object' THEN id ELSE -id END ASC LIMIT 1`, task.id, receiptId, receiptId);
  const latest = parse(last), observation = parse(sampled);
  return { receipt_id: receiptId, action: ['start','retry'].includes(data.action) ? data.action : null,
    target_id: data.target_id, occurrence_id: data.occurrence_id, call_id: data.call_id, run_id: data.run_id,
    capability_receipt_id: data.capability_receipt_id, diagnostic: observation?.diagnostic,
    status: statuses.includes(latest?.status) ? latest.status : last?.type === 'management.action_completed' ? 'succeeded'
      : last?.type === 'management.action_skipped' ? 'skipped' : statuses.includes(observation?.result?.status) ? observation.result.status : 'unknown' };
}

export function managementActionView(project, task, action) {
  const diagnostic = publicCapabilityDiagnostic(project, task, action);
  return { receipt_id: action.receipt_id, action: ['start','retry'].includes(action.action) ? action.action : null,
    status: statuses.includes(action.status) ? action.status : 'unknown',
    target_id: diagnostic.correlation.target_id, target_worker_number: diagnostic.correlation.target_worker_number,
    capability_receipt_id: positive(action.capability_receipt_id) ? action.capability_receipt_id : null,
    ...(action.reason ? { reason: diagnostic.reason } : {}), diagnostic };
}

/** Exact persisted facts only. A mount proves neither creation nor Provider start. */
export function managementInputEmitFacts(project, call) {
  if (call?.method !== 'input.emit') return null;
  const params = call.params;
  let requestedDraftId = null;
  try { if (params?.draft_id !== undefined) requestedDraftId = id(params.draft_id); } catch { /* Rejected parameters cannot identify a draft. */ }
  const owner = project.store.get("SELECT task_id FROM events WHERE id=? AND type='management.capability_requested'", call.receipt_id);
  const boundary = owner ? project.store.get(`SELECT id FROM events WHERE task_id=? AND id>? AND
    ((type IN ('management.capability_completed','management.capability_failed','management.call_finished') AND json_extract(data,'$.receipt_id')=?)
      OR (type IN ('management.unknown','management.failed') AND json_extract(data,'$.occurrence_id')=?)) ORDER BY id LIMIT 1`,
  owner.task_id, call.receipt_id, call.receipt_id, call.occurrence_id ?? null)?.id : null;
  const upper = boundary ?? Number.MAX_SAFE_INTEGER;
  let mount = null;
  if (params && typeof params.client_request_id === 'string') {
    let key;
    try { key = requestKey(params.client_request_id); } catch { /* Rejected/legacy parameters are not proof of a mount. */ }
    const candidate = key ? project.store.get("SELECT id,data FROM events WHERE type='input.emitted' AND json_extract(data,'$.request_key')=? AND id<=? ORDER BY id DESC LIMIT 1", key, upper) : null;
    if (candidate && parse(candidate)?.definition_hash === definitionHash(params)) mount = candidate;
  } else if (requestedDraftId && (positive(params.expected_revision) || params.expected_revision === null)) {
    mount = project.store.get("SELECT id,data FROM events WHERE type='input.emitted' AND json_extract(data,'$.draft_id')=? AND json_extract(data,'$.revision') IS ? AND id<=? ORDER BY id DESC LIMIT 1", requestedDraftId, params.expected_revision, upper);
  } else if (positive(call.result?.draft_id) && (positive(call.result?.revision) || call.result?.revision === null)) {
    // Successful receipt returned this exact draft revision, not a later remount.
    mount = project.store.get("SELECT id,data FROM events WHERE type='input.emitted' AND json_extract(data,'$.draft_id')=? AND json_extract(data,'$.revision') IS ? AND id<=? ORDER BY id DESC LIMIT 1", call.result.draft_id, call.result.revision, upper);
  }
  const mounted = parse(mount), draftId = mounted?.draft_id;
  if (!positive(draftId)) return { mount: 'unknown', dispatch: 'unknown', worker_started: 'unknown', coverage: 'exact_persisted_input_facts_only' };
  const draft = project.store.get('SELECT id,input_id,revision,emission FROM drafts WHERE id=?', draftId);
  let emission; try { emission = JSON.parse(draft?.emission); } catch { emission = null; }
  // Bound the exact draft authorization by its next mount, not timestamps or text.
  const nextMount = project.store.get("SELECT id FROM events WHERE type='input.emitted' AND json_extract(data,'$.draft_id')=? AND id>? ORDER BY id LIMIT 1", draftId, mount.id);
  const current = !nextMount && draft?.revision === mounted.revision && emission?.revision === mounted.revision ? emission : null;
  const dispatch = project.store.get("SELECT id,data FROM events WHERE type='input.dispatch_succeeded' AND json_extract(data,'$.draft_id')=? AND id>? AND id<? ORDER BY id LIMIT 1",
    draftId, mount.id, nextMount?.id ?? Number.MAX_SAFE_INTEGER);
  const delivered = parse(dispatch);
  const inputId = positive(delivered?.input_id) ? delivered.input_id : null;
  const task = positive(delivered?.worker_id) ? project.store.get('SELECT id,worker_number FROM tasks WHERE id=?', delivered.worker_id) : null;
  return { mount: 'confirmed', mount_event_id: mount.id, draft_id: draftId,
    revision: positive(mounted.revision) ? mounted.revision : null,
    source_draft_id: draftId, dispatch: dispatch ? 'confirmed' : current && ['queued','waiting_conditions'].includes(current.state) ? 'not_started' : 'unknown',
    dispatch_event_id: dispatch?.id ?? null, input_id: inputId, worker_id: task?.id ?? null,
    worker_number: safeManagementDiagnostic({ correlation: { worker_number: task?.worker_number } }).correlation.worker_number,
    message_id: positive(delivered?.message_id) ? delivered.message_id : null,
    // An append target's older Run is not evidence that this message started an invocation.
    worker_started: inputId && task && project.store.get('SELECT id FROM agent_runs WHERE task_id=? LIMIT 1', task.id) ? 'confirmed' : 'unknown',
    coverage: 'exact_persisted_input_facts_only' };
}

export function managementReceipt(project, params) {
  check(validManagementReceiptParams(params), 'invalid management receipt parameters');
  const anchor = project.store.get(`SELECT id,task_id,type,data FROM events WHERE id=? AND type IN
    ('management.capability_requested','management.action_submitted','management.call_started','management.call_finished')`, params.receipt_id);
  check(anchor, 'management receipt not found in current project');
  const task = project.store.task(anchor.task_id);
  check(task.role === 'manager' && task.task_kind === 'management', 'receipt requires a management Worker');
  const data = parse(anchor) ?? {};
  const callId = anchor.type === 'management.call_started' ? anchor.id : data.call_id;
  const finished = positive(callId) ? project.store.get("SELECT id,data FROM events WHERE task_id=? AND type='management.call_finished' AND json_extract(data,'$.call_id')=? ORDER BY id DESC LIMIT 1", task.id, callId) : null;
  const end = parse(finished);
  let receiptId = ['management.capability_requested','management.action_submitted'].includes(anchor.type) ? anchor.id : end?.receipt_id ?? data.receipt_id;
  if (!positive(receiptId) && positive(callId)) receiptId = project.store.get("SELECT id FROM events WHERE task_id=? AND type IN ('management.capability_requested','management.action_submitted') AND json_extract(data,'$.call_id')=? ORDER BY id LIMIT 1", task.id, callId)?.id;
  let capability = findManagementCapability(project, task, receiptId), action = findManagementAction(project, task, receiptId);
  const call = capability ?? action;
  if (capability && !action) {
    const relatedId = capability.result?.action?.receipt_id ?? project.store.get("SELECT id FROM events WHERE task_id=? AND type='management.action_submitted' AND json_extract(data,'$.capability_receipt_id')=? ORDER BY id LIMIT 1", task.id, capability.receipt_id)?.id;
    action = findManagementAction(project, task, relatedId);
  } else if (action?.capability_receipt_id) capability = findManagementCapability(project, task, action.capability_receipt_id);
  const diagnostic = call ? publicCapabilityDiagnostic(project, task, call) : projectDiagnostic(project, task,
    end?.diagnostic ?? data.diagnostic ?? managementDiagnostic(end ? 'legacy_unknown' : 'completion_not_observed', end ? 'legacy' : 'return', 'unknown',
      end ? 'legacy_missing' : 'completion_not_observed', { actor_id: task.id, call_id: callId, request_event_id: callId, run_id: data.run_id, occurrence_id: data.occurrence_id }));
  const linkedCall = call?.call_id ?? callId;
  const relatedIds = [...new Set([receiptId, capability?.receipt_id, action?.receipt_id, linkedCall].filter(positive))];
  const receiptIds = [...new Set([receiptId, capability?.receipt_id, action?.receipt_id].filter(positive))];
  const after = params.after ?? 0, limit = params.limit ?? 30;
  const rows = project.store.all(`SELECT id,type,data,created_at FROM events WHERE task_id=? AND id>? AND type IN (${[...types, ...dispositions].map(() => '?').join(',')})
    AND (id IN (${relatedIds.map(() => '?').join(',') || 'NULL'}) OR json_extract(data,'$.call_id')=?
      OR json_extract(data,'$.receipt_id') IN (${receiptIds.map(() => '?').join(',') || 'NULL'})
      OR (type IN (${dispositions.map(() => '?').join(',')}) AND id>=? AND
        (type IN ('management.binding_updated','management.emergency_requested','management.emergency_isolated') OR json_extract(data,'$.occurrence_id')=?))) ORDER BY id LIMIT ?`,
  task.id, after, ...types, ...dispositions, ...relatedIds, linkedCall ?? null, ...receiptIds,
  ...dispositions, receiptId ?? linkedCall ?? anchor.id, call?.occurrence_id ?? data.occurrence_id ?? end?.occurrence_id ?? null, limit + 1);
  const candidates = rows.slice(0, limit).map(row => {
    const event = parse(row) ?? {};
    return { seq: row.id, type: row.type, created_at: row.created_at,
      call_id: positive(event.call_id) ? event.call_id : row.type === 'management.call_started' ? row.id : null,
      receipt_id: positive(event.receipt_id) ? event.receipt_id : ['management.capability_requested','management.action_submitted'].includes(row.type) ? row.id : null,
      status: statuses.includes(event.status) ? event.status : null,
      diagnostic: event.diagnostic ? projectDiagnostic(project, task, event.diagnostic) : null };
  });
  const items = []; let bytes = 0;
  for (const item of candidates) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > 60000) break;
    items.push(item); bytes += size;
  }
  return { version: 1, scope: 'current_project', receipt_id: anchor.id, capability_receipt_id: capability?.receipt_id ?? null,
    action_receipt_id: action?.receipt_id ?? null, action: action ? managementActionView(project, task, action) : null,
    call_id: linkedCall ?? null, method: methodName(call?.method ?? (call?.action === 'start' ? 'worker.resume' : call?.action === 'retry' ? 'worker.retry' : null) ?? end?.method ?? data.method),
    status: statuses.includes(call?.status ?? end?.status) ? call?.status ?? end.status : 'unknown', diagnostic,
    input_emit: managementInputEmitFacts(project, call),
    timeline: { items, next_cursor: items.at(-1)?.seq ?? null, has_more: rows.length > items.length,
      truncated: items.length < candidates.length, coverage: 'linked_safe_management_events_only' },
    coverage: 'structured_management_diagnostic_only', history_complete: false };
}
