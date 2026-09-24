import { descendantsOf, parentOf } from './genealogy.js';

/**
 * 分支写冻结（merge freeze）的唯一计算处。
 *
 * 冻结不是新的持久化实体，而是从两处已有事实现算出来的：
 * 1. 目标分支上仍 active 的一键合并运行（`branches.merge_run`，见 merge-all.js）——冻结
 *    目标分支连同它的整棵后代子树：运行期间这些分支上的任何写操作都会扰动正在收拢的合并。
 * 2. 尚未结束的 merger 任务（分歧时在子侧建的 sync merger，或冲突收口的 resolver）——按
 *    「被指定处理合并的 branch，其所有子分支和它的父分支都不能变动」冻结那个分支、它的全部
 *    后代、以及它的直接父分支。
 *
 * 返回 Map<branch, info>；info.kind 区分来源，供界面给出可解释的禁用原因。所有查询只读 store。
 */
export function branchFreeze(store) {
  const rows = store.branches().filter(row => row.status === 'active');
  const frozen = new Map();
  const add = (branch, info) => { if (branch && !frozen.has(branch)) frozen.set(branch, info); };

  for (const { target, run } of store.activeBranchMergeRuns()) {
    for (const branch of [target, ...descendantsOf(rows, target)]) {
      add(branch, { kind: 'merge_all', target, run_status: run.status ?? null,
        reason: `一键合并正在收拢 ${target}${run.status === 'paused' ? '（等待子任务）' : ''}` });
    }
  }

  for (const task of store.all(`SELECT id, target_branch FROM tasks
    WHERE role='merger' AND target_branch IS NOT NULL AND status NOT IN ('completed','failed','cancelled') ORDER BY id`)) {
    const branch = task.target_branch;
    const parent = parentOf(rows, branch);
    for (const name of [branch, parent, ...descendantsOf(rows, branch)]) {
      add(name, { kind: 'merger', task_id: task.id, target: branch,
        reason: `合并/解冲突任务 #${task.id} 正在处理 ${branch}` });
    }
  }

  return frozen;
}

/** 决策中经常只需要「这一条分支冻没冻」。 */
export function frozenFor(store, branch) {
  return branchFreeze(store).get(branch) ?? null;
}

/** 只读投影：排序稳定的冻结条目，供 status / graph 读面使用。 */
export function branchFreezeList(store) {
  return [...branchFreeze(store)].map(([branch, info]) => ({ branch, ...info }))
    .sort((a, b) => a.branch.localeCompare(b.branch));
}
