/**
 * 批量合并的**顺序**逻辑，抽成不碰数据库、不碰 git 的纯函数，方便单测。
 *
 * 规则（与 Project.approveMergeMany 的契约一致）：
 * - 只看「本次选中集合内」的依赖边：`task_id` 与 `depends_on` 都在集合里才算数。
 * - `code` 与 `order` 都要求上游先合；`code` 更是硬要求（下游分支以它为基线）。
 * - 没有依赖约束的按 id 升序，所以并列者的位置稳定、可预测。
 * - 集合外的上游不参与排序：它是否已合由 approveMerge 自己的门槛判断，不是这里的职责。
 */
export function mergeOrder(ids, edges = []) {
  const selected = new Set(ids);
  const upstreams = new Map(ids.map(taskId => [taskId, new Set()]));
  for (const edge of edges) {
    if (!selected.has(edge.task_id) || !selected.has(edge.depends_on)) continue;
    upstreams.get(edge.task_id).add(edge.depends_on);
  }
  const order = [];
  const emitted = new Set();
  while (emitted.size < ids.length) {
    // 每一轮取「依赖都已排好」里 id 最小的那个：并列者因此总是按 id 升序出现。
    const ready = ids
      .filter(taskId => !emitted.has(taskId) && [...upstreams.get(taskId)].every(dep => emitted.has(dep)))
      .sort((a, b) => a - b);
    if (!ready.length) {
      // 依赖边由 store 保证无环（spawn 时做 reaches 检查）；这里只兜底，绝不无限循环。
      for (const taskId of [...ids].sort((a, b) => a - b)) {
        if (!emitted.has(taskId)) { order.push(taskId); emitted.add(taskId); }
      }
      break;
    }
    order.push(ready[0]);
    emitted.add(ready[0]);
  }
  return order;
}
