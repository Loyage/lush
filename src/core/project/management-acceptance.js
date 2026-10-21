import { check } from '../types.js';
import { hookRevision } from '../hooks.js';
import { managementState, saveManagement, managementAcceptanceFacts, managementAcceptanceReason } from './management-data.js';

/** User-only, non-Git acceptance. The Git queue also orders cleanup/deletion of private resources. */
export async function acceptManagementWorker(project, taskId, actor, options) {
  check(actor === null && !options.completion && options.managementReceipt === undefined,
    'only the user may accept a Valet; agents and Valets cannot accept management identities');
  check(options.force !== true, 'force acceptance does not apply to Valet');
  const inspect = () => {
    project.assertWritable('accept a Valet');
    const task = project.store.task(taskId), state = managementState(task);
    const reason = managementAcceptanceReason(project, task, state);
    check(!reason, reason);
    const facts = managementAcceptanceFacts(project.store, task);
    check(!facts.acceptance_blocked, 'Valet acceptance receipt is incomplete; inspect persistent records before recovery');
    return { task, state, facts };
  };
  inspect();
  return project.workspaces.exclusive(() => {
    const { task, state, facts } = inspect();
    if (facts.accepted) return project.inspect(taskId);
    const resource = project.workspaces.managementAcceptanceResource(task);
    let attempt = null;
    if (facts.acceptance_recovery) {
      const event = project.store.get("SELECT id,data FROM events WHERE task_id=? AND type='task.acceptance_started' ORDER BY id DESC LIMIT 1", taskId);
      attempt = { ...JSON.parse(event.data), id: event.id };
      check(attempt.task_id === taskId && attempt.kind === 'management' && !state.enabled
        && attempt.occurrence_id === state.last_execution.id, 'Valet acceptance recovery identity changed');
      check(JSON.stringify(attempt.resource) === JSON.stringify(resource),
        'management resource changed or is missing without an exact reclamation receipt; inspect before recovery');
    }
    const endsBinding = !attempt && state.enabled && Boolean(state.signal_id);
    const signal = state.signal_id ? project.hookSignals().items.find(item => item.id === state.signal_id) ?? null : null;
    const revision = hookRevision({ task, resource, signal });
    if (options.forcePreview) return { version: 1, kind: 'management', id: taskId, revision,
      can_accept: true, requires_confirmation: endsBinding, ends_future_binding: endsBinding,
      signal_id: endsBinding ? state.signal_id : null,
      resources: { management_workspace: resource.present ? resource.path : null },
      history_preserved: true, managed_workers_unchanged: true };
    if (endsBinding) check(options.confirm === true && options.revision === revision,
      'Valet future binding requires a current acceptance preview and explicit confirmation; queued or in-flight work cannot be cancelled by acceptance');
    else if (options.revision !== undefined) check(options.confirm === true && options.revision === revision,
      'Valet acceptance revision changed; preview and confirm again');
    project.acceptanceBusy ??= new Set();
    project.acceptanceBusy.add(taskId);
    try {
      if (!attempt) project.store.transaction(() => {
        const execution = project.store.event(taskId, 'task.acceptance_started', {
          kind: 'management', task_id: taskId, occurrence_id: state.last_execution.id, resource,
          ends_future_binding: endsBinding, signal_id: endsBinding ? state.signal_id : null,
          confirmed_revision: endsBinding ? revision : null,
        });
        attempt = { id: execution, resource };
        // Only an untriggered future binding is revoked. No occurrence, message, Notice or receipt is cancelled.
        state.enabled = false; state.config_revision += 1;
        saveManagement(project, taskId, state);
      });
      // Synchronous no-follow/empty-directory recheck and rmdir: no Agent/input can enter between guard and removal.
      const current = project.store.task(taskId);
      const reason = managementAcceptanceReason(project, current, managementState(current), { busy: true });
      check(!reason, reason);
      project.workspaces.managementAcceptanceResource(current, attempt.resource, true);
      project.store.transaction(() => {
        project.store.update(taskId, { workspace: null, status: 'completed' });
        project.store.event(taskId, 'task.accepted', { kind: 'management', acceptance_execution: attempt.id,
          accepted_by: 'user', resources_reclaimed: true, history_preserved: true, managed_workers_unchanged: true });
      });
    } catch (error) {
      project.store.event(taskId, 'task.acceptance_failed', { kind: 'management', acceptance_execution: attempt?.id ?? null,
        reason: 'Valet resource reclamation incomplete; inspect the fixed receipt and explicitly retry worker.accept. Unknown or changed resources are never guessed reclaimed.' });
      throw error;
    } finally { project.acceptanceBusy.delete(taskId); }
    project.armScheduledHookTimer();
    return project.inspect(taskId);
  });
}
