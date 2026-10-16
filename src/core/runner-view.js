/** Secret-free durable location facts. This does not contact a node, read credentials, or claim
 * that the Runner is online. No binding means the original local Worker behavior, not migration.
 */
export function runnerWorkerView(store, workerId) {
  if (!Number.isSafeInteger(workerId) || workerId <= 0) return null; // progress-only fragments have no Worker identity
  const binding = store.runnerBinding(workerId);
  if (!binding) return null;
  const barriers = store.runnerBarriers(workerId);
  return { node_id: binding.node_id, runner_id: binding.runner_id, workspace_id: binding.workspace_id,
    generation: binding.generation, revision: binding.revision, state: binding.state, head_commit: binding.head_commit,
    authorized: store.runnerProject().allowed_node_ids.includes(binding.node_id),
    barriers: Object.fromEntries(Object.entries(barriers).filter(([, rows]) => Array.isArray(rows)).map(([kind, rows]) => [kind, rows.length])) };
}
