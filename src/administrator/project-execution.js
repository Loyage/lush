import { check, isPlainObject } from '../core/types.js';
import { hookRevision } from '../core/hooks.js';
import { MergeConditionCycleError } from '../core/merge-conditions.js';
import { safeManagementDiagnostic } from '../core/management-diagnostic.js';
import { PARAMS, assertAllowed } from '../rpc/registry.js';
import { RETIRED_MANAGEMENT_METHODS } from '../rpc/management-policy.js';
import { settleNoticeAnswer } from '../core/project/messages.js';
import { assertManager } from '../core/project/management-auth.js';
import { managementState, saveManagement, managementTime, MANAGEMENT_LIMITS, managementReceiptRoom, assertManagementReceiptRoom } from '../core/project/management-data.js';
import { trackControlJob } from '../core/project/management-control.js';
import { inputOptions } from '../core/project/input-emission-data.js';
import { capabilityDiagnostic } from '../core/project/management-diagnostic.js';
import { safeAdministratorValue, canonicalAdministratorValue } from './delegation.js';
import { readProjectAdministratorSource } from './project-source.js';
import { PROJECT_ADMINISTRATOR_RPC, PROJECT_ADMINISTRATOR_OPERATIONS, validateProjectAdministratorTool } from './project-tool-protocol.js';

import { PROJECT_READS } from './project-read-methods.js';

// Scope is decided from actual handlers, not USER_ONLY minus a denylist or an omitted scope parameter.
const PROJECT_WRITES = new Set(['system.interrupt_all','system.resume_all','system.stop','system.stop_if_idle','order.submit','input.emit','input.emission_cancel','input.exclusive_release','draft.add','draft.update','draft.remove',
  'worker.create','worker.spawn','worker.rename','worker.reserve','worker.reserve_all','worker.auto_merge','worker.accept','worker.accept_force','worker.reopen','worker.sync_parent','worker.resolve_sync','worker.unreserve',
  'worker.message','worker.cancel','worker.retry','worker.clear_override','worker.cleanup','worker.delete','worker.interrupt','worker.resume','worker.configure','worker.completion','worker.merge_after','worker.acceptance_notice',
  'notice.post','notice.answer','notice.dismiss','notice.read','branch.bind','branch.archive','branch.integrate_start','branch.integrate_cancel','branch.integrate_retry','branch.convergence_retry',
  // Only these project-local built-in lifecycle settings are writable. Generic registry,
  // command, signal and mount mutations can persist arbitrary code or future Agent inputs.
  'hooks.completion_defaults','hooks.automation_settings','management.emergency_stop']);
export function projectAdministratorMethods() { return [...PROJECT_READS,...PROJECT_WRITES].filter(method => Object.hasOwn(PARAMS,method) && !RETIRED_MANAGEMENT_METHODS.has(method)); }
function fields(value, allowed) { check(isPlainObject(value) && Object.keys(value).every(key => allowed.includes(key)), 'invalid project administrator parameters'); }
function privateFields(value, depth = 0) {
  check(depth < 20, 'project administrator nesting limit');
  if (Array.isArray(value)) return value.forEach(item => privateFields(item,depth + 1));
  if (!isPlainObject(value)) return;
  for (const [key,item] of Object.entries(value)) {
    check(!key.startsWith('_') && !/^(?:project|cwd|executable|extensions|skills|env|prompt|default_prompt|append_prompt|privatePrompt|systemPrompt|credential|credentials|password|api_key|apiKey|accessToken|refreshToken|token)$/i.test(key), 'private or out-of-project parameter unavailable');
    privateFields(item,depth + 1);
  }
}
function authorize(project, actorId) {
  const actor = assertManager(project,actorId);
  check(typeof project.projectElevationAssert === 'function','trusted project elevation verifier is not installed');
  const grant = project.projectElevationAssert(actorId);
  check(grant?.task?.id === actor.task.id && grant.state?.pending_signal?.id === actor.state.pending_signal.id
    && grant.elevation?.mode === 'administrator' && grant.elevation.scope === 'current_project' && grant.elevation.project === project.config.project
    && grant.run === project.running.get(actorId), 'current native project elevation required');
  return grant;
}
export function projectAdministratorCatalog() {
  return PROJECT_ADMINISTRATOR_OPERATIONS.map(name => ({ name, readOnly: name !== 'project.call',
    ...(name === 'project.call' ? { parameters: ['method','params'], methods: projectAdministratorMethods().map(method => ({ method, readOnly: PROJECT_READS.has(method), parameters: PARAMS[method] })) }
      : name === 'catalog' ? { parameters: [], scope: 'current_project', no_device_settings: true, no_host_or_cross_project: true,
          automation_writes: 'project_builtin_lifecycle_only', no_custom_commands_registry_or_mounts: true, no_extension_or_skill_overrides: true }
      : { parameters: ['path','offset','limit'], scope: 'current_project', private_paths: 'excluded' }) }));
}
function validateBusiness(project, actorId, params) {
  fields(params,['method','params']);
  check(projectAdministratorMethods().includes(params.method) && isPlainObject(params.params), 'method is not a current-project administrator capability');
  privateFields(params.params);
  check(params.params.scope !== 'device', 'device scope is unavailable to project elevation');
  assertAllowed(params.method,params.params,null);
  if (['draft.add','draft.update','draft.remove','input.emit','order.submit'].includes(params.method)) {
    const draftId = params.method.startsWith('draft.') ? params.params.id : params.params.draft_id;
    check(params.params.mode !== 'management' && (draftId === undefined || inputOptions(project.store.draft(draftId)).mode !== 'management'),
      'management drafts require the actual user entrance');
  }
  if (params.method === 'notice.post') check(params.params.kind === 'info' && (params.params.task === undefined || params.params.task === actorId), 'project elevation cannot create password-free decision questions');
  if (['notice.answer','notice.dismiss'].includes(params.method)) {
    const notice = project.store.get('SELECT task_id FROM notices WHERE id=?',params.params.id);
    check(notice && project.store.task(notice.task_id).task_kind !== 'management','Valet decisions require the actual user entrance');
  }
  if (params.method.startsWith('worker.') && !PROJECT_READS.has(params.method)) {
    const target = params.method === 'worker.spawn' ? params.params.parent : params.params.id;
    if (Number.isSafeInteger(target)) check(project.store.task(target).task_kind !== 'management','cannot inject inputs or mutate management identities through administrator business calls');
  }
  return PROJECT_READS.has(params.method);
}
function view(call) { return { receipt_id: call.receipt_id, method: call.method, operation: call.operation, status: call.status, result: call.result ?? null,
  reason: call.reason ?? null, diagnostic: call.diagnostic ?? null, effect: call.effect ?? 'unknown' }; }
function boundedResult(value, state) {
  const safe = safeAdministratorValue(value), encoded = JSON.stringify(safe);
  const budget = Math.min(16000, managementReceiptRoom(state) - 64);
  if (Buffer.byteLength(encoded) <= budget) return safe;
  const result = { ...(isPlainObject(safe) && typeof safe.status === 'string' ? { status: safe.status } : {}),
    ...(isPlainObject(safe) && typeof safe.effect === 'string' ? { effect: safe.effect } : {}),
    truncated: true, coverage: 'native_management_receipt_budget' };
  // Exact input/Worker identities remain evidence even when optional output is
  // clipped; provenance and receipt readers must not depend on a text preview.
  if (isPlainObject(safe)) {
    for (const key of ['id','draft_id','revision']) if (Number.isSafeInteger(safe[key]) || key === 'revision' && safe[key] === null) result[key] = safe[key];
    if (typeof safe.emitted === 'boolean') result.emitted = safe.emitted;
  }
  // Failure readability is mandatory, unlike an optional result preview. Bound
  // JSON bytes (including escaping/multibyte text), not just character count.
  if (isPlainObject(safe) && safe.original_failure !== undefined) {
    const failure = safe.original_failure;
    result.original_failure = Buffer.byteLength(JSON.stringify(failure)) <= 2048 ? failure : typeof failure === 'string' ? failure.slice(0, 240) : {
      name: typeof failure?.name === 'string' ? failure.name.slice(0, 80) : 'Error',
      message: typeof failure?.message === 'string' ? failure.message.slice(0, 240) : 'unclassified failure', truncated: true };
  }
  let preview = encoded.slice(0, 2000);
  while (preview && Buffer.byteLength(JSON.stringify({ ...result, preview })) > budget) preview = preview.slice(0, Math.floor(preview.length / 2));
  if (preview) result.preview = preview;
  check(Buffer.byteLength(JSON.stringify(result)) <= budget, 'management result budget exhausted; receipt remains unresolved');
  return result;
}
/** Actual project invocation is supplied by Dispatcher, never model params or a device delegation. */
export async function callProjectAdministrator(project, actorId, request, invoke) {
  validateProjectAdministratorTool(request);
  let grant = authorize(project,actorId);
  project.assertWritable('execute project administrator capability');
  const { operation,params } = request;
  let readOnly = operation !== 'project.call';
  if (operation === 'project.call') readOnly = validateBusiness(project,actorId,params);
  else if (operation === 'catalog') fields(params,[]);
  else fields(params,['path','offset','limit']);
  const copied = canonicalAdministratorValue(params), fingerprint = hookRevision({ operation,params:copied });
  let state = grant.state;
  const duplicate = state.control_calls?.find(call => call.occurrence_id === state.pending_signal.id && call.request_id === `project-administrator:${fingerprint}`);
  if (duplicate) return view(duplicate);
  check((state.control_calls?.length ?? 0) + state.receipts.length < MANAGEMENT_LIMITS.actions,'management occurrence action limit reached');
  assertManagementReceiptRoom(state, Buffer.byteLength(JSON.stringify(copied)) + 6000);
  let call;
  project.store.transaction(() => {
    const method = operation === 'project.call' ? params.method : PROJECT_ADMINISTRATOR_RPC;
    const receiptId = project.store.event(actorId,'management.capability_requested',{ method,operation,access:'project_administrator',occurrence_id:state.pending_signal.id,
      actor_id:actorId,worker_number:grant.task.worker_number,run_id:grant.run.recordId,
      grant_id:grant.elevation.grant_id,source_event_id:grant.elevation.source_event_id,fingerprint });
    call = { receipt_id:receiptId,method,operation,params:copied,fingerprint,request_id:`project-administrator:${fingerprint}`,occurrence_id:state.pending_signal.id,
      authorization_mode:'project_administrator',source_event_id:grant.elevation.source_event_id,grant_id:grant.elevation.grant_id,run_id:grant.run.recordId,status:'running',created_at:managementTime(project),started_at:managementTime(project),effect:readOnly?'not_applicable':'unknown' };
    capabilityDiagnostic(project,actorId,call,'in_progress','execution',readOnly?'not_applicable':'unknown',readOnly?'read_only':'dispatch_entered');
    state.control_calls ??= []; state.control_calls.push(call); assertManagementReceiptRoom(state); saveManagement(project,actorId,state);
    project.store.event(actorId,'management.capability_started',{ receipt_id:receiptId,method,operation,occurrence_id:state.pending_signal.id,grant_id:call.grant_id });
  });
  project.managementControlBusy ??= new Set(); project.managementControlBusy.add(call.receipt_id);
  const job = Promise.resolve().then(async () => {
    let result, failed = false, cycleRejected = false;
    try {
      authorize(project,actorId); // Revocation between persistent admission and the actual job is still authoritative.
      if (operation === 'catalog') result = projectAdministratorCatalog();
      else if (operation !== 'project.call') result = readProjectAdministratorSource(project,copied,operation === 'source.list');
      else if (['notice.answer','notice.dismiss'].includes(params.method)) {
        result = project.store.transaction(() => {
          if (params.params.expected_identity !== undefined) check(project.store.get('SELECT identity FROM notice_sync_records WHERE notice_id=?',params.params.id)?.identity === params.params.expected_identity,'Notice identity changed');
          return settleNoticeAnswer(project,params.params.id,params.params.answer ?? '',params.method === 'notice.dismiss','administrator');
        });
      } else if (params.method === 'system.status') result = project.status(false);
      else result = await invoke(params.method,params.method === 'notice.post' ? { ...params.params,task:actorId } : params.params);
    } catch (error) {
      // Static read-only capabilities cannot produce business writes. For writes,
      // only the fixed method's typed pre-effect graph rejection proves no mutation;
      // matching text/codes (or a different handler) must remain unknown.
      cycleRejected = operation === 'project.call' && params.method === 'worker.merge_after' && error instanceof MergeConditionCycleError;
      failed = !cycleRejected;
      result = { status:readOnly||cycleRejected?'failed':'unknown',effect:readOnly||cycleRejected?'not_started':'unknown',
        original_failure:safeAdministratorValue({ name:error?.name ?? 'Error',message:error?.message ?? 'unclassified failure' }) };
    }
    try {
      state = managementState(project.store.task(actorId)); call = state.control_calls.find(item => item.receipt_id === call.receipt_id);
      const readFailed = failed && readOnly;
      // A read may return a receipt describing somebody else's unknown write.
      // That payload does not make this query itself a write with unknown effects.
      const unknown = !readOnly && (failed || result?.status === 'unknown' || result?.effect === 'unknown');
      call.status = readFailed || cycleRejected ? 'failed' : unknown ? 'unknown' : 'succeeded';
      call.effect = readFailed || cycleRejected ? 'not_started' : readOnly ? 'not_applicable' : unknown ? 'unknown' : 'applied';
      call.finished_at = managementTime(project);
      if (cycleRejected) call.reason = safeManagementDiagnostic({code:'merge_dependency_cycle'}).reason;
      else if (readFailed) call.reason = '只读请求失败，未产生业务写入；保留原始安全失败及收据。';
      else if (unknown) call.reason = '管理员操作未确认完成，保留原始安全失败及收据，不自动重放。';
      capabilityDiagnostic(project,actorId,call,cycleRejected?'merge_dependency_cycle':readFailed?'request_failed':unknown?'execution_failed':'succeeded',readFailed||cycleRejected||unknown?'execution':'completion',call.effect,
        readFailed?'read_only':cycleRejected?'trusted_pre_effect_rejection':unknown?'dispatch_entered':'completion_saved');
      call.result = boundedResult(result,state);
      project.store.transaction(() => {
        saveManagement(project,actorId,state);
        project.store.event(actorId,call.status==='succeeded'?'management.capability_completed':'management.capability_failed',{ receipt_id:call.receipt_id,method:call.method,operation,
          occurrence_id:call.occurrence_id,grant_id:call.grant_id,status:call.status,effect:call.effect,diagnostic:call.diagnostic });
      });
      return view(call);
    } finally { project.managementControlBusy.delete(call.receipt_id); }
  });
  return trackControlJob(project,actorId,job);
}
