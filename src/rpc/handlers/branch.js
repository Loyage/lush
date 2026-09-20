/** branch.* —— 显式记录的分支创建谱系：只读视图 + 用户显式 import（import 会写 store，所以是 USER_ONLY）。 */
export const handlers = {
  'branch.tree'(p, params, actor) { return p.branchTree(); },
  'branch.show'(p, params, actor) { return p.branchShow(params.branch); },
  'branch.import'(p, params, actor) { return p.branchImport(); },
  'branch.merge'(p, params, actor) { return p.approveBranchMerge(params.branch); },
  'branch.sync'(p, params, actor) { return p.syncBranch(params.branch); },
  // 归档会删 worktree 与本地 ref，是用户专属写操作；discard 只在明确要求时才丢弃脏工作区。
  'branch.archive'(p, params, actor) { return p.archiveBranch(params.branch, { discard_worktree: params.discard === true }); },
};
