import { randomUUID } from 'node:crypto';
import { check } from '../types.js';
import { runnerIdentity, RUNNER_BINDING_KEYS } from '../runner-service.js';

/** Durable facts, never a substitute for the node's actual stopped/clean observation. */
export function assertRunnerIdle(project, workerId, { allow_receipts = [], allow_removed = false, allow_unprepared = false } = {}) {
  const binding = project.store.runnerBinding(workerId);
  if (!binding) return null;
  if (allow_unprepared && binding.state === 'preparing') project.store.assertRunnerUnprepared(workerId,
    allow_receipts.find(requestId => project.store.runnerReceipt(requestId)?.data.unprepared) ?? null);
  else check(binding.state === 'ready' || allow_removed && binding.state === 'removed', 'Runner workspace is not confirmed ready');
  check(!project.running.has(workerId) && project.store.task(workerId).status !== 'running'
    && !project.commandHookRunning?.has(workerId), 'Runner Worker invocation or command has not exited');
  const barriers = project.store.runnerBarriers(workerId);
  check(!project.store.pendingRunnerTaskSyncs(workerId).some(sync => !allow_receipts.includes(sync.request_id)),
    'Runner synchronization must settle its fixed receipt first');
  check(!barriers.runs.length, 'Runner Run stop is not confirmed');
  check(!barriers.receipts.some(receipt => !allow_receipts.includes(receipt.request_id)), 'Runner operation has an unresolved receipt');
  return binding;
}

/** Network is deliberately outside Workspaces.exclusive. The returned synchronous guard binds the
 * observation to the same registration/HEAD and rechecks local admission at each later safe point.
 * Remote user processes, like external local Git, cannot be locked by the central queue.
 */
export async function inspectRunnerSafePoint(project, workerId, {
  head_commit, guard = () => {}, observation = false, allow_receipts = [],
} = {}) {
  const binding = assertRunnerIdle(project, workerId, { allow_receipts });
  if (!binding) return { guard, remote: false };
  const task = project.store.task(workerId);
  const identity = runnerIdentity(binding, { operation_id: randomUUID() });
  let connection;
  const recheck = () => {
    connection?.assertCurrent();
    check(!guard()?.then, 'Runner safe-point guard must be synchronous');
    const live = assertRunnerIdle(project, workerId, { allow_receipts });
    check(RUNNER_BINDING_KEYS.every(key => live[key] === binding[key]) && live.revision === binding.revision,
      'Runner registration changed during safe-point inspection');
    const current = project.store.task(workerId);
    check(current.branch === task.branch && current.target_branch === task.target_branch && current.workspace === null,
      'Runner Worker branch registration changed');
    project.runners.assertBinding(identity, { observation });
  };
  recheck();
  connection = await project.runners.connect(identity, { observation });
  try {
    const options = { client: connection.client, identity, guard: recheck, request_id: randomUUID(), require_no_lease: true };
    const state = await project.workspaces.inspectRemoteWorkspace(options);
    check(state.clean && state.head_commit === (head_commit ?? binding.head_commit), 'Runner workspace is dirty or its HEAD differs from the fixed central tip');
    await project.workspaces.exclusive(async () => {
      check(await project.workspaces.git(project.config.project, 'rev-parse', '--verify', `refs/heads/${task.branch}`)
        === (head_commit ?? binding.head_commit), 'Runner authoritative ref changed during safe-point inspection');
      recheck();
    });
    return { ...state, binding, remote: true, guard: recheck };
  } finally { await connection.close(); }
}
