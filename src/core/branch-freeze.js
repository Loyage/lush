import { descendantsOf, parentOf } from './genealogy.js';

/**
 * 分支写冻结（merge freeze）的唯一计算处。
 *
 * 冻结不是新的持久化实体，而是从三处已有事实现算出来的：
 * 1. 目标分支上仍 active 的一键合并运行（`branches.merge_run`，见 merge-all.js）——冻结
 *    目标分支连同它的整棵后代子树：运行期间这些分支上的任何写操作都会扰动正在收拢的合并。
 * 2. 尚未结束的 merger 任务（分歧时在子侧建的 sync merger，或冲突收口的 resolver）——按
 *    「被指定处理合并的 branch，其所有子分支和它的父分支都不能变动」冻结那个分支、它的全部
 *    后代、以及它的直接父分支。
 * 3. 已发出但尚未集成的 say 合并请求（`tasks.reservation` 里 kind=merge、status=requested）——请求已经
 *    把父分支基线固定成那个 commit；父分支再前进（另一个子任务落地、用户批准别的请求、外部 git）
 *    就会让固定提交不再能快进，请求只能重做。所以只冻结**父分支本身**：请求者的分支已终态，
 *    兄弟 say 自己的分支仍要能继续工作。解除只有两条路——集成这个请求，或用户明确撤销它；
 *    daemon 挡不住父分支自己的 say Agent 提交，那种情况会在集成时如实报成 parent_moved。
 *
 * 返回 Map<branch, info>；info.kind 区分来源，供界面给出可解释的禁用原因。所有查询只读 store。
 */
export function branchFreeze(store) {
  const rows = store.branches().filter(row => row.status === 'active');
  const frozen = new Map();
  const add = (branch, info) => { if (branch && !frozen.has(branch)) frozen.set(branch, info); };

  for (const { target, run } of store.activeBranchMergeRuns()) {
    const label = run.mode === 'orchestrate' ? '合并编排' : '一键合并';
    for (const branch of [target, ...descendantsOf(rows, target)]) {
      add(branch, { kind: 'merge_all', target, run_status: run.status ?? null, run_mode: run.mode ?? null,
        reason: `${label}正在收拢 ${target}${run.status === 'paused' ? '（等待子任务）' : ''}` });
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

  for (const task of store.all(`SELECT id, target_branch, reservation FROM tasks
    WHERE task_kind='say' AND target_branch IS NOT NULL AND reservation IS NOT NULL ORDER BY id`)) {
    let request = null;
    // 损坏的 reservation 不参与冻结：它自己阻塞不了写，必须保持可检查、可撤销。
    try { request = JSON.parse(task.reservation); } catch { continue; }
    if (!request || request.kind !== 'merge' || request.status !== 'requested') continue;
    add(task.target_branch, { kind: 'delivery', task_id: task.id, commit: request.commit ?? null,
      reason: `say #${task.id} 的合并请求 ${String(request.commit ?? '').slice(0, 12)} 已固定基线，等待集成或撤销` });
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
