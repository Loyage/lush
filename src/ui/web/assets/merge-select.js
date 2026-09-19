/**
 * 批量合并的**选择面**：哪些任务可合并、选中集合按什么顺序合、目标分支被谁冻结。
 * 纯函数，不碰 DOM，也不碰 git；真正的合并是运行时的 Project.approveMergeMany（顺序逻辑在
 * src/core/merge-batch.js）。这里复刻同一套规则，是为了让确认框里预览的顺序与运行时一致，
 * 而不是各写一份互相漂移的判断。
 */

/** 有交付、正在等合并的 integration；merged/superseded 已经没有可合的东西。 */
export const MERGEABLE_INTEGRATION = new Set(['pending', 'review', 'conflict']);

/**
 * 与运行时 approveMerge 同一套冻结规则：别的未解决冲突冻结了同一目标分支。
 * 三种「不算冻结自己」的情况与 Project.approveMerge 完全一致：
 *   冲突就是我自己（重试）；我是它的解冲突任务；它为我这次落地服务。
 */
export function freezeBlocker(targetBranch, task, freeze = []) {
  if (!targetBranch || !task) return null;
  return (freeze || []).find(row => row.target_branch === targetBranch
    && row.task_id !== task.id
    && row.resolves_task_id !== task.id
    && task.resolves_task_id !== row.id) || null;
}

/**
 * 可合并候选：status==='completed' 且 integration ∈ pending/review/conflict。
 * 目标分支、层级与覆盖关系来自 snapshot 的 ladder.nodes；冻结来自 status.merge_freeze。
 * 返回按 id 升序的数组；frozen_by 非空表示这个候选此刻不能合（勾选框禁用并说明是谁冻的）。
 */
export function mergeCandidates(tasks, { nodes = [], freeze = [] } = {}) {
  const byId = new Map((nodes || []).map(node => [node.id, node]));
  return (tasks || [])
    .filter(task => task.status === 'completed' && MERGEABLE_INTEGRATION.has(task.integration))
    .map(task => {
      const node = byId.get(task.id) || {};
      const target = node.target_branch ?? null;
      const blocker = freezeBlocker(target, task, freeze);
      return {
        id: task.id, goal: task.goal, integration: task.integration, target_branch: target,
        level: node.level ?? 0, covered_by: node.covered_by || [],
        frozen_by: blocker ? blocker.task_id : null,
      };
    })
    .sort((a, b) => a.id - b.id);
}

export const isMergeable = candidate => !candidate || candidate.frozen_by === null;

/**
 * 顺序预览：与 src/core/merge-batch.js 的 mergeOrder 同一套规则——只算选中集合内的依赖边，
 * 上游优先，并列按 id 升序（无解时兜底按 id 升序，绝不无限循环）。所以确认框里看到的顺序
 * 就是运行时真正执行的顺序。
 */
export function previewMergeOrder(ids, edges = []) {
  const unique = [...new Set(ids || [])];
  const selected = new Set(unique);
  const upstreams = new Map(unique.map(taskId => [taskId, new Set()]));
  for (const edge of edges || []) {
    if (!selected.has(edge.task_id) || !selected.has(edge.depends_on)) continue;
    upstreams.get(edge.task_id).add(edge.depends_on);
  }
  const order = [];
  const emitted = new Set();
  while (emitted.size < unique.length) {
    const ready = unique
      .filter(taskId => !emitted.has(taskId) && [...upstreams.get(taskId)].every(dep => emitted.has(dep)))
      .sort((a, b) => a - b);
    if (!ready.length) {
      for (const taskId of [...unique].sort((a, b) => a - b)) {
        if (!emitted.has(taskId)) { order.push(taskId); emitted.add(taskId); }
      }
      break;
    }
    order.push(ready[0]);
    emitted.add(ready[0]);
  }
  return order;
}

/** ladder.nodes 的 deps 展成预览要的边列表；kind 只影响说明文案，先后由边本身决定。 */
export function ladderEdges(nodes = []) {
  const edges = [];
  for (const node of nodes || []) {
    for (const dep of node.deps || []) edges.push({ task_id: node.id, depends_on: dep.id, kind: dep.kind });
  }
  return edges;
}
