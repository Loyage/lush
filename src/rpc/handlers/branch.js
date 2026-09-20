/** branch.* —— 显式记录的分支创建谱系：只读视图 + 用户显式 import（import 会写 store，所以是 USER_ONLY）。 */
export const handlers = {
  'branch.tree'(p, params, actor) { return p.branchTree(); },
  'branch.show'(p, params, actor) { return p.branchShow(params.branch); },
  'branch.import'(p, params, actor) { return p.branchImport(); },
  'branch.merge'(p, params, actor) { return p.approveBranchMerge(params.branch); },
  'branch.sync'(p, params, actor) { return p.syncBranch(params.branch); },
};
