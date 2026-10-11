import { check, TERMINAL } from '../types.js';
import { convergenceJSON, convergenceBooking } from '../convergence-contract.js';
import { convergenceTopology } from '../convergence-plan.js';
import { convergenceHelperContext, convergenceResourceReason } from '../convergence-resources.js';

const done = ['integrated', 'withdrawn', 'stale'];

/** Withdrawal/restart/resource gates do not replay provider or Shell side effects. */
export default {
  convergenceHelpers(runId) {
    return this.store.all(`SELECT * FROM tasks WHERE task_kind='integration' AND EXISTS
      (SELECT 1 FROM events e WHERE e.task_id=tasks.id AND e.type='convergence.integration_created'
      AND json_extract(e.data,'$.run_id')=?) ORDER BY id`, runId);
  },

  assertConvergenceResourcesFree(taskId) {
    const reason = convergenceResourceReason(this, this.store.task(taskId)); check(!reason, reason);
  },

  cancelConvergenceIntegration(taskId, reason, status = 'cancelled') {
    const task = this.store.task(taskId), context = convergenceHelperContext(this.store, task);
    if (TERMINAL.has(task.status)) return task;
    const run = context && this.store.deliveryRun?.(context.run_id);
    check(this.recoveringHooks || !run || !(run.state === 'landing' || (run.state === 'blocked' && run.landing_receipt)),
      'integration output is being published; inspect the exact landing first');
    this.running.get(task.id)?.controller.abort(new Error(reason));
    this.store.transaction(() => {
      this.store.update(task.id, { status, error: reason, interrupt_state: null });
      this.store.armAgent(task.id, null);
      this.store.run("UPDATE notices SET status='dismissed',answer='integration invocation stopped' WHERE task_id=? AND status='open'", task.id);
      this.store.event(task.id, 'convergence.integration_stopped', { run_id: context?.run_id ?? null,
        generation: context?.generation ?? null, status, reason: 'Internal invocation stopped; private worktree retained.' });
      if (run && run.generation === context.generation && !done.includes(run.state)
        && run.state !== 'landing' && !(run.state === 'blocked' && run.landing_receipt)) {
        this.setConvergenceState(run.id, run.generation, 'failed', { error: '整合调用未完成；私有现场保留，请显式检查或重试。' });
      }
    });
    if (run && !this.running.has(task.id)) this.wakeConvergenceAfterIntegration?.(run.parent_id);
    return this.store.task(task.id);
  },

  withdrawConvergenceMember(taskId, reason = 'explicit withdrawal') {
    const task = this.store.task(taskId), booking = convergenceBooking(task);
    check(booking && !['integrated', 'withdrawn'].includes(booking.status), 'fixed convergence delivery is not withdrawable');
    const run = booking.run_id ? this.store.deliveryRun(booking.run_id) : null;
    check(!run || (!run.landing_receipt && run.state !== 'landing'), 'publication has started; inspect its exact result before withdrawal');
    if (!run) {
      this.store.transaction(() => {
        this.store.update(task.id, { reservation: null });
        this.store.event(task.id, 'task.request_withdrawn', { convergence: true, delivery_id: booking.delivery_id, reason });
        this.store.run("UPDATE messages SET consumed=1 WHERE task_id=? AND sender_id=? AND signal_type='merge.requested'", booking.parent_id, task.id);
      });
      this.scheduleTaskMerge(booking.parent_id);
      this.releaseTaskInputs(task.id);
      return { task_id: task.id, reservation: null, changed: true };
    }
    // Invalidate the attempt before aborting anything; old callbacks can no longer advance it.
    const helpers = this.convergenceHelpers(run.id);
    const data = convergenceJSON(run.data, {}), nextGeneration = run.generation + 1;
    this.store.transaction(() => {
      const live = this.store.deliveryRun(run.id);
      check(live?.generation === run.generation && !live.landing_receipt, 'convergence changed during withdrawal');
      const pending = [...new Set([...(data.pending_withdrawals ?? []), task.id])];
      this.store.updateDeliveryRun(run.id, { generation: nextGeneration, state: 'awaiting', error: '正在等待旧调用安全退出后撤回成员。',
        data: JSON.stringify({ ...data, pending_withdrawals: pending, wait_reason: 'withdrawing' }) }, run.generation);
      for (const member of this.store.deliveryMembers(run.id, true)) {
        const source = this.store.task(member.task_id), prior = convergenceBooking(source);
        check(prior?.run_id === run.id, 'convergence member changed');
        this.store.update(source.id, { reservation: JSON.stringify({ ...prior, generation: nextGeneration, status: 'blocked' }) });
      }
      this.store.event(task.id, 'convergence.withdrawal_requested', { run_id: run.id, generation: nextGeneration,
        delivery_id: booking.delivery_id, reason });
    });
    this.convergenceJobs?.get(run.id)?.controller.abort(new Error('fixed member withdrawn'));
    for (const helper of helpers) if (!TERMINAL.has(helper.status) && helper.status !== 'awaiting_acceptance')
      this.cancelConvergenceIntegration(helper.id, 'fixed node invalidated by member withdrawal');
    this.drainConvergenceWithdrawals(run.parent_id);
    return { task_id: task.id, reservation: convergenceBooking(this.store.task(task.id)), changed: true,
      withdrawal_pending: this.store.deliveryMembers(run.id, true).some(member => member.task_id === task.id) };
  },

  drainConvergenceWithdrawals(parentId) {
    if (!this.store.deliveryRuns) return;
    for (const run of this.store.deliveryRuns(parentId, ['awaiting'], 1000)) {
      const data = convergenceJSON(run.data, {});
      if (data.wait_reason !== 'withdrawing' || this.convergenceJobs?.has(run.id)
        || this.convergenceHelpers(run.id).some(task => this.running.has(task.id))) continue;
      const withdrawing = data.pending_withdrawals ?? [];
      this.store.transaction(() => {
        const live = this.store.deliveryRun(run.id); check(live.generation === run.generation, 'withdrawal generation changed');
        for (const taskId of withdrawing) {
          const task = this.store.task(taskId), booking = convergenceBooking(task);
          if (booking?.run_id !== run.id) continue;
          this.store.releaseDeliveryMembers(run.id, taskId);
          this.store.update(taskId, { reservation: null, integration_error: null });
          this.store.event(taskId, 'task.request_withdrawn', { convergence: true, run_id: run.id,
            generation: run.generation, delivery_id: booking.delivery_id });
          this.store.run("UPDATE messages SET consumed=1 WHERE task_id=? AND sender_id=? AND signal_type='merge.requested'", parentId, taskId);
        }
        const remaining = this.store.deliveryMembers(run.id, true);
        const nextData = { ...data, wait_reason: null, pending_withdrawals: [], prepared_receipt: null, root_commit: null,
          ...(remaining.length ? { plan: convergenceTopology(remaining) } : {}) };
        this.store.updateDeliveryRun(run.id, { state: remaining.length ? 'preparing' : 'withdrawn', error: null,
          candidate_commit: null, candidate_tree: null, validation_result: null, integration_worker_id: null,
          data: JSON.stringify(nextData) }, run.generation);
        for (const member of remaining) {
          const task = this.store.task(member.task_id), booking = convergenceBooking(task);
          this.store.update(task.id, { reservation: JSON.stringify({ ...booking, status: 'requested' }), integration_error: null });
        }
      });
      for (const taskId of withdrawing) if (!TERMINAL.has(this.store.task(taskId).status)) this.releaseTaskInputs(taskId);
      if (!this.stopping && !this.clearing) this.scheduleConvergence(parentId);
    }
  },

  recoverConvergence() {
    if (!this.store.deliveryRuns) return;
    const parents = this.store.all(`SELECT DISTINCT json_extract(reservation,'$.parent_id') AS id FROM tasks
      WHERE json_valid(reservation) AND json_extract(reservation,'$.version')=3`);
    for (const parent of parents) {
      if (!parent.id) continue;
      for (const run of this.store.deliveryRuns(parent.id, null, 1000)) {
        if (done.includes(run.state)) continue;
        if (run.state === 'validating') {
          const evidence = convergenceJSON(run.validation_result, {});
          this.setConvergenceState(run.id, run.generation, 'failed', { error: '后台曾中断最终验证；结果未知，不自动重放。',
            validation_result: JSON.stringify({ ...evidence, state: 'unknown', error: '最终验证中断，需显式检查。' }) });
        } else if (run.state === 'resolving') {
          const helper = run.integration_worker_id && this.store.task(run.integration_worker_id);
          // A never-started registered helper is safe to start; an orphan return is not proof of actual exit.
          if (helper && (helper.calls > 0 || helper.status === 'running') && helper.status !== 'awaiting')
            this.setConvergenceState(run.id, run.generation, 'failed', { error: '整合调用退出事实不完整；现场保留，不自动重放。' });
        }
        if (['landing', 'blocked'].includes(run.state) && run.landing_receipt) this.scheduleConvergence(parent.id);
      }
      this.drainConvergenceWithdrawals(parent.id);
      this.scheduleConvergence(parent.id);
    }
  },
};
