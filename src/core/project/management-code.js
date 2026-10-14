import { check, id, isPlainObject } from '../types.js';
import { hookRevision } from '../hooks.js';
import { assertManager } from './management-auth.js';
import { MANAGEMENT_READ_ITEMS, managementState } from './management-data.js';
import { LUSHC_METHODS, managementDispatchParams, validateManagementCall } from '../../rpc/management-policy.js';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : isPlainObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

/** Internal receipt authority, never an RPC parameter or replacement user actor.
 * Confirmed actions can outlive the model invocation, but not their fixed occurrence. */
export function assertManagementCapabilityExecution(project, actorId, receiptId, method, params) {
  const actor = project.store.task(id(actorId)), state = managementState(actor);
  check(actor.role === 'manager' && actor.task_kind === 'management' && state?.enabled
    && state.pending_signal && project.managementOccupant()?.id === actor.id, 'management execution authorization is not active');
  if (receiptId === null || receiptId === undefined) {
    const policy = validateManagementCall(method, params, actor.goal, state.permissions_snapshot);
    check(policy.access === 'read', 'management writes require a durable capability receipt');
    assertManager(project, actor.id);
    return { actor, state };
  }
  const call = (state.control_calls ?? []).find(item => item.receipt_id === receiptId);
  check(call?.status === 'running' && call.method === method && call.occurrence_id === state.pending_signal.id,
    'management execution must match the running fixed capability receipt');
  const policy = validateManagementCall(method, call.params, actor.goal, state.permissions_snapshot);
  check(call.fingerprint === hookRevision({ method, params: canonical(call.params) })
    && hookRevision({ method, params: canonical(params) })
      === hookRevision({ method, params: canonical(managementDispatchParams(method, call.params)) }),
    'management execution must match the running fixed capability receipt');
  if (policy.access === 'confirmation') {
    const notice = project.store.get('SELECT task_id,status,answer_source,answer FROM notices WHERE id=?', call.notice_id);
    let answer; try { answer = JSON.parse(notice?.answer); } catch { answer = null; }
    const choice = answer?.answers?.[0];
    check(notice?.task_id === actor.id && notice.status === 'answered' && notice.answer_source === 'user'
      && choice?.selected?.length === 1 && choice.selected[0] === 1 && !choice.custom,
    'management execution requires exact user confirmation');
  }
  return { actor, state, call };
}

export function assertManagementCodeExecution(project, actorId, receiptId, method, params) {
  check(LUSHC_METHODS.has(method), 'not a development CLI capability');
  return assertManagementCapabilityExecution(project, actorId, receiptId, method, params);
}

/** Lushc query support intentionally does not expose raw provider/tool material.
 * Metadata is projected before the generic bounded management response exit. */
export function managementCodeReadResult(method, value, project, params) {
  // Inspect and a legacy tree fallback can otherwise smuggle raw provider/run,
  // inbox or artifact bodies around the dedicated history/transcript projection.
  const workerMetadata = row => {
    if (!row || typeof row !== 'object') return row;
    const { result, error, integration_error, messages, runs, artifacts, notices, report,
      specs, verifications, resolutions, divergence_resolution, ...summary } = row;
    const goal = typeof row.goal === 'string' ? row.goal.slice(0, 500) : null;
    // Tree summaries are already shortened by SQLite. Do not label their visible
    // length as the complete goal length; count the original without exposing it.
    const original = method === 'worker.tree' && Number.isSafeInteger(row.id)
      ? project?.store?.get('SELECT goal FROM tasks WHERE id=?', row.id)?.goal : row.goal;
    const goalLength = original?.length ?? row.goal_length ?? goal?.length;
    return { ...summary, ...(goal !== null ? { goal, goal_length: goalLength,
      goal_truncated: row.goal_truncated === true || goalLength > goal.length } : {}),
      ...(Array.isArray(row.children) ? { children: row.children.map(workerMetadata) } : {}),
      coverage: 'worker_metadata_only', omitted: ['provider_result', 'provider_error', 'inbox', 'artifacts', 'raw_runs', 'notice_bodies'] };
  };
  if (method === 'worker.inspect') return workerMetadata(value);
  if (method === 'worker.tree') return Array.isArray(value) ? value.map(workerMetadata) : workerMetadata(value);
  if (method === 'worker.history') {
    const events = value.slice(0, MANAGEMENT_READ_ITEMS), next = events.at(-1)?.id ?? params.after ?? 0;
    return {
      events: events.map(row => ({ id: row.id, task_id: row.task_id, type: row.type, created_at: row.created_at })),
      next, has_more: Boolean(project.store.get('SELECT id FROM events WHERE task_id=? AND id>? LIMIT 1', params.id, next)),
      events_truncated: events.length < value.length,
      coverage: 'event_metadata_only', omitted: ['event_data'],
    };
  }
  if (method === 'worker.transcript') {
    const source = value.steps ?? [], steps = source.slice(0, MANAGEMENT_READ_ITEMS), clipped = steps.length < source.length;
    return {
      task_id: value.task_id, next: steps.at(-1)?.seq ?? value.next,
      has_more: Boolean(value.has_more || clipped), truncated: value.truncated, steps_truncated: clipped,
      steps: steps.map(step => ({ seq: step.seq,
        kind: ['input','result','meta','thinking','tool','text'].includes(step.kind) ? step.kind : 'unknown',
        ...(typeof step.at === 'string' ? { at: step.at } : {}),
        ...(typeof step.is_error === 'boolean' ? { is_error: step.is_error } : {}),
      })),
      coverage: 'step_metadata_only', omitted: ['prompt', 'body', 'tool_arguments', 'tool_output', 'file', 'call_id'],
    };
  }
  return value;
}

/** Dispatch reviewed development operations as the real Valet, not a fabricated
 * development parent or user. The underlying engines retain their safety gates. */
export async function dispatchManagementCode(project, method, params, actorId, receiptId, invoke) {
  assertManagementCodeExecution(project, actorId, receiptId, method, params);
  if (method === 'worker.spawn') {
    check(params.parent !== undefined, 'Valet delegation requires an explicit development parent');
    const parent = project.store.task(id(params.parent));
    check(['order','child'].includes(parent.task_kind), 'Valet can only delegate under a development Worker');
    return project.spawn(parent.id, params.goal, 'agent', [], params.name ?? null);
  }
  if (method === 'worker.message') {
    check(['order','child'].includes(project.store.task(id(params.id)).task_kind), 'Valet messages require a development Worker');
    return project.message(id(params.id), params.body, actorId, false, receiptId);
  }
  if (method === 'worker.accept') return project.acceptTask(id(params.id), actorId, { managementReceipt: receiptId });
  // Invocation-owned progress/title/Notice handlers retain the actual actor. In
  // particular notice.post cannot use params.task to post for a development target.
  const value = await invoke(actorId);
  return managementCodeReadResult(method, value, project, params);
}
