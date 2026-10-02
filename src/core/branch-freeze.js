import { descendantsOf, parentOf } from './genealogy.js';

/**
 * 分支写冻结（merge freeze）的唯一计算处。
 *
 * 冻结不是新的持久化实体，而是从三处已有事实现算出来的：
 * 旧的一键合并运行与 merger 任务只保留磁盘记录，不再参与新代码的冻结与调度。
 * 1. 新式解分歧 Task 固定了两端 tip：活动中以及已完成但未落地时冻结源分支、它的后代和直接父分支；
 *    失败/取消释放，未落地的完成分支要显式归档或成功落地才能释放。
 * 2. queue_protocol=1 的 requested 只冻结源分支普通开发；executing/resolving/blocked 同时持有
 *    父分支逻辑执行位。指定 attempt 的源侧修复由 scheduler 单独准入，兄弟独立分支不受影响。
 *    suspended/withdrawn 明确释放执行位；blocked 的父侧未知现场不释放给下一项。
 *    历史 v1/旧 v2 已固定父基线的请求仍冻结父分支本身，等待受检结算或撤销。
 *    外部 Git 不受 daemon 控制，所以落地仍复核清洁度、固定 refs 并用双 ref 事务。
 *
 * 返回 Map<branch, info>；info.kind 区分来源，供界面给出可解释的禁用原因。所有查询只读 store。
 */
export function branchFreeze(store) {
  const rows = store.branches().filter(row => row.status === 'active');
  const frozen = new Map();
  const add = (branch, info) => { if (branch && !frozen.has(branch)) frozen.set(branch, info); };

  // 新式解分歧 child 不使用 merger 角色。它创建时即在同一事务里写固定两端提交的事件；
  // 完成但尚未落地仍保持冻结，失败/取消释放（失败分支必须检查/归档后才能重派）。
  for (const task of store.all(`SELECT t.id, t.target_branch, t.status, t.integration, t.branch
    FROM tasks t WHERE t.task_kind='child' AND t.target_branch IS NOT NULL
      AND (t.status NOT IN ('completed','failed','cancelled','awaiting_acceptance')
        OR (t.status IN ('completed','awaiting_acceptance') AND t.integration!='merged'))
      AND EXISTS (SELECT 1 FROM events e WHERE e.task_id=t.id AND e.type='task.divergence_resolution_requested')
    ORDER BY t.id`)) {
    if (task.status === 'completed' && (!task.branch || store.branch(task.branch)?.status !== 'active')) continue;
    const branch = task.target_branch;
    for (const name of [branch, parentOf(rows, branch), ...descendantsOf(rows, branch)]) {
      add(name, { kind: 'resolution', task_id: task.id, target: branch,
        reason: `解分歧 Worker #${task.id} 正在固定 ${branch} 与其父分支（完成后须先落地或显式归档）` });
    }
  }

  for (const task of store.all(`SELECT id, branch, target_branch, reservation FROM tasks
    WHERE task_kind IN ('say','child') AND target_branch IS NOT NULL AND reservation IS NOT NULL
    ORDER BY CASE WHEN json_valid(reservation) AND json_extract(reservation,'$.status') IN ('executing','resolving','blocked') THEN 0 ELSE 1 END,id`)) {
    let request = null;
    // 损坏的 reservation 不参与冻结：它自己阻塞不了写，必须保持可检查、可撤销。
    try { request = JSON.parse(task.reservation); } catch { continue; }
    if (!request || request.kind !== 'merge'
      || !(request.status === 'requested' || (request.version === 2 && ['executing','resolving','blocked'].includes(request.status)))) continue;
    if (request.version === 2 && request.queue_protocol === 1) {
      // Queued work freezes only its source. The current attempt owns the parent writer slot.
      const info = { kind: 'delivery', task_id: task.id, commit: request.commit ?? null,
        attempt_id: request.attempt_id ?? null,
        reason: `Worker #${task.id} 的交付由父Worker队列串行处理（${request.status}）` };
      add(task.branch, info);
      if (['executing','resolving','blocked'].includes(request.status)) add(task.target_branch, info);
    } else add(task.target_branch, { kind: 'delivery', task_id: task.id, commit: request.commit ?? null,
      reason: `历史 Worker #${task.id} 的固定提交交付请求尚未结算` });
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
