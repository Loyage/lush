import { check } from '../types.js';
import { runnerIdentity } from '../runner-service.js';
import { hash, stable } from '../../runner/protocol.js';
import { assertRunnerIdle, inspectRunnerSafePoint } from './runner-safety.js';

export const runnerParentSyncId = (taskId, attemptId) => hash(stable(['delivery-parent-sync', taskId, attemptId]));

/** Called under the short central Git lock, before its first parent mutation. */
export function prepareRunnerParentSync(project, task, request, parent, landing) {
  const binding = assertRunnerIdle(project, parent.id);
  if (!binding) return null;
  const request_id = runnerParentSyncId(task.id, request.attempt_id);
  const data = { old_commit: landing.baseline, new_commit: landing.commit, attempt_id: request.attempt_id };
  return project.store.createRunnerReceipt({ ...runnerIdentity(binding, { operation_id: request_id }), request_id,
    authorization_version: project.store.runnerProject().authorization_version,
    kind: 'parent_sync', params_hash: hash(stable(data)), data });
}

/** Explicit requeue only. Observe both remote endpoints outside the Git lock, then let the
 * caller prove the exact central baseline is still unwritten inside its short ref gate.
 */
export async function inspectRunnerUnwrittenLanding(project, task, request) {
  const receipt = project.store.runnerReceipt(runnerParentSyncId(task.id, request.attempt_id));
  if (!receipt || receipt.state !== 'prepared') return null;
  if (await project.workspaces.exclusive(() => project.workspaces.verifyTaskSquashUnsafe(request.landing_receipt))) return null;
  const guard = () => {
    project.assertTaskMergeAttempt(task.id, request.attempt_id, true);
    const current = project.store.runnerReceipt(receipt.request_id);
    check(current?.state === 'prepared' && current.revision === receipt.revision,
      'Runner synchronization changed during unwritten inspection');
  };
  const source = await inspectRunnerSafePoint(project, task.id, { head_commit: request.commit, guard });
  const parent = await inspectRunnerSafePoint(project, request.parent_id, { head_commit: request.baseline, guard,
    allow_receipts: [receipt.request_id] });
  check(parent.remote && receipt.worker_id === request.parent_id && receipt.data.old_commit === request.baseline
    && receipt.data.new_commit === request.landing_receipt.commit && receipt.data.attempt_id === request.attempt_id,
  'Runner unwritten synchronization identity changed');
  return { receipt, guard: () => { guard(); source.guard(); parent.guard(); } };
}

export function rejectRunnerUnwrittenLanding(project, proof) {
  proof.guard();
  const { receipt } = proof;
  return project.store.updateRunnerReceipt({ ...runnerIdentity(receipt, { operation_id: receipt.operation_id }),
    request_id: receipt.request_id }, { state: 'rejected', evidence: { head_commit: receipt.data.old_commit,
    verified: true, clean: true, stopped: true } }, receipt.revision);
}

/** Exact landing proof can advance this receipt; neither a status message nor a matching tree can. */
export function recordRunnerParentLanding(project, task, request) {
  if (!project.store.runnerBinding(request.parent_id)) return;
  const request_id = runnerParentSyncId(task.id, request.attempt_id);
  const receipt = project.store.runnerReceipt(request_id);
  check(receipt && receipt.kind === 'parent_sync' && receipt.worker_id === request.parent_id
    && receipt.data.attempt_id === request.attempt_id && receipt.data.old_commit === request.baseline
    && receipt.data.new_commit === request.landing_receipt.commit, 'Runner parent synchronization receipt changed');
  if (receipt.state === 'prepared') project.store.updateRunnerReceipt({ ...runnerIdentity(receipt,
    { operation_id: receipt.operation_id }), request_id }, { state: 'landed',
    evidence: { head_commit: request.landing_receipt.commit, verified: true } }, receipt.revision);
}

/** Outside all Git/SQLite locks. Reconnect only to the fixed operation, never redo the Squash. */
export async function synchronizeRunnerParent(project, taskId, attemptId) {
  const { task, request, parent } = project.assertTaskMergeAttempt(taskId, attemptId, true);
  const binding = project.store.runnerBinding(parent.id);
  if (!binding) return;
  const request_id = runnerParentSyncId(task.id, attemptId), receipt = project.store.runnerReceipt(request_id);
  check(receipt?.kind === 'parent_sync' && receipt.data.new_commit === request.landing_receipt.commit,
    'Runner synchronization lacks the exact central landing');
  const identity = runnerIdentity(receipt, { operation_id: receipt.operation_id });
  let connection;
  const guard = () => {
    connection?.assertCurrent();
    project.assertTaskMergeAttempt(taskId, attemptId, true);
    assertRunnerIdle(project, parent.id, { allow_receipts: [request_id] });
    project.runners.assertBinding(identity, { observation: true });
  };
  guard();
  connection = await project.runners.connect(identity, { observation: true });
  try {
    // Revocation preserves exact read/ACK reconciliation, not fresh network mutations from a queued sync.
    const client = { identity: connection.client.identity, runner_id: connection.client.runner_id,
      call(method, params, options) {
        connection.assertCurrent();
        if (['artifact.upload', 'workspace.git.apply'].includes(method)) project.runners.assertBinding(identity);
        return connection.client.call(method, params, options);
      } };
    await project.workspaces.syncRemoteWorkspace({ client, identity, request_id, guard,
      authorization_version: receipt.authorization_version });
    const observed = await project.workspaces.inspectRemoteWorkspace({ client: connection.client, identity, guard,
      request_id, require_no_lease: true });
    check(observed.clean && observed.head_commit === receipt.data.new_commit,
      'Runner acknowledged parent changed before delivery finalization');
  } finally { await connection.close(); }
}

export function assertRunnerDeliveryAcknowledged(project, task, request, parent, landedCommit) {
  const source = assertRunnerIdle(project, task.id);
  if (source) check(source.head_commit === request.commit, 'Runner source receipt no longer matches delivery');
  const binding = assertRunnerIdle(project, parent.id);
  if (!binding) return;
  check(binding.head_commit === landedCommit, 'Runner parent has not acknowledged the landed commit');
  if (request.landing_receipt) {
    const receipt = project.store.runnerReceipt(runnerParentSyncId(task.id, request.attempt_id));
    check(receipt?.state === 'acknowledged' && receipt.data.old_commit === request.baseline
      && receipt.data.new_commit === landedCommit && receipt.data.attempt_id === request.attempt_id,
    'Runner parent synchronization has not been acknowledged');
  }
}

export async function provideRunnerRepair(project, task, request) {
  const binding = assertRunnerIdle(project, task.id);
  if (!binding) return;
  const request_id = hash(stable(['delivery-repair-objects', task.id, request.attempt_id]));
  const identity = runnerIdentity(binding, { operation_id: request_id });
  const guard = () => {
    connection.assertCurrent();
    project.assertTaskMergeAttempt(task.id, request.attempt_id, true);
    assertRunnerIdle(project, task.id);
    project.runners.assertBinding(identity);
  };
  const connection = await project.runners.connect(identity);
  try {
    await project.workspaces.provideRemoteCommit({ client: connection.client, identity, guard, request_id,
      head_commit: request.commit, commit: request.baseline });
  } catch (error) {
    // An interrupted object import may leave an unknown node writer even though HEAD did not move.
    const live = project.store.runnerBinding(task.id);
    if (live.state === 'ready') project.store.markRunnerWorkspaceUnknown(runnerIdentity(live), live.revision);
    throw error;
  } finally { await connection.close(); }
}
