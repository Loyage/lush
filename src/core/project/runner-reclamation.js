import { randomUUID } from 'node:crypto';
import { check } from '../types.js';
import { runnerIdentity, RUNNER_BINDING_KEYS } from '../runner-service.js';
import { assertRunnerIdle } from './runner-safety.js';
import { assertions, phaseId } from '../workspaces/remote-transfer.js';
import { hash, stable } from '../../runner/protocol.js';

export function runnerCleanupReceipt(project, workerId) {
  const row = project.store.get("SELECT request_id FROM runner_receipts WHERE worker_id=? AND kind='cleanup' ORDER BY rowid DESC LIMIT 1", workerId);
  return row ? project.store.runnerReceipt(row.request_id) : null;
}

/** Full-batch remote preflight followed by checked reclamation, always outside the central Git gate.
 * Caller owns its ordinary acceptance/archive/deletion admission for the whole duration. No guessed
 * directory ownership, no local fallback, and no unknown mutation is retried with a different ID.
 */
export async function reclaimRunnerWorkspaces(project, tasks, guard = () => {}, { preflight_only = false, allow_unprepared = false } = {}) {
  const plans = [], connections = [];
  try {
    for (const task of tasks) {
      const binding = project.store.runnerBinding(task.id);
      if (!binding) continue;
      const receipt = runnerCleanupReceipt(project, task.id);
      const admission = () => {
        check(!project.taskSyncBusy?.has(task.id), 'Runner synchronization is in flight');
        check(!task.branch || !project.branchFreeze(task.branch), 'Runner branch is frozen');
      };
      const recheck = () => {
        check(!guard()?.then, 'Runner reclamation guard must be synchronous');
        admission();
        const current = assertRunnerIdle(project, task.id, { allow_removed: true, allow_unprepared, allow_receipts: receipt ? [receipt.request_id] : [] });
        check(RUNNER_BINDING_KEYS.every(key => current[key] === binding[key]) && current.head_commit === binding.head_commit,
          'Runner reclamation identity or fixed HEAD changed');
        check(project.store.task(task.id).branch === task.branch && project.store.task(task.id).workspace === null,
          'Runner reclamation branch changed');
      };
      recheck();
      if (binding.state === 'removed') {
        check(receipt?.state === 'removed' && receipt.evidence?.removed === true && receipt.data.head_commit === binding.head_commit,
          'Runner resource removal lacks its exact receipt');
        continue;
      }
      const identity = runnerIdentity(binding, { operation_id: receipt?.operation_id ?? randomUUID() });
      const connection = await project.runners.connect(identity, { observation: true });
      connections.push(connection);
      const options = { client: connection.client, identity, request_id: receipt?.request_id ?? randomUUID(),
        authorization_version: receipt?.authorization_version ?? project.store.runnerProject().authorization_version,
        head_commit: binding.head_commit, agent_exited: true,
        guard: () => {
          connection.assertCurrent();
          // The cleanup receipt becomes a barrier before remote mutation; only its exact owner can continue.
          const own = project.store.runnerReceipt(options.request_id);
          check(!guard()?.then, 'Runner reclamation guard must be synchronous');
          admission();
          const live = assertRunnerIdle(project, task.id, { allow_removed: true, allow_unprepared, allow_receipts: own ? [own.request_id] : [] });
          check(RUNNER_BINDING_KEYS.every(key => live[key] === binding[key]) && live.head_commit === binding.head_commit,
            'Runner reclamation identity or fixed HEAD changed');
          check(project.store.task(task.id).branch === task.branch && project.store.task(task.id).workspace === null, 'Runner reclamation branch changed');
          project.runners.assertBinding(identity, { observation: true });
        } };
      if (binding.state === 'preparing') {
        await project.workspaces.inspectUnpreparedRemoteWorkspace(options);
        plans.push({ options, task, unprepared: true });
        continue;
      }
      // A previous request may have removed the node resources before losing its ACK. Only the
      // fixed request can establish this; never infer it from a missing directory or an offline node.
      const previous = project.store.get("SELECT data FROM events WHERE task_id=? AND type='runner.cleanup_attempt' ORDER BY id DESC LIMIT 1", task.id);
      const attempt = previous ? JSON.parse(previous.data) : null;
      if (attempt?.request_id === options.request_id && attempt.cleanup_attempt) options.cleanup_attempt = attempt.cleanup_attempt;
      let removed = false, retryPartial = false;
      if (receipt) {
        const phase = options.cleanup_attempt ? `cleanup-retry:${options.cleanup_attempt}` : 'cleanup';
        let status;
        try { status = await connection.client.call('request.status', { request_id: phaseId(options.request_id, phase) }); }
        catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
        if (status) {
          check((status.state === 'completed' && !status.error || status.state === 'failed' && status.error
            && !['UNKNOWN', 'INTERNAL'].includes(status.error.code)), 'Runner cleanup request is unknown; preserve its identity and inspect');
          if (!status.error) check(status.result?.request_fingerprint === hash(stable({ method: 'workspace.cleanup',
            identity: connection.client.identity, params: { steps: assertions(task.branch, binding.head_commit, true, true) } })),
          'Runner cleanup request parameters changed');
          removed = !status.error && status.result?.removed === true;
          retryPartial = Boolean(status.error) || status.result?.partial === true && status.result?.removed === false;
          check(removed || retryPartial, 'Runner cleanup request has no confirmed resource outcome');
        }
      }
      if (!removed) {
        const state = await project.workspaces.inspectRemoteWorkspace({ ...options, require_no_lease: true });
        check(state.clean && state.head_commit === binding.head_commit, 'Runner cleanup requires clean fixed HEAD');
        await connection.client.call('workspace.git.inspect', { require_no_lease: true, steps: assertions(task.branch, binding.head_commit, true, true) });
      }
      await project.workspaces.exclusive(async () => {
        check(await project.workspaces.git(project.config.project, 'rev-parse', '--verify', `refs/heads/${task.branch}`) === binding.head_commit,
          'Runner authoritative ref changed before reclamation');
        options.guard();
      });
      plans.push({ options, task, retryPartial });
    }
    if (preflight_only) return { checked: plans.map(plan => plan.task.id) };
    const removed = [];
    for (const plan of plans) {
      plan.options.guard();
      if (plan.retryPartial) plan.options.cleanup_attempt = randomUUID();
      project.store.event(plan.task.id, 'runner.cleanup_attempt', { request_id: plan.options.request_id,
        operation_id: plan.options.identity.operation_id, cleanup_attempt: plan.options.cleanup_attempt ?? null });
      const result = await (plan.unprepared ? project.workspaces.closeUnpreparedRemoteWorkspace(plan.options)
        : project.workspaces.cleanupRemoteWorkspace(plan.options));
      check(result.state === 'removed', 'Runner reclamation incomplete; preserve resources and explicitly retry after inspection');
      removed.push(plan.task.id);
    }
    return { removed };
  } finally { await Promise.allSettled(connections.map(connection => connection.close())); }
}
