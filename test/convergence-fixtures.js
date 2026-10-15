import { CONVERGENCE_POLICY_PREFIX } from '../src/core/convergence-contract.js';

/** Persist explicit pre-retirement authorization; never exercise a retired setter. */
export function historicalConvergencePolicy(f, parent, value = {}) {
  const policy = { version: 1, owner_id: parent.id, mounted: true, enabled: true,
    validation: null, generation: 1, ...value };
  f.store.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    CONVERGENCE_POLICY_PREFIX + parent.branch, JSON.stringify(policy));
  return policy;
}

/** Model an already-fixed v3 request, including its original operation receipt.
 * New ordinary requests are intentionally v2; this fixture only tests historical continuation. */
export async function pinHistoricalConvergence(f, taskId, validation = null) {
  const task = f.store.task(taskId), request = JSON.parse(task.reservation);
  if (request.version !== 2 || request.status !== 'requested') throw new Error('historical fixture requires a fixed ordinary request');
  const state = await f.project.workspaces.branchState(task.branch);
  const base = await f.project.workspaces.taskSyncBase(task, request.commit, state.parent_head);
  const fixed = { ...request, version: 3, queue_protocol: 3, base_commit: base,
    convergence_policy_generation: 1, validation,
    ...(validation === null ? { verification_mode: 'agent' } : {}) };
  f.store.update(taskId, { reservation: JSON.stringify(fixed) });
  if (request.handler_operation_id) {
    const event = f.store.get('SELECT data FROM events WHERE id=?', request.handler_operation_id);
    f.store.run('UPDATE events SET data=? WHERE id=?', JSON.stringify({ ...JSON.parse(event.data), strategy: 'converge' }), request.handler_operation_id);
  }
  return fixed;
}
