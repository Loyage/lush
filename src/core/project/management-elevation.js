import { createHash } from 'node:crypto';
import { check, isPlainObject, id } from '../types.js';
import { managementState, managementInstruction, saveManagement } from './management-data.js';
import { assertManagementDraft, consumeManagementDraft, managementDraftResult, managementDraftRequest } from './management-drafts.js';
import { definitionHash } from './input-emission-data.js';
import { normalizeProjectElevation, projectElevationText, PROJECT_ELEVATION_MODE, PROJECT_ELEVATION_SCOPE } from '../../administrator/project-protocol.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const requestKey = value => `management.elevation.request:${hash(value)}`;
const grantKey = value => `management.elevation.grant:${hash(value)}`;
function requestId(value) {
  check(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'elevation client_request_id required');
  return value;
}
// Authentication is injected by trusted Dispatcher assembly. Browser, verifier and native
// intake now share the delivered protocol; a boolean approval still cannot grant power.
function verified(project, proof, kind) {
  check(typeof project.verifyProjectElevationProof === 'function', 'project elevation proof verifier is not configured');
  const accepted = project.verifyProjectElevationProof(proof);
  check(isPlainObject(accepted) && Object.keys(accepted).sort().join(',') === 'definition,definition_hash,grant_id,verified_at', 'trusted synchronous elevation verification required');
  let definition;
  try { definition = normalizeProjectElevation(accepted.definition); }
  catch { check(false, 'invalid project administrator definition'); }
  check(definition.kind === kind, 'elevation definition does not match this entrypoint');
  check(typeof accepted.grant_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(accepted.grant_id), 'verified elevation grant identity required');
  check(typeof accepted.definition_hash === 'string' && /^[a-f0-9]{64}$/.test(accepted.definition_hash)
    && accepted.definition_hash === hash(projectElevationText(definition)), 'verified elevation definition changed');
  check(typeof accepted.verified_at === 'string' && Number.isFinite(Date.parse(accepted.verified_at)), 'elevation verification time required');
  return { ...accepted, definition };
}
function lookup(project, clientRequestId) {
  const entry = project.store.get('SELECT value FROM meta WHERE key=?', requestKey(clientRequestId));
  if (!entry) return null;
  const reference = JSON.parse(entry.value);
  const event = project.store.get("SELECT task_id,data FROM events WHERE id=? AND task_id=? AND type='management.elevation_accepted'", reference.source_event_id, reference.task_id);
  if (!event) return { reference, unavailable: true };
  const source = JSON.parse(event.data);
  check(source.definition_hash === reference.definition_hash && source.occurrence_id === reference.occurrence_id
    && source.definition?.client_request_id === clientRequestId, 'elevation receipt association is inconsistent');
  return { reference, source };
}
function result(project, record) {
  check(record && !record.unavailable && project.store.get('SELECT id FROM tasks WHERE id=?', record.reference.task_id), 'original elevation record is unavailable; do not replay');
  return { ...(record.source.definition.draft_id === undefined ? { management: true, task: project.inspect(record.reference.task_id) }
    : managementDraftResult(project, record.source.definition.draft_id)), instruction: record.source.definition.instruction };
}
function accept(project, accepted) {
  const definition = accepted.definition;
  const prior = lookup(project, definition.client_request_id);
  if (prior) {
    check(!prior.unavailable && prior.source.definition_hash === accepted.definition_hash
      && JSON.stringify(prior.source.definition) === JSON.stringify(definition), 'client_request_id is already used for a different elevation definition');
    return result(project, prior); // Read only: no new occurrence and no restoration of revoked authority.
  }
  check(!project.store.get('SELECT value FROM meta WHERE key=?', grantKey(accepted.grant_id)), 'elevation grant has already been consumed');
  check(!project.store.get(`SELECT id FROM tasks WHERE task_kind='management' AND json_extract(management,'$.client_request_id')=?`, definition.client_request_id),
    'client_request_id belongs to an ordinary management input and cannot be elevated');
  check(!managementDraftRequest(project, definition.client_request_id), 'client_request_id belongs to an ordinary management draft input');
  const draft = definition.draft_id === undefined ? null : assertManagementDraft(project, definition.draft_id, definition.expected_revision, definition);
  const submitted = definition.kind === 'submit'
    ? project.submitManagementInstruction({ instruction: definition.instruction, client_request_id: definition.client_request_id,
      ...(Object.hasOwn(definition, 'profile') ? { profile: definition.profile } : {}) }).task
    : project.appendManagementInstruction(id(definition.id), definition.instruction);
  const task = project.store.task(submitted.id), state = managementState(task), occurrence = state?.pending_signal;
  check(occurrence?.phase === 'pending' && !occurrence.elevation && managementInstruction(project, task, state) === definition.instruction,
    'elevation must bind the newly submitted exact management occurrence');
  const instructionHash = hash(managementInstruction(project, task, state));
  const sourceEventId = project.store.event(task.id, 'management.elevation_accepted', {
    version: 1, mode: PROJECT_ELEVATION_MODE, scope: PROJECT_ELEVATION_SCOPE, project: project.config.project,
    grant_id: accepted.grant_id, definition_hash: accepted.definition_hash, instruction_hash: instructionHash,
    occurrence_id: occurrence.id, verified_at: accepted.verified_at, definition,
  });
  occurrence.elevation = { version: 1, mode: PROJECT_ELEVATION_MODE, scope: PROJECT_ELEVATION_SCOPE, project: project.config.project,
    grant_id: accepted.grant_id, definition_hash: accepted.definition_hash, instruction_hash: instructionHash,
    occurrence_id: occurrence.id, source_event_id: sourceEventId, verified_at: accepted.verified_at };
  saveManagement(project, task.id, state);
  const reference = { version: 1, task_id: task.id, source_event_id: sourceEventId, definition_hash: accepted.definition_hash, occurrence_id: occurrence.id };
  // Meta holds only immutable association/dedupe references. Full definitions belong to the
  // Worker Event, so normal explicit Worker/history deletion removes the instruction material.
  project.store.run('INSERT INTO meta(key,value) VALUES (?,?)', requestKey(definition.client_request_id), JSON.stringify(reference));
  project.store.run('INSERT INTO meta(key,value) VALUES (?,?)', grantKey(accepted.grant_id), JSON.stringify(reference));
  return { ...(draft ? consumeManagementDraft(project, draft, task, definitionHash(definition), 'administrator')
    : { management: true, task: project.inspect(task.id) }), instruction: definition.instruction };
}

export default {
  managementElevationRequestUsed(clientRequestId) {
    return Boolean(this.store.get('SELECT value FROM meta WHERE key=?', requestKey(clientRequestId)));
  },
  submitElevatedManagementInstruction(proof) {
    this.assertWritable('submit an elevated management instruction');
    const accepted = verified(this, proof, 'submit');
    return this.store.transaction(() => accept(this, accepted));
  },
  appendElevatedManagementInstruction(proof) {
    this.assertWritable('append an elevated management instruction');
    const accepted = verified(this, proof, 'append');
    return this.store.transaction(() => accept(this, accepted));
  },
  managementElevationReceipt(clientRequestId) {
    const record = lookup(this, requestId(clientRequestId));
    if (!record || record.unavailable || !this.store.get('SELECT id FROM tasks WHERE id=?', record.reference.task_id)) return { version: 1, found: false };
    const current = result(this, record);
    return { version: 1, found: true, definition: record.source.definition, ...current };
  },
};
