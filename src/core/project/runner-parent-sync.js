import { randomUUID } from 'node:crypto';
import { check } from '../types.js';
import { runnerIdentity } from '../runner-service.js';
import { hash, stable } from '../../runner/protocol.js';
import { inspectRunnerSafePoint } from './runner-safety.js';

export function pendingRunnerTaskSync(project, workerId) {
  const pending = project.store.pendingRunnerTaskSyncs(workerId);
  check(pending.length <= 1, 'Runner has multiple unsettled synchronizations; preserve their receipts');
  return pending[0] ?? null;
}

function finish(project, task, outcome, request_id = null) {
  project.store.transaction(() => {
    if (outcome.conflict) project.store.event(task.id, 'task.parent_sync_conflict', { ...outcome, parent_id: task.parent_id });
    else {
      project.store.update(task.id, { head_commit: outcome.head_commit, integration: outcome.integration, integration_error: null,
        iteration_base_commit: outcome.parent_commit,
        status: task.status === 'paused' ? 'paused' : outcome.integration === 'merged' ? 'awaiting_acceptance' : 'waiting' });
      const event = project.store.event(task.id, 'task.parent_synced', { ...outcome, parent_id: task.parent_id });
      if (task.status !== 'awaiting_acceptance') project.notifyAcceptanceEntry(task.id, event);
    }
    if (request_id) project.store.event(task.id, 'task.runner_parent_sync_settled', { request_id });
  });
  return { task: project.store.task(task.id), synced: outcome.synced, conflict: outcome.conflict,
    source_commit: outcome.source_commit, parent_commit: outcome.parent_commit, ...(outcome.reason ? { reason: outcome.reason } : {}) };
}

/** Explicit user sync, under Project's source+parent logical gate, never a network-held Git lock.
 * Persist the candidate before CAS. Re-entry consumes that exact candidate/receipt, not another merge.
 */
export async function syncRunnerTaskParent(project, taskId) {
  const task = project.assertTaskSyncable(taskId);
  let pending = pendingRunnerTaskSync(project, taskId), connection;
  const binding = project.store.runnerBinding(taskId);
  const request_id = pending?.request_id ?? randomUUID();
  const identity = runnerIdentity(binding, { operation_id: request_id });
  const recheck = () => {
    const live = project.assertTaskSyncable(taskId);
    check(['branch', 'target_branch', 'parent_id', 'status', 'reservation'].every(key => live[key] === task[key]), 'Worker changed during remote synchronization');
    connection?.assertCurrent();
    project.runners.assertBinding(identity, { observation: Boolean(pending) });
  };
  recheck();
  const parentProof = await inspectRunnerSafePoint(project, task.parent_id, { guard: recheck });
  const readRef = branch => project.workspaces.git(project.config.project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
  connection = await project.runners.connect(identity, { observation: Boolean(pending) });
  const client = { identity: connection.client.identity, runner_id: connection.client.runner_id,
    call(method, params, options) {
      connection.assertCurrent();
      if (['artifact.upload', 'workspace.git.apply'].includes(method)) project.runners.assertBinding(identity);
      return connection.client.call(method, params, options);
    } };
  try {
    if (!pending) {
      const proof = await inspectRunnerSafePoint(project, taskId, { guard: recheck });
      const outcome = await project.workspaces.exclusive(async () => {
        recheck(); proof.guard(); parentProof.guard();
        const source = await readRef(task.branch), parent = await readRef(task.target_branch);
        const outcome = await project.workspaces.prepareTaskParentSyncUnsafe(task, source, parent, () => {
          recheck(); proof.guard(); parentProof.guard();
        });
        recheck();
        if (!outcome.conflict && outcome.head_commit !== source) project.store.transaction(() => {
          const event_id = project.store.event(taskId, 'task.runner_parent_sync_prepared', { request_id, outcome });
          const data = { old_commit: source, new_commit: outcome.head_commit, attempt_id: event_id };
          project.store.createRunnerReceipt({ ...identity, request_id, authorization_version: project.store.runnerProject().authorization_version,
            kind: 'parent_sync', params_hash: hash(stable(data)), data });
          pending = { request_id, outcome, event_id };
        });
        return outcome;
      });
      if (outcome.conflict) {
        try {
          await project.workspaces.provideRemoteCommit({ client, identity, guard: recheck, request_id,
            head_commit: outcome.source_commit, commit: outcome.parent_commit });
        } catch (error) {
          const current = project.store.runnerBinding(taskId);
          if (current.state === 'ready') project.store.markRunnerWorkspaceUnknown(runnerIdentity(current), current.revision);
          throw error;
        }
      }
      if (!pending) return await project.workspaces.exclusive(async () => {
        recheck(); parentProof.guard();
        check(await readRef(task.branch) === outcome.source_commit && await readRef(task.target_branch) === outcome.parent_commit,
          'source or parent moved during synchronization');
        return finish(project, task, outcome);
      });
    }
    const outcome = pending.outcome;
    let receipt = project.store.runnerReceipt(request_id);
    check(receipt?.kind === 'parent_sync' && receipt.worker_id === taskId && receipt.data.attempt_id === pending.event_id
      && receipt.data.old_commit === outcome.source_commit && receipt.data.new_commit === outcome.head_commit,
    'remote synchronization receipt changed');
    if (receipt.state === 'prepared') {
      const head = await project.workspaces.exclusive(() => readRef(task.branch));
      if (head === outcome.source_commit) {
        const proof = await inspectRunnerSafePoint(project, taskId, { guard: recheck, allow_receipts: [request_id] });
        await project.workspaces.exclusive(() => project.workspaces.applyRemoteTaskParentSyncUnsafe(task,
          outcome.source_commit, outcome.parent_commit, outcome.head_commit, () => {
            recheck(); project.runners.assertBinding(identity); proof.guard(); parentProof.guard();
          }));
      }
      await project.workspaces.exclusive(async () => {
        recheck(); parentProof.guard();
        check(await readRef(task.branch) === outcome.head_commit && await readRef(task.target_branch) === outcome.parent_commit,
          'fixed synchronization source/parent ref changed');
        check(await project.workspaces.isAncestor(project.config.project, outcome.source_commit, outcome.head_commit)
          && await project.workspaces.isAncestor(project.config.project, outcome.parent_commit, outcome.head_commit),
        'synchronization no longer preserves fixed history');
        receipt = project.store.updateRunnerReceipt({ ...identity, request_id }, { state: 'landed',
          evidence: { head_commit: outcome.head_commit, verified: true } }, receipt.revision);
      });
    }
    await project.workspaces.syncRemoteWorkspace({ client, identity, request_id, guard: recheck,
      authorization_version: receipt.authorization_version });
    const observed = await project.workspaces.inspectRemoteWorkspace({ client, identity, guard: recheck,
      request_id, require_no_lease: true });
    check(observed.clean && observed.head_commit === outcome.head_commit, 'remote synchronization was not confirmed');
    return await project.workspaces.exclusive(async () => {
      recheck(); parentProof.guard();
      check(await readRef(task.branch) === outcome.head_commit && await readRef(task.target_branch) === outcome.parent_commit,
        'fixed synchronization source/parent moved before settlement');
      check(project.store.runnerReceipt(request_id).state === 'acknowledged', 'remote synchronization ACK is missing');
      return finish(project, task, outcome, request_id);
    });
  } catch (error) {
    // ACK alone is not the Project settlement. Keep the tiny ACK->event crash/failure window
    // blocked until explicit reconciliation verifies the already-known candidate again.
    if (pending && project.store.runnerReceipt(request_id)?.state === 'acknowledged'
      && pendingRunnerTaskSync(project, taskId)) {
      const current = project.store.runnerBinding(taskId);
      if (current.state === 'ready') project.store.markRunnerWorkspaceUnknown(runnerIdentity(current), current.revision);
    }
    throw error;
  } finally { await connection.close(); }
}

/** Final repair observation may run while the scheduler retains its cleanup slot, but only after
 * the persisted model Run ended and all remote authority was released by invocation cleanup.
 */
export async function inspectRunnerResolution(project, task) {
  const binding = project.store.runnerBinding(task.id);
  if (!binding) return null;
  const identity = runnerIdentity(binding, { operation_id: randomUUID() });
  let connection;
  const guard = () => {
    const barriers = project.store.runnerBarriers(task.id);
    check(!barriers.bindings.length && !barriers.runs.length && !barriers.receipts.length
      && !project.store.get("SELECT id FROM agent_runs WHERE task_id=? AND status='running' LIMIT 1", task.id),
    'Runner repair invocation has not safely ended');
    check(project.store.runnerBinding(task.id).revision === binding.revision && project.store.task(task.id).branch === task.branch,
      'Runner repair binding changed');
    connection?.assertCurrent(); project.runners.assertBinding(identity);
  };
  guard(); connection = await project.runners.connect(identity);
  try {
    const state = await project.workspaces.inspectRemoteWorkspace({ client: connection.client, identity, guard,
      request_id: randomUUID(), require_no_lease: true });
    check(state.clean && state.head_commit === binding.head_commit, 'Runner repair is dirty or has not been received');
    return { ...state, guard };
  } finally { await connection.close(); }
}
