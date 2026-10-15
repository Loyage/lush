import { check, isPlainObject } from '../../core/types.js';
import { workerLabel } from '../../core/worker-number.js';
import { automationScope } from '../../core/automation-scopes.js';

/**
 * 「自己拥有的分支」：agent 只能给自己负责的分支写摘要——
 * 它自己的 task.branch、它所属输入的锚点分支，以及 verifier 所检验任务的分支（它就在那个 worktree 里工作）。
 */
function ownedBranches(p, actor) {
  const owned = new Set();
  const task = p.store.task(actor);
  if (task.branch) owned.add(task.branch);
  if (task.input_id !== null) {
    const input = p.store.get('SELECT anchor_branch FROM inputs WHERE id=?', task.input_id);
    if (input?.anchor_branch) owned.add(input.anchor_branch);
  }
  if (task.role === 'verifier' && task.verifies_task_id !== null) {
    const verified = p.store.task(task.verifies_task_id);
    if (verified?.branch) owned.add(verified.branch);
  }
  return owned;
}

/** 省略 branch 时写哪条：planner 用输入的锚点分支；verifier 用被检验任务的分支；其余角色用自己 task.branch。 */
function ownBranch(p, actor) {
  const task = p.store.task(actor);
  if (task.role === 'planner') {
    const input = task.input_id === null ? null : p.store.get('SELECT anchor_branch FROM inputs WHERE id=?', task.input_id);
    return input?.anchor_branch ?? null;
  }
  if (task.role === 'verifier' && task.verifies_task_id !== null) {
    return p.store.task(task.verifies_task_id)?.branch ?? null;
  }
  if (task.branch) return task.branch;
  const input = task.input_id === null ? null : p.store.get('SELECT anchor_branch FROM inputs WHERE id=?', task.input_id);
  return input?.anchor_branch ?? null;
}

function convergenceBranch(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim()
    && !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{')
    && !value.includes('//') && !value.startsWith('/') && !value.startsWith('-') && !value.startsWith('refs/')
    && !value.endsWith('/') && !value.endsWith('.') && value !== '@'
    && !/^[0-9a-f]{40,64}$/i.test(value)
    && value.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock')),
  'branch must be an exact local branch name, not a ref expression');
  return value;
}
function convergenceRevision(value, kind = 'convergence') {
  check(typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value),
  `expected_revision must be a valid ${kind} read revision`);
  return value;
}
function convergenceInteger(value, name, max = Number.MAX_SAFE_INTEGER) {
  check(Number.isSafeInteger(value) && value > 0 && value <= max, `${name} must be a positive integer${max === 50 ? ' up to 50' : ''}`);
  return value;
}
function convergenceValidation(value) {
  if (value === undefined || value === null) return value;
  check(isPlainObject(value), 'validation must be null or a command reference');
  check(Object.keys(value).every(key => ['command_id','command_version'].includes(key)),
    'validation accepts only command_id and command_version');
  check(typeof value.command_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.command_id),
    'invalid validation command id');
  if (value.command_version !== undefined) convergenceInteger(value.command_version, 'command_version');
  return { command_id: value.command_id };
}

/** branch.*：谱系/历史只读；绑定、归档及归并策略遵守各自用户权限，不提供通用 ref 写入口。 */
export const handlers = {
  'branch.history'(p, params, actor) { return p.branchHistory(params); },
  'branch.version_graph'(p, params, actor) { return p.branchVersionGraph(params); },
  'branch.tree'(p, params, actor) { return p.branchTree(); },
  'branch.show'(p, params, actor) { return p.branchShow(params.branch); },
  'branch.integrate_plan'(p, params) { return p.branchIntegratePlan(convergenceBranch(params.branch)); },
  'branch.integrate_start'(p, params) {
    return p.branchIntegrateStart(convergenceBranch(params.branch), convergenceRevision(params.expected_revision, 'integration'));
  },
  'branch.integration'(p, params) { return p.branchIntegration(convergenceInteger(params.id, 'id')); },
  'branch.integrate_cancel'(p, params) {
    return p.branchIntegrateCancel(convergenceInteger(params.id, 'id'), convergenceRevision(params.expected_revision, 'integration'));
  },
  'branch.integrate_retry'(p, params) {
    return p.branchIntegrateRetry(convergenceInteger(params.id, 'id'), convergenceRevision(params.expected_revision, 'integration'));
  },
  'branch.convergence'(p, params) { return p.branchConvergence(convergenceBranch(params.branch)); },
  'branch.convergence_list'(p) { return p.branchConvergenceList(); },
  'branch.convergence_set'(p, params) {
    const branch = convergenceBranch(params.branch), expected = convergenceRevision(params.expected_revision);
    check(typeof params.enabled === 'boolean', 'enabled must be a boolean');
    const validation = convergenceValidation(params.validation), mounted = params.mounted === undefined ? true : params.mounted;
    check(typeof mounted === 'boolean', 'mounted must be a boolean');
    check(mounted || !params.enabled, 'enabled convergence must be mounted');
    return p.setBranchConvergence(branch, params.enabled, validation, expected, mounted);
  },
  'branch.convergence_defaults'(p) { return p.branchConvergenceDefaults(); },
  'branch.convergence_defaults_set'(p, params) {
    check(typeof params.mounted === 'boolean', 'mounted must be a boolean');
    check(typeof params.enabled === 'boolean', 'enabled must be a boolean');
    if (params.scope !== undefined) {
      automationScope(params.scope);
      check(params.mounted === (params.scope !== 'none'), 'convergence mounted must match scope');
      return p.setBranchConvergenceDefaults(params.mounted, params.enabled, convergenceRevision(params.expected_revision), params.scope);
    }
    return p.setBranchConvergenceDefaults(params.mounted, params.enabled, convergenceRevision(params.expected_revision));
  },
  'branch.convergence_runs'(p, params) {
    const branch = convergenceBranch(params.branch);
    const before = params.before === undefined || params.before === null ? null : convergenceInteger(params.before, 'before');
    const limit = params.limit === undefined ? 20 : convergenceInteger(params.limit, 'limit', 50);
    return p.branchConvergenceRuns(branch, before, limit);
  },
  'branch.convergence_retry'(p, params) {
    return p.retryBranchConvergence(convergenceInteger(params.id, 'id'), convergenceRevision(params.expected_revision));
  },
  'branch.import'(p, params, actor) { return p.branchImport(); },
  'branch.bind'(p, params, actor) { return p.bindBranch(params.branch, params.commit); },
  'branch.merge'(p, params, actor) { return p.approveBranchMerge(params.branch); },
  'branch.sync'(p, params, actor) { return p.syncBranch(params.branch); },
  'branch.catchup'(p, params, actor) { return p.catchupBranch(params.branch); },
  // 一键合并：plan 是只读预览（确认对话框用），merge_all 在用户确认后开始，merge_cancel 停止并释放冻结。
  'branch.merge_plan'(p, params, actor) { return p.mergeAllPlan(params.branch); },
  'branch.merge_all'(p, params, actor) { return p.mergeAll(params.branch); },
  'branch.merge_cancel'(p, params, actor) { return p.cancelMergeAll(params.branch); },
  // 合并编排：plan 只读；orchestrate 在用户确认计划一次后派 runtime 驱动的编排 Task；orchestrate_cancel 取消并释放冻结。
  'branch.orchestrate_plan'(p, params, actor) { return p.orchestratePlan(params.branch); },
  'branch.orchestrate'(p, params, actor) { return p.orchestrate(params.branch); },
  'branch.orchestrate_cancel'(p, params, actor) { return p.cancelOrchestrate(params.branch); },
  // 归档会删 worktree 与本地 ref，是用户专属写操作；discard 只在明确要求时才丢弃脏工作区。
  'branch.archive'(p, params, actor) { return p.archiveBranch(params.branch, { discard_worktree: params.discard === true, continue: params.continue === true }); },
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
        `branch ${params.branch} does not belong to worker ${workerLabel(p.store.task(actor))}; agents may summarize only their own branch`);
      return p.setBranchSummary(params.branch, params.summary);
    }
    const branch = ownBranch(p, actor);
    check(branch, `worker ${workerLabel(p.store.task(actor))} has no branch to summarize; pass an explicit branch`);
    return p.setBranchSummary(branch, params.summary);
  },
};
