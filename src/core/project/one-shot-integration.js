import { check, id, TERMINAL } from '../types.js';
import { convergenceJSON as parse, convergenceRevision as revision } from '../convergence-contract.js';
import { inheritedRunProfile, profileEvent } from './internal.js';
import { assertTaskAncestorsOpen, taskDeliveryState, taskSyncDeliveryPaused } from './iteration.js';

const MODE = 'one_shot';
const ended = ['integrated', 'withdrawn', 'stale'];
const title = task => String(task.display_title || task.auto_title || task.goal || task.name || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120);
const oneShot = run => parse(run?.data, {}).operation_mode === MODE;
const publicMember = member => ({ id: member.task_id, worker_number: member.worker_number ?? null, title: member.title,
  source_commit: member.source_commit, base_commit: member.base_commit });
const readTip = (project, branch) => project.workspaces.git(project.config.project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`);

function target(project, branch) {
  check(typeof branch === 'string' && branch.length > 0 && branch.length <= 512 && branch === branch.trim()
    && !/[\x00-\x20\x7f~^:?*\[\\]/.test(branch) && !branch.includes('..') && !branch.includes('@{')
    && !branch.includes('//') && !branch.startsWith('/') && !branch.endsWith('/') && !branch.endsWith('.')
    && !branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')), 'invalid integration target branch');
  const owners = project.store.all(`SELECT * FROM tasks WHERE branch=? AND task_kind IN ('main','owner','order','child')
    AND status NOT IN ('completed','failed','cancelled')`, branch)
    .filter(task => !['archived','deleted'].includes(project.store.branch(task.branch)?.status));
  check(owners.length === 1, 'integration target requires one active real branch owner');
  assertTaskAncestorsOpen(project, owners[0]);
  return owners[0];
}

function fingerprint(project, task) {
  return { id: task.id, parent_id: task.parent_id, target_branch: task.target_branch, branch: task.branch,
    status: task.status, head_commit: task.head_commit, reservation: task.reservation, result: task.result,
    iteration_base_commit: task.iteration_base_commit, running: project.running.has(task.id),
    inbox: project.store.get('SELECT count(*) AS n,max(id) AS last FROM messages WHERE task_id=? AND consumed=0', task.id),
    questions: project.store.get("SELECT count(*) AS n,max(id) AS last FROM notices WHERE task_id=? AND status='open'", task.id),
    children: project.store.children(task.id).map(row => [row.id, row.status, row.integration, row.head_commit]),
    record: project.store.branch(task.branch) };
}

export default {
  oneShotRun(run) { return oneShot(run); },

  oneShotActive(branch) {
    return this.store.all(`SELECT * FROM delivery_runs WHERE target_branch=? AND json_valid(data)
      AND json_extract(data,'$.operation_mode')=? ORDER BY id DESC`, branch, MODE).find(run => !ended.includes(run.state)) ?? null;
  },

  branchIntegration(runId, memberLimit = Infinity) {
    const run = this.store.deliveryRun(id(runId)); check(oneShot(run), 'integration operation not found');
    const members = this.store.deliveryMembers(run.id), data = parse(run.data, {});
    const helper = run.integration_worker_id ? this.store.get('SELECT id,worker_number,status FROM tasks WHERE id=?', run.integration_worker_id) : null;
    return { version: 1, id: run.id, revision: revision({ run, members, helper }), target_branch: run.target_branch, state: run.state,
      worker: helper ?? (run.integration_worker_id ? { id: run.integration_worker_id, worker_number: run.integration_worker_number, status: null } : null),
      member_count: members.length, members: members.slice(0, memberLimit).map(publicMember), members_truncated: members.length > memberLimit,
      baseline: run.baseline, commit: run.state === 'integrated' ? run.candidate_commit : null,
      candidate_commit: run.candidate_commit, error: run.error, generation: run.generation,
      target: { id: run.parent_id, worker_number: this.store.get('SELECT worker_number FROM tasks WHERE id=?', run.parent_id)?.worker_number ?? null, branch: run.target_branch },
      previous_baseline: data.previous_baseline ?? null, created_at: run.created_at, updated_at: run.updated_at };
  },

  taskMergeOperation(task) {
    const run = this.store.get(`SELECT r.* FROM delivery_runs r WHERE json_valid(r.data)
      AND json_extract(r.data,'$.operation_mode')=? AND (r.integration_worker_id=? OR r.parent_id=? OR EXISTS
      (SELECT 1 FROM all_delivery_members m WHERE m.run_id=r.id AND m.task_id=?)) ORDER BY r.id DESC LIMIT 1`, MODE, task.id, task.id, task.id);
    return run ? this.branchIntegration(run.id, 16) : null;
  },

  oneShotAdmission(task) {
    const booking = parse(task.reservation);
    if (task.reservation && !booking) return '合并请求损坏，需先检查';
    if (booking && !(booking.version === 2 && ['pending', 'requested', 'suspended', 'integrated'].includes(booking.status)))
      return '已有执行中、修复中或历史合并请求，不能领取';
    if (booking?.landing_receipt || booking?.attempt_id) return '普通合并已有固定尝试或未知落地，不能领取';
    if (booking?.status === 'requested' && (booking.commit !== task.head_commit || booking.parent_id !== task.parent_id))
      return '普通合并固定来源或直接父已变化，需先检查';
    if (this.taskInputQueue(task).buffered) return '还有未处理或暂存输入';
    if (this.commandHookRunning?.has(task.id) || this.workerDeleteIds?.has(task.id)) return '来源资源正在使用';
    if (taskSyncDeliveryPaused(this, task.id)) return '来源交付因父同步暂停，需显式恢复';
    const reason = this.reservationWaitReason(task);
    if (reason) return reason;
    const record = this.store.branch(task.branch);
    if (!record || record.status !== 'active' || record.task_id !== task.id || record.parent !== task.target_branch
      || record.parent_relation !== 'recorded') return '来源真实直接父谱系不匹配';
    return null;
  },

  async oneShotPlan(branch) {
    const parent = target(this, branch), baseline = await readTip(this, branch);
    const active = this.oneShotActive(branch), members = [], excluded = [], snapshots = [];
    const rows = this.store.all("SELECT * FROM tasks WHERE parent_id=? AND task_kind IN ('order','child') ORDER BY id", parent.id);
    for (const task of rows) {
      let reason = task.target_branch !== branch ? '来源目标不是真实直接父分支' : this.oneShotAdmission(task);
      let source = null, base = null;
      try {
        if (!reason) {
          assertTaskAncestorsOpen(this, task);
          source = await readTip(this, task.branch);
          check(task.head_commit === source, '来源 ref 与登记提交不同');
          await this.workspaces.taskSyncCheckout(task, source);
          const state = await this.workspaces.branchState(task.branch);
          check(state.parent === branch && state.blockers.every(blocker => blocker === `task:#${task.id}`), '来源还有未收拢后代');
          check(await taskDeliveryState(this, task) === 'pending', '来源没有尚未合入的增量');
          base = await this.workspaces.taskSyncBase(task, source, baseline);
          // A receipt baseline is authoritative. Otherwise retain the exact original increment base.
          if (!base) base = task.iteration_base_commit ?? task.base_commit;
          check(base && await this.workspaces.isAncestor(this.config.project, base, source), '来源增量基点不可核对');
        }
      } catch (error) { reason = String(error.message).slice(0, 180); }
      snapshots.push(fingerprint(this, this.store.task(task.id)));
      if (reason) excluded.push({ id: task.id, worker_number: task.worker_number ?? null, reason });
      else members.push({ task_id: task.id, worker_number: task.worker_number ?? null, title: title(task), source_branch: task.branch,
        source_commit: source, base_commit: base, reservation: task.reservation });
    }
    const freeze = this.branchFreeze(branch);
    const latest = this.store.get(`SELECT id,state,generation,updated_at FROM delivery_runs WHERE target_branch=? AND json_valid(data)
      AND json_extract(data,'$.operation_mode')=? ORDER BY id DESC LIMIT 1`, branch, MODE);
    const reason = active ? '已有一次性整合操作，请查看当前操作' : freeze ? freeze.reason : !members.length ? '没有可准入的直接来源' : null;
    const stamp = { parent: { id: parent.id, branch, status: parent.status, reservation: parent.reservation }, baseline, snapshots,
      members, excluded, active: active ? this.branchIntegration(active.id, 16).revision : null, latest, freeze };
    return { view: { version: 1, branch, target: { id: parent.id, worker_number: parent.worker_number ?? null, branch },
      revision: revision(stamp), members: members.map(publicMember), excluded, count: members.length,
      active: active ? this.branchIntegration(active.id, 16) : null, ready: reason === null, reason }, parent, baseline, members, snapshots };
  },

  async branchIntegratePlan(branch) { return (await this.oneShotPlan(branch)).view; },

  async branchIntegrateStart(branch, expectedRevision) {
    return this.write('start one-shot integration', () => this.workspaces.exclusive(async () => {
      check(typeof expectedRevision === 'string' && expectedRevision.length > 0, 'integration revision is required');
      const previous = this.store.get(`SELECT * FROM delivery_runs WHERE target_branch=? AND json_valid(data)
        AND json_extract(data,'$.operation_mode')=? AND json_extract(data,'$.start_revision')=? ORDER BY id DESC LIMIT 1`, branch, MODE, expectedRevision);
      if (previous) return this.branchIntegration(previous.id); // Lost ACK never creates a second operation.
      check(!this.stopping && !this.maintenancePaused(), 'integration runtime is paused');
      const plan = await this.oneShotPlan(branch);
      check(plan.view.revision === expectedRevision, 'integration plan revision changed; reload before starting');
      check(plan.view.ready, plan.view.reason);
      check(await readTip(this, branch) === plan.baseline, 'integration target moved during preflight');
      for (const member of plan.members) check(await readTip(this, member.source_branch) === member.source_commit, 'integration source moved during preflight');
      let run;
      this.store.transaction(() => {
        const liveParent = target(this, branch);
        check(liveParent.id === plan.parent.id && liveParent.status === plan.parent.status && liveParent.reservation === plan.parent.reservation
          && !this.oneShotActive(branch) && !this.branchFreeze(branch), 'integration target operation changed');
        check(revision(plan.snapshots) === revision(plan.snapshots.map(snapshot => fingerprint(this, this.store.task(snapshot.id)))),
          'integration sources changed during preflight');
        const members = plan.members.map(member => {
          const task = this.store.task(member.task_id);
          check(!this.oneShotAdmission(task) && task.head_commit === member.source_commit && task.branch === member.source_branch,
            'integration source no longer ready');
          const delivery = this.store.event(task.id, 'integration.source_fixed', { source_commit: member.source_commit, base_commit: member.base_commit });
          return { task_id: task.id, source_branch: member.source_branch, source_commit: member.source_commit, base_commit: member.base_commit,
            delivery_id: delivery, enqueue_seq: delivery };
        });
        run = this.store.createDeliveryRun({ parent_id: plan.parent.id, target_branch: branch, baseline: plan.baseline, validation: null,
          members, data: { operation_mode: MODE, verification_mode: 'agent', start_revision: expectedRevision, baseline_attempts: 0,
            original_reservations: plan.members.map(member => ({ id: member.task_id, reservation: member.reservation })) } });
        for (const member of this.store.deliveryMembers(run.id)) this.store.update(member.task_id, { reservation: JSON.stringify({ version: 3,
          kind: 'merge', status: 'requested', operation_mode: MODE, run_id: run.id, generation: run.generation,
          parent_id: plan.parent.id, commit: member.source_commit, base_commit: member.base_commit,
          delivery_id: member.delivery_id, enqueue_seq: member.enqueue_seq, verification_mode: 'agent', validation: null }) });
        this.store.event(plan.parent.id, 'integration.started', { run_id: run.id, baseline: plan.baseline, member_count: members.length });
      });
      // Factory has no public RPC. Its resources are registered before Git creation.
      await this.createOneShotIntegration(run.id);
      this.scheduleConvergence(run.parent_id);
      return this.branchIntegration(run.id);
    }));
  },

  async createOneShotIntegration(runId) {
    const { run, parent, members } = this.assertConvergenceRun(runId, this.store.deliveryRun(runId).generation, ['preparing']);
    check(oneShot(run) && !run.integration_worker_id, 'one-shot integration identity already fixed');
    const inherited = inheritedRunProfile(this, parent, this.running.get(parent.id) ?? null);
    let helper;
    this.store.transaction(() => {
      helper = this.store.create({ parent_id: parent.id, input_id: null, role: 'agent', task_kind: 'integration', name: `integrate-${run.id}`,
        goal: '一次性自主整合全部固定直接来源；自己决定顺序、分组与语义适配，在私有工作区完成最终组合验证后交付一次候选，不修改任何源或真实目标。' });
      this.store.update(helper.id, { status: 'paused', ...(inherited ? { retry_profile: JSON.stringify(inherited) } : {}) });
      const node = this.store.createDeliveryNode({ run_id: run.id, generation: run.generation, node_key: 'autonomous', state: 'resolving',
        helper_id: helper.id, data: { kind: 'autonomous', member_ids: members.map(member => member.task_id),
          left: run.baseline, right: run.baseline, seed_commit: run.baseline, base: null } });
      const fixed = { version: 1, operation_mode: MODE, worker_id: helper.id, run_id: run.id, node_id: node.id, generation: run.generation,
        parent_id: parent.id, target_branch: run.target_branch, baseline: run.baseline, seed_commit: run.baseline,
        left: run.baseline, right: run.baseline, base: null, reason: MODE, verification_mode: 'agent', members };
      this.store.event(helper.id, 'convergence.integration_created', fixed);
      this.store.event(helper.id, 'integration.attempt_fixed', fixed);
      if (inherited) this.store.event(helper.id, 'task.configured', { ...profileEvent(inherited), inherited_from: parent.id });
      this.store.updateDeliveryRun(run.id, { state: 'resolving', integration_worker_id: helper.id }, run.generation);
    });
    try {
      await this.workspaces.forkTaskUnsafe(helper, run.target_branch, run.baseline);
      this.oneShotFixedContext(this.store.task(helper.id));
      await this.workspaces.finish(this.store.task(helper.id));
      check(!this.stopping, 'project is stopping');
      this.store.update(helper.id, { status: 'queued' }); this.kick();
    } catch {
      this.store.update(helper.id, { status: 'failed', error: '整合私有工作区创建未完成，保留现场。' });
      this.setConvergenceState(run.id, run.generation, 'failed', { error: '整合私有工作区创建未完成；未修改来源或目标。' });
    }
    return this.store.task(helper.id);
  },

  oneShotFixedContext(task) {
    const creation = parse(this.store.get("SELECT data FROM events WHERE task_id=? AND type='convergence.integration_created' ORDER BY id LIMIT 1", task.id)?.data);
    const fixed = parse(this.store.get("SELECT data FROM events WHERE task_id=? AND type='integration.attempt_fixed' ORDER BY id DESC LIMIT 1", task.id)?.data);
    check(task.task_kind === 'integration' && task.role === 'agent' && creation?.operation_mode === MODE && fixed?.operation_mode === MODE,
      'one-shot integration identity is missing');
    const run = this.store.deliveryRun(fixed.run_id), node = this.store.deliveryNode(fixed.node_id);
    check(oneShot(run) && run.generation === fixed.generation && run.integration_worker_id === task.id && node?.run_id === run.id
      && node.generation === run.generation && node.helper_id === task.id && task.parent_id === run.parent_id
      && task.target_branch === run.target_branch && task.base_commit === creation.seed_commit && fixed.baseline === run.baseline,
      'one-shot integration attempt changed');
    const members = this.store.deliveryMembers(run.id, true);
    check(members.length > 0 && members.length === fixed.members.length && members.every((member, index) => {
      const input = fixed.members[index]; return member.task_id === input.task_id && member.delivery_id === input.delivery_id
        && member.source_commit === input.source_commit && member.base_commit === input.base_commit && member.source_branch === input.source_branch;
    }), 'one-shot integration fixed membership changed');
    check(parse(node.data).kind === 'autonomous' && parse(node.data).left === fixed.left && parse(node.data).right === fixed.right,
      'one-shot integration node changed');
    return { fixed, run, node };
  },

  async prepareOneShotIntegration(runId, generation, signal) {
    let { run, parent, members } = this.assertConvergenceRun(runId, generation, ['preparing']);
    check(!signal?.aborted && !this.running.has(run.integration_worker_id), 'one-shot invocation is still exiting');
    if (await readTip(this, parent.branch) !== run.baseline) { await this.refreshOneShotBaseline(runId, generation); return; }
    const node = this.store.deliveryNodes(runId, generation).find(row => row.node_key === 'autonomous'), output = parse(node?.result);
    check(node?.state === 'ready' && output?.commit && output.tree && output.via === 'integration', 'autonomous Agent output is not ready');
    const helper = this.store.task(run.integration_worker_id);
    check(helper.status === 'awaiting_acceptance' && helper.head_commit === output.commit && !this.hasActionableMessages(helper.id)
      && !this.questionPending(helper.id), 'integration has unhandled input or decisions');
    const receipt = await this.workspaces.exclusive(async () => {
      this.assertConvergenceRun(runId, generation, ['preparing']);
      await this.workspaces.taskSyncCheckout(helper, output.commit);
      check(await this.workspaces.git(helper.workspace, 'rev-parse', `${output.commit}^{tree}`) === output.tree, 'integration output tree changed');
      for (const input of [run.baseline, ...members.map(member => member.source_commit)])
        check(await this.workspaces.isAncestor(this.config.project, input, output.commit), 'autonomous output lost a fixed input');
      const evidence = { ref: `refs/lush/convergence-evidence/${runId}/${generation}`, commit: output.commit };
      const value = await this.workspaces.prepareConvergencePublishUnsafe({ parent: parent.branch, baseline: run.baseline, tree: output.tree,
        members, evidence, operation_mode: MODE, message: `Integrate ${members.length} sources (operation ${runId}/${generation})`, run_id: runId, generation });
      this.assertConvergenceRun(runId, generation, ['preparing']);
      return value;
    });
    run = this.store.deliveryRun(runId);
    this.store.updateDeliveryRun(runId, { candidate_commit: receipt.commit, candidate_tree: receipt.tree,
      data: { ...parse(run.data), prepared_receipt: receipt, root_commit: output.commit } }, generation);
    check(!signal?.aborted, 'one-shot preparation stopped');
    this.setConvergenceState(runId, generation, 'ready');
    await this.publishConvergence(runId);
  },

  async refreshOneShotBaseline(runId, generation, explicit = false) {
    return this.workspaces.exclusive(async () => {
      const { run, parent, members } = this.assertConvergenceRun(runId, generation);
      let helper = this.store.task(run.integration_worker_id);
      const data = parse(run.data);
      check(oneShot(run) && !run.landing_receipt && !this.running.has(helper.id), 'cannot invalidate an active or unknown landing');
      check(!this.questionPending(helper.id) && !this.hasActionableMessages(helper.id), 'process integration decisions before retrying');
      check(explicit || (data.baseline_attempts ?? 0) < 3, 'target changed repeatedly; explicitly retry after inspection');
      const baseline = await readTip(this, parent.branch);
      await this.workspaces.finish(helper);
      helper = this.store.task(helper.id);
      await this.workspaces.taskSyncCheckout(helper, helper.head_commit);
      for (const member of members) {
        await this.workspaces.assertCleanBranches([member.source_branch]);
        check(await readTip(this, member.source_branch) === member.source_commit, 'fixed integration source moved');
      }
      this.assertConvergenceRun(runId, generation);
      this.store.transaction(() => {
        const next = generation + 1;
        this.store.updateDeliveryRun(runId, { generation: next, baseline, state: 'resolving', candidate_commit: null, candidate_tree: null,
          validation_result: null, error: null, data: { ...data, previous_baseline: run.baseline, previous_output: helper.head_commit,
            prepared_receipt: null, root_commit: null, baseline_attempts: explicit ? 0 : (data.baseline_attempts ?? 0) + 1 } }, generation);
        const node = this.store.createDeliveryNode({ run_id: runId, generation: next, node_key: 'autonomous', state: 'resolving', helper_id: helper.id,
          data: { kind: 'autonomous', member_ids: members.map(member => member.task_id), left: baseline, right: helper.head_commit,
            seed_commit: helper.base_commit, base: run.baseline } });
        const fixed = { version: 1, operation_mode: MODE, worker_id: helper.id, run_id: runId, node_id: node.id, generation: next,
          parent_id: parent.id, target_branch: parent.branch, baseline, previous_baseline: run.baseline,
          previous_output: helper.head_commit, previous_report: String(helper.result ?? '').slice(0, 2000), tests_invalidated: true,
          seed_commit: helper.base_commit, left: baseline, right: helper.head_commit, base: run.baseline,
          reason: explicit ? 'retry' : 'baseline_changed', verification_mode: 'agent', members };
        this.store.event(helper.id, 'integration.attempt_fixed', fixed);
        for (const member of members) {
          const booking = parse(this.store.task(member.task_id).reservation);
          this.store.update(member.task_id, { reservation: JSON.stringify({ ...booking, generation: next, status: 'requested' }), integration_error: null });
        }
        this.store.update(helper.id, { status: 'queued', error: null, interrupt_state: null });
        this.store.event(parent.id, 'integration.baseline_invalidated', { run_id: runId, generation: next, baseline, previous_baseline: run.baseline });
      });
      this.kick(); return this.branchIntegration(runId);
    });
  },

  async branchIntegrateRetry(runId, expectedRevision) {
    return this.write('retry one-shot integration', async () => {
      const view = this.branchIntegration(runId), run = this.store.deliveryRun(runId);
      check(view.revision === expectedRevision, 'integration operation revision changed; reload before retrying');
      check(['failed', 'awaiting'].includes(run.state) && !run.landing_receipt, 'unknown or active landing cannot be retried');
      check(!this.convergenceJobs?.has(runId) && !this.running.has(run.integration_worker_id), 'integration invocation is still exiting');
      await this.refreshOneShotBaseline(runId, run.generation, true);
      return this.branchIntegration(runId);
    });
  },

  async branchIntegrateCancel(runId, expectedRevision) {
    return this.write('cancel one-shot integration', () => this.workspaces.exclusive(() => {
      const view = this.branchIntegration(runId);
      check(view.revision === expectedRevision, 'integration operation revision changed; reload before cancelling');
      return this.cancelOneShotIntegration(runId);
    }));
  },

  cancelOneShotIntegration(runId) {
    const run = this.store.deliveryRun(runId), data = parse(run?.data, {});
    check(oneShot(run), 'integration operation not found');
    if (run.state === 'withdrawn') return this.branchIntegration(runId);
    check(!ended.includes(run.state) && !run.landing_receipt && run.state !== 'landing', 'publication has started; preserve exact landing evidence');
    this.store.transaction(() => {
      this.store.updateDeliveryRun(runId, { generation: run.generation + 1, state: 'awaiting', candidate_commit: null, candidate_tree: null,
        data: { ...data, wait_reason: 'one_shot_cancelling', prepared_receipt: null }, error: '取消中，等待整合调用安全退出。' }, run.generation);
      for (const member of this.store.deliveryMembers(runId, true)) {
        const booking = parse(this.store.task(member.task_id).reservation);
        this.store.update(member.task_id, { reservation: JSON.stringify({ ...booking, generation: run.generation + 1, status: 'blocked' }) });
      }
      const helper = run.integration_worker_id && this.store.task(run.integration_worker_id);
      if (helper && !TERMINAL.has(helper.status)) {
        this.store.update(helper.id, { status: 'cancelled', error: '一次性整合已取消，私有代码保留。', interrupt_state: null });
        this.store.armAgent(helper.id, null);
        this.store.run("UPDATE notices SET status='dismissed',answer='integration cancelled' WHERE task_id=? AND status='open'", helper.id);
      }
      this.store.event(run.parent_id, 'integration.cancel_requested', { run_id: runId });
    });
    this.convergenceJobs?.get(runId)?.controller.abort(new Error('one-shot integration cancelled'));
    this.running.get(run.integration_worker_id)?.controller.abort(new Error('one-shot integration cancelled'));
    this.drainOneShotCancellation(runId);
    return this.branchIntegration(runId);
  },

  drainOneShotCancellation(runId) {
    const run = this.store.deliveryRun(runId), data = parse(run?.data, {});
    if (!oneShot(run) || data.wait_reason !== 'one_shot_cancelling' || this.running.has(run.integration_worker_id)
      || this.convergenceJobs?.has(runId)) return false;
    this.store.transaction(() => {
      for (const member of this.store.deliveryMembers(runId, true)) {
        const original = parse(data.original_reservations?.find(item => item.id === member.task_id)?.reservation);
        // Never restart a cancelled collection's ordinary writes behind the user's back.
        const restored = original && original.status !== 'integrated' ? { ...original, status: 'suspended',
          blocked_reason: '一次性整合已取消，普通合并需显式重新请求' } : original;
        this.store.update(member.task_id, { reservation: restored ? JSON.stringify(restored) : null, integration_error: null });
        this.store.run("UPDATE messages SET consumed=1 WHERE task_id=? AND sender_id=? AND signal_type='merge.requested'", run.parent_id, member.task_id);
      }
      this.store.releaseDeliveryMembers(runId);
      this.store.updateDeliveryRun(runId, { state: 'withdrawn', error: null, data: { ...data, wait_reason: null } }, run.generation);
      this.store.event(run.parent_id, 'integration.cancelled', { run_id: runId });
    });
    for (const member of this.store.deliveryMembers(runId)) this.releaseTaskInputs(member.task_id);
    return true;
  },
};
