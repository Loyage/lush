import { convergenceJSON } from './convergence-contract.js';

/** Runtime-only identity: one immutable creation event, never inferred from a name or ancestry. */
export function convergenceHelperContext(store, task) {
  if (task?.task_kind !== 'integration') return null;
  const row = store.get(`SELECT data FROM events WHERE task_id=? AND type='convergence.integration_created' ORDER BY id LIMIT 1`, task.id);
  const context = convergenceJSON(row?.data);
  return context && Number.isSafeInteger(context.run_id) && Number.isSafeInteger(context.node_id)
    && Number.isSafeInteger(context.generation) ? context : null;
}

/** Resource safety is not the same as publication eligibility or user acceptance. */
export function convergenceResourceReason(project, task) {
  const context = convergenceHelperContext(project.store, task);
  if (task.task_kind === 'integration' && !context) return '整合身份缺少固定归并记录；保留现场供检查。';
  if (!project.store.deliveryRun) return context ? '归并记录不可检查；保留整合现场。' : null;
  const booking = convergenceJSON(task.reservation);
  const runId = context?.run_id ?? (booking?.version === 3 ? booking.run_id : null);
  if (!runId) return null;
  const run = project.store.deliveryRun(runId);
  if (!run) return '固定归并记录缺失；不能丢弃来源或辅助资源。';
  if (project.convergenceJobs?.has(run.id)) return '归并准备或验证仍在实际退出。';
  if (run.state === 'landing' || (run.state === 'blocked' && run.landing_receipt)) return '父侧发布结果待核验；保留精确来源资源。';
  if (context && !['integrated', 'withdrawn', 'stale'].includes(run.state)) return '固定归并仍引用整合产物；先处理来源交付。';
  if (context && project.store.deliveryMembers(run.id, true).length) return '归并仍有有效成员；不能提前回收整合产物。';
  if (project.running.has(task.id)) return '整合调用尚未实际退出。';
  return null;
}

/** Exact internal-output mapping for acceptance, not a member Squash receipt. */
export async function convergenceHelperDeliveryState(project, task) {
  if (convergenceResourceReason(project, task) || !project.workspaces.convergenceHelperState) return 'pending';
  return project.workspaces.convergenceHelperState(task);
}
