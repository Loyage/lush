/** One projection for tree, detail and delivery pages. No mutation/permission inference. */
export const DELIVERY_EXCEPTIONS = new Set(['invalid', 'failed', 'blocked', 'awaiting', 'stale']);
export function deliveryStage(value, version = null) {
  if (version === 2 && value === 'resolving') return '合并中 · 源侧分歧修复';
  if (version === 2 && value === 'requested') return '冻结 · 等待合并';
  return ({ pending: '等待合并条件', requested: '等待合并', preparing: '准备合并', resolving: '合并中',
    awaiting: '等待后续事件 / 待决', validating: '旧流程验证中', ready: '工作完成 · 等待合并', landing: '核验落地中 · 尚未合并',
    integrated: '已合并', executing: '合并中 · 尚未完成', suspended: '合并已挂起', blocked: '落地待核查',
    failed: '合并失败', withdrawn: '本次合并已撤回', cancelled: '本次合并已取消', stale: '历史批次已失效', invalid: '预约不可核对' })[value] || `阶段未知${value ? `（${value}）` : ''}`;
}
export function deliveryExceptional(item) {
  if (typeof item.attention === 'boolean') return item.attention;
  if (item.stage === 'integrated') return false;
  return DELIVERY_EXCEPTIONS.has(item.stage) || ['integration_decision','integration_failed','integration_unavailable','missing_batch','invalid_reservation','reservation_truncated'].includes(item.blocked_code)
    || item.integration_workers?.items?.some(worker => worker.current !== false && (worker.missing || worker.identity_mismatch || ['awaiting','paused','failed','cancelled'].includes(worker.status)));
}
export function deliveryHash(locator = {}, history = false) {
  let hash = `#deliveries${history ? '-history' : ''}`;
  if (locator.run_id) hash += `-run-${locator.run_id}${locator.node_id ? `-node-${locator.node_id}` : ''}${locator.worker_id ? `-source-${locator.worker_id}` : ''}`;
  else if (locator.worker_id) hash += `-source-${locator.worker_id}${locator.delivery_id ? `-delivery-${locator.delivery_id}` : ''}`;
  return hash;
}
export function deliveryTarget(hash) {
  const match = /^#deliveries(-history)?(?:-run-([1-9]\d*)(?:-node-([1-9]\d*))?(?:-source-([1-9]\d*))?|-source-([1-9]\d*)(?:-delivery-([1-9]\d*))?)?$/.exec(hash);
  if (!match || match.slice(2).some(value => value && !Number.isSafeInteger(Number(value)))) return null;
  return { history: !!match[1], locator: { run_id: Number(match[2]) || null, node_id: Number(match[3]) || null,
    worker_id: Number(match[4] || match[5]) || null, delivery_id: Number(match[6]) || null } };
}
export function matchesDelivery(item, locator) {
  if (locator.run_id) {
    const sameRun = item.run_id === locator.run_id || item.kind !== 'batch' && item.sources?.some(source => source.delivery_summary?.run_id === locator.run_id);
    return !!sameRun && (!locator.worker_id || item.sources?.some(source => source.id === locator.worker_id));
  }
  if (locator.worker_id) return item.sources?.some(source => source.id === locator.worker_id
    && (!locator.delivery_id || source.delivery_summary?.delivery_id === locator.delivery_id));
  return false;
}
/** Complete server count only: neither stages nor loaded cards can substitute for it. */
export function deliveryAttentionText(counts) {
  return Number.isSafeInteger(counts?.attention) && counts.attention >= 0
    ? `待处理 ${counts.attention}` : '待处理统计未提供';
}
