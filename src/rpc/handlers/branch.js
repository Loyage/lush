import { check } from '../../core/types.js';

/**
 * 「自己拥有的分支」：agent 只能给自己负责的分支写摘要——
 * 它自己的 ap.branch、它所属输入的锚点分支，以及 verifier 所检验 AP 的分支（它就在那个 worktree 里工作）。
 */
function ownedBranches(p, actor) {
  const owned = new Set();
  const ap = p.store.ap(actor);
  if (ap.branch) owned.add(ap.branch);
  if (ap.input_id !== null) {
    const input = p.store.get('SELECT anchor_branch FROM inputs WHERE id=?', ap.input_id);
    if (input?.anchor_branch) owned.add(input.anchor_branch);
  }
  if (ap.role === 'verifier' && ap.verifies_ap_id !== null) {
    const verified = p.store.ap(ap.verifies_ap_id);
    if (verified?.branch) owned.add(verified.branch);
  }
  return owned;
}

/** 省略 branch 时写哪条：planner 用输入的锚点分支；verifier 用被检验 AP 的分支；其余角色用自己 ap.branch。 */
function ownBranch(p, actor) {
  const ap = p.store.ap(actor);
  if (ap.role === 'planner') {
    const input = ap.input_id === null ? null : p.store.get('SELECT anchor_branch FROM inputs WHERE id=?', ap.input_id);
    return input?.anchor_branch ?? null;
  }
  if (ap.role === 'verifier' && ap.verifies_ap_id !== null) {
    return p.store.ap(ap.verifies_ap_id)?.branch ?? null;
  }
  if (ap.branch) return ap.branch;
  const input = ap.input_id === null ? null : p.store.get('SELECT anchor_branch FROM inputs WHERE id=?', ap.input_id);
  return input?.anchor_branch ?? null;
}

/** branch.* —— 显式记录的分支创建谱系：只读视图 + 用户显式 import（import 会写 store，所以是 USER_ONLY）。 */
export const handlers = {
  'branch.tree'(p, params, actor) { return p.branchTree(); },
  'branch.show'(p, params, actor) { return p.branchShow(params.branch); },
  'branch.import'(p, params, actor) { return p.branchImport(); },
  'branch.bind'(p, params, actor) { return p.bindBranch(params.branch, params.commit); },
  'branch.merge'(p, params, actor) { return p.approveBranchMerge(params.branch); },
  'branch.sync'(p, params, actor) { return p.syncBranch(params.branch); },
  'branch.catchup'(p, params, actor) { return p.catchupBranch(params.branch); },
  // 一键合并：plan 是只读预览（确认对话框用），merge_all 在用户确认后开始，merge_cancel 停止并释放冻结。
  'branch.merge_plan'(p, params, actor) { return p.mergeAllPlan(params.branch); },
  'branch.merge_all'(p, params, actor) { return p.mergeAll(params.branch); },
  'branch.merge_cancel'(p, params, actor) { return p.cancelMergeAll(params.branch); },
  // 合并编排：plan 只读；orchestrate 在用户确认计划一次后派 runtime 驱动的编排 AP；orchestrate_cancel 取消并释放冻结。
  'branch.orchestrate_plan'(p, params, actor) { return p.orchestratePlan(params.branch); },
  'branch.orchestrate'(p, params, actor) { return p.orchestrate(params.branch); },
  'branch.orchestrate_cancel'(p, params, actor) { return p.cancelOrchestrate(params.branch); },
  // 归档会删 worktree 与本地 ref，是用户专属写操作；discard 只在明确要求时才丢弃脏工作区。
  'branch.archive'(p, params, actor) { return p.archiveBranch(params.branch, { discard_worktree: params.discard === true }); },
  /**
   * 一句话摘要（agent 可写的元数据，所以既不在 USER_ONLY 也不在 AGENT_ONLY）：
   * 显式 branch 优先；省略时 agent 写自己的分支，用户（actor=null）必须点名。agent 越权写别人的分支直接报错。
   */
  'branch.summary'(p, params, actor) {
    if (actor === null) {
      check(typeof params.branch === 'string' && params.branch.trim().length > 0,
        'users must name the branch: lush branch summary BRANCH "一句话"');
      return p.setBranchSummary(params.branch, params.summary);
    }
    if (params.branch !== undefined && params.branch !== null) {
      check(ownedBranches(p, actor).has(params.branch),
        `branch ${params.branch} does not belong to AP #${actor}; agents may summarize only their own branch`);
      return p.setBranchSummary(params.branch, params.summary);
    }
    const branch = ownBranch(p, actor);
    check(branch, `AP #${actor} has no branch to summarize; pass an explicit branch`);
    return p.setBranchSummary(branch, params.summary);
  },
};
