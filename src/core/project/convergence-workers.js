import { check, id, TERMINAL } from '../types.js';
import { convergenceJSON, convergenceVerificationMode, CONVERGENCE_LIMITS } from '../convergence-contract.js';
import { inheritedRunProfile, profileEvent } from './internal.js';
import { assertTaskAncestorsOpen } from './iteration.js';

const SHA = /^[0-9a-f]{40,64}$/;
const CREATED = 'convergence.integration_created';
const READY = 'convergence.integration_ready';
const resumable = new Set(['resolving', 'awaiting']);

function wakeAfterIntegrationExit(project, parentId) {
  if (project.wakeConvergenceAfterIntegration) project.wakeConvergenceAfterIntegration(parentId);
  else project.scheduleConvergence?.(parentId);
}

/** A helper's identity comes from its immutable creation event, never the current source tips. */
function fixedContext(project, task) {
  check(task.task_kind === 'integration' && task.role === 'agent', 'not a convergence integration Worker');
  const events = project.store.all('SELECT data FROM events WHERE task_id=? AND type=? ORDER BY id LIMIT 2', task.id, CREATED);
  check(events.length === 1, 'integration Worker requires one fixed creation receipt');
  const fixed = convergenceJSON(events[0].data);
  if (fixed?.operation_mode === 'one_shot') return project.oneShotFixedContext(task);
  check(fixed?.version === 1 && fixed.worker_id === task.id && Number.isSafeInteger(fixed.generation)
    && fixed.generation > 0 && Number.isSafeInteger(fixed.run_id) && Number.isSafeInteger(fixed.node_id)
    && SHA.test(fixed.seed_commit) && SHA.test(fixed.left) && SHA.test(fixed.right), 'invalid integration creation receipt');
  const run = project.store.deliveryRun(fixed.run_id), node = project.store.deliveryNode(fixed.node_id);
  check(run && node && node.run_id === run.id && node.generation === fixed.generation
    && run.generation === fixed.generation && node.helper_id === task.id
    && task.parent_id === run.parent_id && task.target_branch === run.target_branch
    && task.base_commit === fixed.seed_commit && fixed.baseline === run.baseline,
  'integration Worker belongs to a stale or changed attempt');
  const mode = convergenceVerificationMode(convergenceJSON(run.data, {}).verification_mode, run.validation);
  check(fixed.verification_mode === undefined ? mode === 'command' : fixed.verification_mode === mode,
    'integration verification mode changed');
  const data = convergenceJSON(node.data, {});
  check(data.left === fixed.left && data.right === fixed.right && data.seed_commit === fixed.seed_commit
    && (data.base ?? null) === fixed.base && fixed.parent_id === run.parent_id && fixed.target_branch === run.target_branch
    && Array.isArray(data.member_ids) && data.member_ids.length === fixed.members?.length
    && new Set(data.member_ids).size === data.member_ids.length
    && data.member_ids.every(taskId => fixed.members.some(member => member.task_id === taskId)),
    'integration fixed node inputs changed');
  const members = project.store.deliveryMembers(run.id, true);
  check(Array.isArray(fixed.members) && fixed.members.length > 0 && fixed.members.length <= CONVERGENCE_LIMITS.members
    && fixed.members.every(member => members.some(live => live.task_id === member.task_id
      && live.delivery_id === member.delivery_id && live.source_branch === member.source_branch
      && live.source_commit === member.source_commit)), 'integration fixed membership changed');
  return { fixed, run, node };
}

export default {
  /** Internal factory; there is intentionally no corresponding Agent RPC. */
  async createConvergenceIntegration(runId, nodeId) {
    id(runId); id(nodeId);
    return this.write('create a convergence integration Worker', () => this.workspaces.exclusive(async () => {
      check(!this.stopping, 'project is stopping');
      const run = this.store.deliveryRun(runId), node = this.store.deliveryNode(nodeId);
      check(run && node && node.run_id === run.id && node.generation === run.generation,
        'integration node belongs to a stale attempt');
      if (node.helper_id) {
        const helper = this.store.task(node.helper_id);
        fixedContext(this, helper); // Idempotent lookup is not permission to restart a failed model call.
        return helper;
      }
      check(node.state === 'conflict', 'integration factory requires a fixed conflict node');
      check(['preparing', 'resolving', 'failed'].includes(run.state), 'run is not eligible for isolated integration');
      const data = convergenceJSON(node.data, {}), parent = this.store.task(run.parent_id);
      check(['main', 'owner', 'order', 'child'].includes(parent.task_kind) && !TERMINAL.has(parent.status)
        && parent.branch === run.target_branch, 'integration parent changed or ended');
      assertTaskAncestorsOpen(this, parent);
      check(SHA.test(data.seed_commit) && SHA.test(data.left) && SHA.test(data.right) && SHA.test(run.baseline),
        'integration node requires fixed commits');
      check(Array.isArray(data.member_ids) && data.member_ids.length > 0
        && data.member_ids.length <= CONVERGENCE_LIMITS.members && new Set(data.member_ids).size === data.member_ids.length,
      'integration node requires a bounded distinct member set');
      const members = this.store.deliveryMembers(run.id, true).filter(member => data.member_ids.includes(member.task_id));
      check(members.length === data.member_ids.length, 'integration member is no longer active');
      for (const member of members) {
        const source = this.store.task(member.task_id);
        check(source.parent_id === parent.id && source.target_branch === run.target_branch
          && source.branch === member.source_branch && source.head_commit === member.source_commit,
        'integration source identity changed');
      }
      check(this.store.get("SELECT count(*) AS n FROM tasks WHERE status NOT IN ('completed','failed','cancelled')").n < 1000,
        'too many active Workers');
      for (const input of [data.left, data.right]) check(await this.workspaces.isAncestor(this.config.project, input, data.seed_commit),
        'integration seed must preserve both fixed inputs');
      // Git awaits may race a withdrawal/cancel. Persist helper+claim only against the still-live generation.
      const liveRun = this.store.deliveryRun(run.id), liveNode = this.store.deliveryNode(node.id), liveParent = this.store.task(parent.id);
      check(!this.stopping && liveRun.generation === run.generation && liveNode.generation === node.generation
        && liveNode.helper_id === null && liveRun.state === run.state && liveNode.state === node.state && liveNode.data === node.data
        && !TERMINAL.has(liveParent.status) && liveParent.branch === run.target_branch,
      'integration attempt changed before creation');
      assertTaskAncestorsOpen(this, liveParent);
      const currentMembers = this.store.deliveryMembers(run.id, true);
      check(members.every(member => currentMembers.some(live => live.task_id === member.task_id
        && live.delivery_id === member.delivery_id && live.source_commit === member.source_commit
        && live.source_branch === member.source_branch)), 'integration members changed before creation');
      const inherited = inheritedRunProfile(this, liveParent, this.running.get(parent.id) ?? null);
      let helper;
      this.store.transaction(() => {
        helper = this.store.create({ parent_id: parent.id, input_id: null, role: 'agent', task_kind: 'integration',
          name: `integration-${run.id}-${node.id}-${run.generation}`,
          goal: '在自己的隔离工作区保留固定双方意图，修复归并冲突或组合验证问题；仅交付候选产物，不修改源或父分支。' });
        this.store.update(helper.id, { status: 'paused', ...(inherited ? { retry_profile: JSON.stringify(inherited) } : {}) });
        const fixed = { version: 1, worker_id: helper.id, run_id: run.id, node_id: node.id, generation: run.generation,
          parent_id: parent.id, target_branch: run.target_branch, baseline: run.baseline,
          verification_mode: convergenceVerificationMode(convergenceJSON(run.data, {}).verification_mode, run.validation),
          base: data.base ?? null, left: data.left, right: data.right, seed_commit: data.seed_commit,
          reason: ['validation', 'validation_failed'].includes(data.reason) ? 'validation'
            : data.reason === 'semantic' ? 'semantic' : 'conflict',
          members: members.map(member => ({ task_id: member.task_id, delivery_id: member.delivery_id,
            source_branch: member.source_branch, source_commit: member.source_commit, base_commit: member.base_commit })) };
        this.store.event(helper.id, CREATED, fixed);
        if (inherited) this.store.event(helper.id, 'task.configured', { ...profileEvent(inherited), inherited_from: parent.id });
        this.store.updateDeliveryNode(node.id, { helper_id: helper.id, state: 'resolving' }, run.generation);
        this.store.updateDeliveryRun(run.id, { state: 'resolving', integration_worker_id: helper.id, error: null }, run.generation);
      });
      try {
        await this.workspaces.forkTaskUnsafe(helper, run.target_branch, data.seed_commit);
        fixedContext(this, this.store.task(helper.id));
        assertTaskAncestorsOpen(this, this.store.task(helper.id));
        check(!this.stopping && resumable.has(this.store.deliveryRun(run.id).state), 'integration creation no longer eligible');
        this.store.update(helper.id, { status: 'queued' });
      } catch {
        // Worktree/ref creation may have partially completed. Preserve the registered scene; never recreate blindly.
        this.store.update(helper.id, { status: 'failed', error: '整合工作区创建未完成，保留现场，请显式检查。' });
        const current = this.store.deliveryRun(run.id);
        if (current.generation === run.generation) this.store.updateDeliveryRun(run.id,
          { state: 'failed', error: '整合工作区创建未完成，未修改源或父分支。' }, run.generation);
        // No invocation was launched; the failed allocation has definitively released its helper slot.
        if (!this.running.has(helper.id)) this.wakeConvergenceAfterIntegration?.(run.parent_id);
        throw new Error('integration workspace creation incomplete; inspect retained resources');
      }
      this.kick();
      return this.store.task(helper.id);
    }));
  },

  convergenceIntegrationReady(task) {
    try {
      const { run, node } = fixedContext(this, task);
      if (!resumable.has(run.state) || !resumable.has(node.state)
        || TERMINAL.has(task.status) || task.status === 'awaiting_acceptance') return false;
      assertTaskAncestorsOpen(this, task);
      return !this.workerDeleteIds?.has(task.id) && !this.taskSyncBusy?.has(task.id);
    } catch { return false; }
  },

  convergenceIntegrationContext(task) {
    const { fixed, run } = fixedContext(this, task);
    const autonomous = this.oneShotRun?.(run), parent = this.store.task(run.parent_id);
    return { ...fixed, target: { id: parent.id, worker_number: parent.worker_number ?? null, branch: parent.branch, task_kind: parent.task_kind },
      ...(autonomous ? { autonomy: 'Agent chooses order, grouping, semantic adaptations and final verification; runtime does not pair sources.',
        verification_responsibility: ['main', 'owner'].includes(parent.task_kind) ? 'final integration and full project test suite' : 'affected integration and regression',
        increment_rule: 'Use each exact base_commit..source_commit delta. Previously squashed changes are already represented in the target; do not replay the entire source history.' } : {}),
      members: fixed.members.map(member => {
      const source = this.store.task(member.task_id);
      const goal = String(source.goal ?? ''), report = String(source.result ?? '');
      return { ...member, worker_number: source.worker_number ?? null,
        title: source.display_title || source.auto_title || goal.slice(0, 200), goal: goal.slice(0, 500), goal_truncated: goal.length > 500,
        report: report.slice(0, 1500), report_truncated: report.length > 1500 };
    }), checks: ['审查固定输入的共同祖先以来增量、改名、公共接口与语义，而不只读冲突标记。',
      '仅修改自己的登记工作区，保留两侧固定输入祖先；不推进源或父ref、不委派或发送普通消息。',
      'Agent负责实际运行受影响专项与调用链回归并提交，歧义通过自身Notice请求决定；不得宣称runtime自动运行全量。',
      ...(fixed.verification_mode === 'agent'
        ? ['此固定请求由Agent自主验证，runtime不执行最终验证快捷指令；就绪与发布不代表测试通过。']
        : ['此历史固定请求仍由runtime执行精确候选的隔离授权命令；不可将专项测试冒充最终发布验证。']),
      '产物继续参与归并，不代表任何来源或本Worker已经合入父分支。'] };
  },

  /** Prepare a durable output receipt. Node promotion is deferred until actual invocation ownership release. */
  async completeConvergenceIntegration(taskId, invocationRunId) {
    const task = this.store.task(taskId), { fixed, run, node } = fixedContext(this, task);
    const invocation = this.running.get(task.id);
    check(invocation?.recordId === invocationRunId && !invocation.parked && !invocation.controller.signal.aborted
      && task.status === 'running' && resumable.has(run.state) && resumable.has(node.state),
      'integration Worker is not completing the active attempt');
    const cwd = await this.workspaces.ensure(task);
    await this.workspaces.clean(cwd);
    const commit = await this.workspaces.git(cwd, 'rev-parse', 'HEAD');
    for (const input of [fixed.left, fixed.right, fixed.seed_commit,
      ...(this.oneShotRun?.(run) ? fixed.members.map(member => member.source_commit) : [])]) check(await this.workspaces.isAncestor(cwd, input, commit),
      'integration output lost a fixed input ancestor');
    const tree = await this.workspaces.git(cwd, 'rev-parse', `${commit}^{tree}`);
    const liveTask = this.store.task(task.id), live = fixedContext(this, liveTask);
    check(liveTask.status === 'running' && liveTask.head_commit === commit && resumable.has(live.run.state)
      && resumable.has(live.node.state) && !this.running.get(task.id)?.controller.signal.aborted,
    'integration attempt changed before output receipt');
    check(!this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open'", task.id)
      && !this.hasActionableMessages(task.id), 'integration has unhandled input or decisions');
    const result = { tree, commit, via: 'integration' };
    this.store.transaction(() => {
      this.store.event(task.id, READY, { run_id: run.id, node_id: node.id, generation: fixed.generation,
        invocation_run_id: invocationRunId, ...result });
      this.store.update(task.id, { status: 'awaiting_acceptance' });
    });
    return result;
  },

  /** Called only after running.delete and token revocation. Never release a candidate while tools still own it. */
  onConvergenceIntegrationExit(taskId) {
    if (this.running.has(taskId)) return;
    const task = this.store.task(taskId);
    let current;
    try { current = fixedContext(this, task); } catch {
      // Obsolete replies cannot advance a new generation, but their actual exit can free other targets' helper slots.
      this.wakeConvergenceAfterIntegration?.(task.parent_id);
      return;
    }
    const { fixed, run, node } = current;
    if (!resumable.has(run.state) || !resumable.has(node.state)) {
      if (TERMINAL.has(task.status)) this.wakeConvergenceAfterIntegration?.(run.parent_id);
      return;
    }
    const ready = this.store.get('SELECT data FROM events WHERE task_id=? AND type=? ORDER BY id DESC LIMIT 1', task.id, READY);
    const result = convergenceJSON(ready?.data);
    const finished = result && this.store.get('SELECT status FROM agent_runs WHERE id=? AND task_id=?', result.invocation_run_id, task.id);
    if (task.status === 'awaiting_acceptance' && result?.generation === fixed.generation
      && result.run_id === run.id && result.node_id === node.id && result.commit === task.head_commit
      && finished?.status === 'completed' && !this.hasActionableMessages(task.id)
      && !this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open'", task.id)) {
      this.store.transaction(() => {
        this.store.updateDeliveryNode(node.id, { state: 'ready', result: JSON.stringify({ tree: result.tree, commit: result.commit, via: 'integration' }) }, run.generation);
        this.store.updateDeliveryRun(run.id, { state: 'preparing', error: null }, run.generation);
        this.store.event(task.id, 'convergence.integration_settled', { run_id: run.id, node_id: node.id, generation: run.generation });
      });
      wakeAfterIntegrationExit(this, run.parent_id);
      return;
    }
    const awaiting = ['awaiting', 'paused'].includes(task.status);
    const continuing = task.status === 'queued' || task.status === 'waiting';
    this.store.transaction(() => {
      this.store.updateDeliveryNode(node.id, { state: awaiting ? 'awaiting' : continuing ? 'resolving' : 'failed' }, run.generation);
      this.store.updateDeliveryRun(run.id, { state: awaiting ? 'awaiting' : continuing ? 'resolving' : 'failed',
        error: awaiting ? '整合Worker等待决定或运行资源，未占父发布写位。' : continuing ? null : '整合Worker未交付有效产物，保留现场，不自动重放。' }, run.generation);
    });
    wakeAfterIntegrationExit(this, run.parent_id);
  },
};
