import { check, id } from '../types.js';
import { checkDraftRevision } from './input-history.js';
import { inputOptions, inputEmission, emissionLocked, saveEmission, definitionHash, requestKey, publicDispatch } from './input-emission-data.js';
import { managementState } from './management-data.js';

const key = requestId => `management.draft.request:${requestKey(requestId)}`;
export const managementDraftRequest = (project, requestId) => requestId === undefined ? null
  : project.store.get('SELECT value FROM meta WHERE key=?', key(requestId));

/** Saving a management target is not admission to a new occurrence. Busy targets remain saveable. */
export function assertManagementDraftTarget(project, targetId) {
  if (targetId === null || targetId === undefined) return null;
  const task = project.store.task(id(targetId));
  check(task.role === 'manager' && task.task_kind === 'management' && managementState(task), 'management draft target must be a native Valet');
  return task;
}

export function assertManagementDraft(project, draftId, revision, definition = null) {
  const draft = project.store.draft(id(draftId)), options = inputOptions(draft);
  check(options.mode === 'management', 'management submission requires a management draft');
  checkDraftRevision(draft, revision);
  check(!emissionLocked(draft) && !project.draftHookMount(draft.id), 'management draft is already submitted; inspect its receipt, do not replay');
  check(options.conditions.length === 0 && options.exclusive === false && project.store.draftReferences(draft.id).length === 0,
    'management drafts do not support conditions, exclusive execution or reference attachments');
  if (definition) {
    check(draft.content === definition.instruction && (options.target_id ?? null) === (definition.kind === 'append' ? definition.id : null),
      'elevation definition does not match the exact saved draft content and target');
  }
  return draft;
}

export function managementDraftResult(project, draftId) {
  const draft = project.store.draft(draftId), state = inputEmission(draft);
  check(state?.kind === 'management' && state.state === 'succeeded', 'management submission receipt is unavailable; do not replay');
  const event = project.store.get("SELECT data FROM events WHERE id=? AND task_id=? AND type='management.draft_submitted'", state.receipt_id, state.worker_id);
  const receipt = event ? JSON.parse(event.data) : null;
  check(receipt?.draft_id === draft.id && receipt.revision === state.revision && receipt.occurrence_id === state.occurrence_id
    && receipt.definition_hash === state.definition_hash, 'original management receipt is unavailable; do not replay');
  return { management: true, task: project.inspect(state.worker_id), draft_id: draft.id, draft_number: draft.draft_number ?? null,
    revision: draft.revision, dispatch: publicDispatch(state) };
}

/** Called inside the same synchronous transaction as native creation/append and (if any) elevation. */
export function consumeManagementDraft(project, draft, submitted, fingerprint, authority = 'ordinary') {
  const task = project.store.task(submitted.id), occurrence = managementState(task)?.pending_signal;
  check(occurrence?.phase === 'pending', 'management draft must bind a newly accepted occurrence');
  const receiptId = project.store.event(task.id, 'management.draft_submitted', { draft_id: draft.id, revision: draft.revision,
    occurrence_id: occurrence.id, definition_hash: fingerprint, authority });
  const now = new Date().toISOString();
  saveEmission(project, draft.id, { version: 1, kind: 'management', revision: draft.revision, state: 'succeeded',
    definition_hash: fingerprint, worker_id: task.id, worker_number: task.worker_number ?? null, occurrence_id: occurrence.id,
    receipt_id: receiptId, ...(occurrence.message_id ? { message_id: occurrence.message_id } : {}), authority,
    signals: [], created_at: now, finished_at: now, reason: null, exclusive_active: false });
  return managementDraftResult(project, draft.id);
}

export function submitManagementDraft(project, options) {
  const request = options.client_request_id;
  requestKey(request); // Validate even on a receipt read.
  const fingerprint = definitionHash(options);
  project.assertWritable('submit a management draft');
  return project.store.transaction(() => {
    if (request !== undefined) {
      check(!project.managementElevationRequestUsed(request), 'client_request_id belongs to a password-elevated input; inspect its receipt instead');
      const prior = managementDraftRequest(project, request);
      if (prior) {
        const reference = JSON.parse(prior.value);
        check(reference.definition_hash === fingerprint, 'client_request_id was used for different management draft parameters');
        return managementDraftResult(project, reference.draft_id);
      }
      check(!project.store.get("SELECT id FROM tasks WHERE task_kind='management' AND json_extract(management,'$.client_request_id')=?", request),
        'client_request_id belongs to another management input');
    }
    const row = project.store.draft(id(options.draft_id)), state = inputEmission(row);
    if (state?.kind === 'management') {
      check(state.authority === 'ordinary', 'password-elevated draft must only be checked through its elevation receipt');
      check(state.definition_hash === fingerprint, 'submitted management draft parameters changed; inspect its receipt, do not replay');
      return managementDraftResult(project, row.id);
    }
    const draft = assertManagementDraft(project, options.draft_id, options.expected_revision), settings = inputOptions(draft);
    const target = assertManagementDraftTarget(project, settings.target_id);
    check(!target || options.profile === undefined, 'management append uses the original Valet model settings');
    const task = target ? project.appendManagementInstruction(target.id, draft.content)
      : project.createPreparedManagementWorker({ name: '管理输入', signal_id: null, instruction: draft.content,
        ...(options.profile === undefined ? {} : { profile: options.profile }) });
    const result = consumeManagementDraft(project, draft, task, fingerprint);
    if (request !== undefined) project.store.run('INSERT INTO meta(key,value) VALUES (?,?)', key(request),
      JSON.stringify({ draft_id: draft.id, definition_hash: fingerprint }));
    project.kick();
    return result;
  });
}
