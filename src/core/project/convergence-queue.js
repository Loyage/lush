import { check, id, TERMINAL } from '../types.js';
import { assertTaskAncestorsOpen, taskSyncDeliveryPaused } from './iteration.js';
import { CONVERGENCE_LIMITS, convergenceBooking, convergenceJSON } from '../convergence-contract.js';
import { selectConvergenceMembers, convergenceTopology } from '../convergence-plan.js';

const preparing = ['preparing', 'ready'];
const sameValidation = (a, b) => a?.command_id === b?.command_id && a?.command_version === b?.command_version;

/** Formation/preparation own bounded slots, never the parent's publication slot. */
export default {
  convergenceAuthorizationStamp(validation) {
    return this.store.get(`SELECT max(id) AS id FROM events WHERE type IN
      ('shortcut.command_saved','shortcut.command_authorized','shortcut.command_removed')
      AND json_extract(data,'$.command_id')=?`, validation?.command_id)?.id ?? 0;
  },

  assertConvergenceAuthorization(run) {
    const reference = convergenceJSON(run.validation);
    const command = this.resolveShortcutCommand(reference);
    const data = convergenceJSON(run.data, {});
    check(data.authorization_id === this.convergenceAuthorizationStamp(reference), 'convergence command authorization changed');
    return command;
  },

  assertConvergenceRun(runId, generation, states = null) {
    const run = this.store.deliveryRun(runId);
    check(run && run.generation === generation && (!states || states.includes(run.state)), 'convergence attempt changed');
    check(!this.stopping && !this.clearing && !this.maintenancePaused(), 'convergence runtime is paused');
    const parent = this.store.task(run.parent_id);
    check(!TERMINAL.has(parent.status) && parent.branch === run.target_branch
      && ['main', 'owner', 'order', 'child'].includes(parent.task_kind), 'convergence parent changed');
    const members = this.store.deliveryMembers(run.id, true);
    check(members.length >= 1 && members.length <= CONVERGENCE_LIMITS.members, 'convergence membership changed');
    for (const member of members) {
      const task = this.store.task(member.task_id), booking = convergenceBooking(task);
      check(booking?.run_id === run.id && booking.generation === generation && booking.delivery_id === member.delivery_id
        && booking.commit === member.source_commit && task.head_commit === member.source_commit
        && task.branch === member.source_branch && task.target_branch === parent.branch && task.parent_id === parent.id
        && ['order', 'child'].includes(task.task_kind) && !TERMINAL.has(task.status), 'convergence source identity changed');
      check(!this.running.has(task.id) && !this.taskSyncBusy?.has(task.id) && !this.commandHookRunning?.has(task.id)
        && !this.workerDeleteIds?.has(task.id) && !this.reservationWaitReason(task)
        && !taskSyncDeliveryPaused(this, task.id), 'convergence source is not safely idle');
      assertTaskAncestorsOpen(this, task);
      const record = this.store.branch(task.branch);
      check(record?.status === 'active' && record.task_id === task.id && record.parent === parent.branch,
        'convergence source ownership changed');
    }
    return { run, parent, members };
  },

  setConvergenceState(runId, generation, state, patch = {}) {
    return this.store.transaction(() => {
      const run = this.store.deliveryRun(runId);
      check(run?.generation === generation, 'convergence attempt changed');
      const next = this.store.updateDeliveryRun(runId, { ...patch, state }, generation);
      const blocked = ['failed', 'blocked', 'awaiting'].includes(state);
      for (const member of this.store.deliveryMembers(runId, true)) {
        const task = this.store.task(member.task_id), booking = convergenceBooking(task);
        if (booking?.run_id !== runId || booking.generation !== generation) continue;
        this.store.update(task.id, { reservation: JSON.stringify({ ...booking,
          status: state === 'landing' ? 'executing' : blocked ? 'blocked' : 'requested' }),
          integration_error: blocked ? patch.error ?? '归并正在等待处理；请检查批次状态。' : null });
      }
      return next;
    });
  },

  scheduleConvergence(parentId) {
    if (!parentId || this.stopping || this.clearing || this.maintenancePaused()) return;
    (this.convergenceWakePending ??= new Set()).add(parentId);
    queueMicrotask(() => this.driveConvergence(parentId).catch(() => {
      this.store.event(parentId, 'convergence.queue_failed', { error: '归并调度未完成；请检查固定交付状态。' });
    }));
  },

  async formConvergenceBatch(parentId) {
    return this.workspaces.exclusive(async () => {
      if (this.stopping || this.clearing || this.maintenancePaused()) return null;
      const parent = this.store.task(parentId);
      if (TERMINAL.has(parent.status) || !parent.branch) return null;
      const rows = this.store.all(`SELECT * FROM tasks WHERE json_valid(reservation)
        AND json_extract(reservation,'$.version')=3 AND json_extract(reservation,'$.parent_id')=?
        AND json_extract(reservation,'$.status')='requested' AND json_extract(reservation,'$.run_id') IS NULL
        ORDER BY json_extract(reservation,'$.enqueue_seq'),id`, parentId);
      const dependencies = new Map(), landed = new Set(), candidates = [];
      for (const task of rows) {
        const booking = convergenceBooking(task);
        if (this.reservationWaitReason(task) || this.running.has(task.id) || this.taskSyncBusy?.has(task.id)
          || this.commandHookRunning?.has(task.id)) continue;
        const upstream = this.store.deps(task.id).filter(edge => edge.kind === 'code').map(edge => edge.depends_on);
        dependencies.set(task.id, upstream);
        for (const taskId of upstream) if (this.store.get('SELECT integration FROM tasks WHERE id=?', taskId)?.integration === 'merged') landed.add(taskId);
        candidates.push({ task_id: task.id, delivery_id: booking.delivery_id, enqueue_seq: booking.enqueue_seq,
          source_branch: task.branch, source_commit: booking.commit, base_commit: booking.base_commit ?? null,
          validation: booking.validation, reservation: task.reservation });
      }
      const ready = selectConvergenceMembers(candidates, dependencies, landed);
      if (!ready.length) return null;
      // Different pinned command versions never silently share a validation claim.
      const selected = ready.filter(member => sameValidation(member.validation, ready[0].validation));
      const baseline = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${parent.branch}^{commit}`);
      for (const member of selected) {
        await this.workspaces.assertCleanBranches([member.source_branch]);
        check(await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${member.source_branch}`) === member.source_commit,
          'fixed convergence source ref changed');
      }
      return this.store.transaction(() => {
        const currentParent = this.store.task(parent.id);
        check(currentParent.branch === parent.branch && !TERMINAL.has(currentParent.status), 'convergence parent changed while forming');
        for (const member of selected) {
          const task = this.store.task(member.task_id);
          check(task.reservation === member.reservation && task.head_commit === member.source_commit
            && task.parent_id === parent.id && task.target_branch === parent.branch && !this.reservationWaitReason(task),
          'fixed delivery changed while forming');
        }
        const plan = convergenceTopology(selected), validation = selected[0].validation;
        const run = this.store.createDeliveryRun({ parent_id: parent.id, target_branch: parent.branch, baseline,
          validation: JSON.stringify(validation), members: selected.map(({ validation, reservation, ...member }) => member),
          data: JSON.stringify({ plan, authorization_id: this.convergenceAuthorizationStamp(validation),
            baseline_attempts: 0, repair_attempts: 0 }) });
        for (const member of selected) {
          const task = this.store.task(member.task_id), booking = convergenceBooking(task);
          this.store.update(task.id, { reservation: JSON.stringify({ ...booking, run_id: run.id, generation: run.generation }) });
          this.store.event(task.id, 'convergence.member_fixed', { run_id: run.id, generation: run.generation,
            delivery_id: member.delivery_id, source_commit: member.source_commit, base_commit: member.base_commit });
        }
        this.store.event(parent.id, 'convergence.batch_fixed', { run_id: run.id, generation: run.generation,
          baseline, members: selected.map(member => member.task_id) });
        return run;
      });
    });
  },

  async driveConvergence(parentId) {
    if (this.stopping || this.clearing || this.maintenancePaused()) return;
    this.drainConvergenceWithdrawals?.(parentId);
    this.convergenceDrivers ??= new Set(); this.convergenceJobs ??= new Map();
    if (this.convergenceDrivers.has(parentId)) return;
    this.convergenceDrivers.add(parentId); this.convergenceWakePending?.delete(parentId);
    try {
      if (this.convergenceIntegrationCapacity()) {
        for (const waiting of this.store.deliveryRuns(parentId, ['awaiting'], 1000)) {
          const data = convergenceJSON(waiting.data, {});
          if (data.wait_reason === 'integration_slot') this.setConvergenceState(waiting.id, waiting.generation, 'preparing', {
            data: JSON.stringify({ ...data, wait_reason: null }), error: null });
        }
        this.convergenceIntegrationWaitParents?.delete(parentId);
      }
      // Publication reconciliation has priority but does not create an unbounded job pool.
      const active = this.activeConvergenceLanding(parentId);
      if (active) { await this.publishConvergence(active.id); return; }
      for (const run of this.store.deliveryRuns(parentId, preparing, 50)) {
        if (this.convergenceJobs.size >= CONVERGENCE_LIMITS.preparation_concurrency) break;
        this.startConvergenceJob(run.id);
      }
      while (this.convergenceJobs.size < CONVERGENCE_LIMITS.preparation_concurrency) {
        const run = await this.formConvergenceBatch(parentId);
        if (!run) break;
        this.startConvergenceJob(run.id);
      }
      if (this.convergenceJobs.size >= CONVERGENCE_LIMITS.preparation_concurrency)
        this.convergenceWakePending.add(parentId);
    } finally {
      this.convergenceDrivers.delete(parentId);
      // Only a real busy-time signal is replayed here, not a timer/poll of stalled work.
      if (this.convergenceWakePending?.has(parentId)
        && this.convergenceJobs.size < CONVERGENCE_LIMITS.preparation_concurrency)
        this.scheduleConvergence(parentId);
    }
  },

  startConvergenceJob(runId) {
    this.convergenceJobs ??= new Map();
    if (this.convergenceJobs.has(runId) || this.convergenceJobs.size >= CONVERGENCE_LIMITS.preparation_concurrency) return false;
    const run = this.store.deliveryRun(runId), controller = new AbortController();
    if (!run || !preparing.includes(run.state) || (run.state === 'ready' && !this.convergenceCanPublish(run))
      || (run.integration_worker_id && this.running.has(run.integration_worker_id))) return false;
    const job = { controller, promise: null, generation: run.generation }; this.convergenceJobs.set(runId, job);
    job.promise = this.write('prepare a fixed convergence delivery', async () => {
      try {
        if (run.state === 'ready') await this.publishConvergence(run.id);
        else await this.prepareConvergenceRun(run.id, run.generation, controller.signal);
      } catch {
        const live = this.store.deliveryRun(runId);
        if (live?.generation === job.generation && !['integrated', 'withdrawn', 'stale', 'landing', 'blocked'].includes(live.state))
          this.setConvergenceState(run.id, job.generation, 'failed', { error: '归并准备或验证未完成；现场保留，请检查后显式重试。',
            ...(live.state === 'validating' ? { validation_result: { ...convergenceJSON(live.validation_result, {}),
              state: 'unknown', error: 'interrupted' } } : {}) });
      }
    }).finally(() => {
      this.convergenceJobs.delete(runId);
      this.drainConvergenceWithdrawals?.(run.parent_id);
      if (!this.stopping && !this.clearing) {
        this.scheduleTaskMerge(run.parent_id);
        for (const pending of this.convergenceWakePending ?? []) this.scheduleConvergence(pending);
        this.kick();
      }
    });
    return true;
  },

  async retryBranchConvergence(runId, expectedRevision) {
    return this.write('retry a convergence delivery', async () => {
      const run = this.store.deliveryRun(id(runId)); check(run, 'convergence run not found');
      const view = (await this.branchConvergenceRuns(run.target_branch, run.id + 1, 1)).items[0];
      check(view?.id === run.id && typeof expectedRevision === 'string' && view.revision === expectedRevision,
        'convergence revision changed; reload before retrying');
      check(['failed', 'awaiting', 'stale'].includes(run.state) && !run.landing_receipt, 'unknown landing cannot be retried');
      check(!this.convergenceJobs?.has(run.id) && !this.convergenceDrivers?.has(run.parent_id), 'convergence operation is still exiting');
      const helpers = this.store.all(`SELECT * FROM tasks WHERE task_kind='integration' AND EXISTS
        (SELECT 1 FROM events e WHERE e.task_id=tasks.id AND e.type='convergence.integration_created'
          AND json_extract(e.data,'$.run_id')=?)`, run.id);
      check(helpers.every(task => !this.running.has(task.id)), 'integration invocation is still exiting');
      check(helpers.every(task => !this.questionPending(task.id)), 'answer integration questions before retrying');
      this.resolveShortcutCommand(convergenceJSON(run.validation));
      this.assertConvergenceRun(run.id, run.generation, ['failed', 'awaiting', 'stale']);
      await this.refreshConvergenceBaseline(run.id, run.generation, true);
      this.scheduleConvergence(run.parent_id);
      return (await this.branchConvergenceRuns(run.target_branch, run.id + 1, 1)).items[0];
    });
  },
};
