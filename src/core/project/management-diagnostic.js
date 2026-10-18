import { AsyncLocalStorage } from 'node:async_hooks';
import { managementDiagnostic, safeManagementDiagnostic } from '../management-diagnostic.js';

const context = new AsyncLocalStorage();
export const withManagementAudit = (audit, operation) => context.run(audit, operation);
export const managementAudit = () => context.getStore();
export function managementPhase(stage, effect = 'not_started', evidence = 'trusted_pre_dispatch', code = null) {
  const audit = managementAudit();
  // Nested bridge/authorization validation cannot erase a trusted dispatch boundary.
  if (audit && !(effect === 'not_started' && ['dispatch_entered','read_only'].includes(audit.evidence)))
    Object.assign(audit, { stage, effect, evidence, failure_code: code });
}
export function diagnosticCorrelation(project, taskId, call = null, useAudit = true) {
  const task = project.store.task(taskId), audit = useAudit ? managementAudit() : null;
  const targetId = call?.target_id ?? call?.params?.parent ?? call?.params?.id ?? audit?.target_id;
  const target = Number.isSafeInteger(targetId) && (call?.method?.startsWith('worker.') || ['start','retry'].includes(call?.action) || audit?.target_id === targetId)
    ? project.store.get('SELECT id,worker_number FROM tasks WHERE id=?', targetId) : null;
  return { actor_id: task.id, worker_number: task.worker_number, target_id: target?.id, target_worker_number: target?.worker_number,
    run_id: call?.run_id ?? audit?.run_id ?? (useAudit ? project.running.get(task.id)?.recordId : null),
    occurrence_id: call?.occurrence_id ?? audit?.occurrence_id,
    call_id: call?.call_id ?? audit?.call_id, receipt_id: call?.receipt_id,
    request_event_id: call?.call_id ?? audit?.call_id ?? call?.receipt_id };
}
export function capabilityDiagnostic(project, taskId, call, code, stage, effect, evidence) {
  const previous = capabilityDiagnosticSnapshot(project, project.store.task(taskId), call);
  call.diagnostic = managementDiagnostic(code, stage, effect, evidence, diagnosticCorrelation(project, taskId, call), previous);
  const audit = managementAudit();
  if (audit && audit.call_id === call.call_id) {
    if (call.action) {
      audit.action_receipt_id = call.receipt_id;
      audit.action_diagnostic = call.diagnostic;
      if (!call.capability_receipt_id) audit.receipt_id = call.receipt_id;
    } else {
      audit.receipt_id = call.receipt_id;
      audit.capability_diagnostic = call.diagnostic;
    } // Retain the first error even if saving the receipt itself fails.
  }
  return call.diagnostic;
}
export function projectDiagnostic(project, task, diagnostic) {
  let state; try { state = JSON.parse(task.management); } catch { state = null; }
  const targetId = diagnostic?.correlation?.target_id;
  const target = Number.isSafeInteger(targetId) ? project.store.get('SELECT id,worker_number FROM tasks WHERE id=?', targetId) : null;
  return safeManagementDiagnostic({ ...diagnostic, correlation: { ...diagnostic?.correlation,
    actor_id: task.id, worker_number: task.worker_number, target_id: target?.id ?? null,
    target_worker_number: target?.worker_number ?? null }, disposition: { worker_status: task.status,
    occurrence_status: state?.state, binding_enabled: state?.enabled, emergency: state?.emergency?.status } });
}
export function capabilityDiagnosticSnapshot(project, task, call) {
  if (call.diagnostic && call.diagnostic.code !== 'in_progress') return call.diagnostic;
  // A safe outer Event may be the only surviving record when saving the failed
  // private receipt itself failed. Preserve the first actually sampled error.
  const recorded = project.store.get(`SELECT data FROM events WHERE task_id=? AND id>? AND
    type IN ('management.call_finished','management.capability_failed','management.capability_completed','management.action_failed','management.action_completed')
    AND json_extract(data,'$.receipt_id')=? AND json_type(data,'$.diagnostic.original_failure')='object' ORDER BY id LIMIT 1`,
  task.id, call.receipt_id, call.receipt_id);
  let data; try { data = JSON.parse(recorded?.data); } catch { data = null; }
  return data?.diagnostic ?? call.diagnostic;
}
export function publicCapabilityDiagnostic(project, task, call) {
  const diagnostic = capabilityDiagnosticSnapshot(project, task, call) ?? managementDiagnostic('legacy_unknown', 'legacy', 'unknown', 'legacy_missing',
    diagnosticCorrelation(project, task.id, call, false));
  return projectDiagnostic(project, task, diagnostic);
}
