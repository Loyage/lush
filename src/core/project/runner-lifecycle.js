import { randomUUID } from 'node:crypto';
import { check } from '../types.js';
import { runnerIdentity, RUNNER_BINDING_KEYS } from '../runner-service.js';
import { pendingRunnerTaskSync } from './runner-parent-sync.js';

export function runnerPendingCount(project) {
  const barriers = project.store.runnerBarriers();
  return barriers.bindings.length + barriers.runs.length + barriers.receipts.length
    + (project._runners?.pending ?? 0) + (project.runnerStopJobs?.size ?? 0);
}

/** Cancellation remains synchronous for existing callers; real stop is independently tracked. */
export function requestRunnerStop(project, workerId) {
  if (!project.store.runnerBinding(workerId)) return null;
  const job = project.runners.stopWorker(workerId).catch(() => ({ stopped: false, unknown: true }));
  (project.runnerStopJobs ??= new Set()).add(job);
  void job.finally(() => { project.runnerStopJobs.delete(job); });
  return job;
}

/** Restart cannot infer process exit from an absent running Map or a closed agent_runs row. */
export function recordRunnerRecovery(project) {
  for (const pending of project.store.pendingRunnerTaskSyncs()) {
    if (project.store.runnerReceipt(pending.request_id)?.state !== 'acknowledged') continue;
    const binding = project.store.runnerBinding(pending.worker_id);
    if (binding?.state === 'ready') project.store.markRunnerWorkspaceUnknown(runnerIdentity(binding), binding.revision);
  }
  for (const run of project.store.runnerBarriers().runs) {
    project.store.revokeRunnerRun(run.run_id);
    const binding = project.store.runnerBinding(run.worker_id);
    if (binding.state !== 'unknown' && binding.state !== 'removed')
      project.store.markRunnerWorkspaceUnknown(runnerIdentity(binding), binding.revision);
  }
}

/** Explicit retry/reconciliation only: stop old authority, prove the original registration and
 * known HEAD, then clear a workspace unknown. Never settle an unknown tool/object receipt here.
 * A ready dirty worktree may be continued, exactly as local retry; unknown dirty state is blocked.
 */
export async function reconcileRunnerWorker(project, workerId, { sync_request_id = null } = {}) {
  check(!project.running.has(workerId) && !project.commandHookRunning?.has(workerId), 'Runner invocation is still stopping');
  let binding = project.store.runnerBinding(workerId);
  if (!binding) return null;
  const checkSettlement = () => {
    const pending = pendingRunnerTaskSync(project, workerId);
    if (sync_request_id === null) check(!pending, 'Runner synchronization must settle its fixed receipt first');
    else {
      const task = project.store.task(workerId), receipt = project.store.runnerReceipt(sync_request_id);
      check(project.taskSyncBusy?.has(workerId) && project.taskSyncBusy.has(task.parent_id)
        && pending?.request_id === sync_request_id && receipt?.worker_id === workerId
        && receipt.kind === 'parent_sync' && receipt.state === 'acknowledged'
        && receipt.data.attempt_id === pending.event_id && receipt.data.new_commit === pending.outcome.head_commit,
      'Runner synchronization reconciliation requires its logical gate and exact acknowledged candidate');
    }
  };
  const unresolved = barriers => barriers.runs.length || barriers.receipts.some(receipt => receipt.request_id !== sync_request_id);
  checkSettlement();
  const result = await project.runners.stopWorker(workerId);
  check(result.stopped, 'Runner stop is not confirmed; preserve its workspace');
  binding = project.store.runnerBinding(workerId);
  const barriers = project.store.runnerBarriers(workerId);
  checkSettlement();
  check(!unresolved(barriers), 'Runner operations remain unknown; reconcile their exact receipts first');
  check(['ready', 'unknown'].includes(binding.state), 'Runner workspace preparation or removal is unresolved');
  const identity = runnerIdentity(binding, { operation_id: randomUUID() });
  const task = project.store.task(workerId);
  const guard = () => {
    checkSettlement();
    const live = project.store.runnerBinding(workerId), state = project.store.runnerBarriers(workerId);
    check(live.revision === binding.revision && RUNNER_BINDING_KEYS.every(key => live[key] === binding[key])
      && !project.running.has(workerId) && !project.commandHookRunning?.has(workerId)
      && !unresolved(state), 'Runner changed during explicit stop reconciliation');
    check(project.store.task(workerId).branch === task.branch, 'Runner branch changed');
    project.runners.assertBinding(identity, { observation: true });
  };
  guard();
  const connection = await project.runners.connect(identity, { observation: true });
  try {
    const observed = await project.workspaces.inspectRemoteWorkspace({ client: connection.client, identity,
      request_id: randomUUID(), require_no_lease: true, guard });
    check(observed.head_commit === binding.head_commit && (binding.state !== 'unknown' || observed.clean),
      'Runner unknown HEAD or dirty state requires explicit inspection; no reset or replay');
    await project.workspaces.exclusive(async () => {
      check(await project.workspaces.git(project.config.project, 'rev-parse', '--verify', `refs/heads/${task.branch}`)
        === binding.head_commit, 'Runner authoritative ref drifted during stop reconciliation');
      guard();
      if (binding.state === 'unknown') project.store.confirmRunnerWorkspace(runnerIdentity(binding), binding.head_commit,
        binding.revision, { sync_request_id });
    });
    return observed;
  } finally { await connection.close(); }
}
