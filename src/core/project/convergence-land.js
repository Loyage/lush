import { check, TERMINAL } from '../types.js';
import { convergenceJSON, convergenceBooking, convergenceVerificationMode } from '../convergence-contract.js';

const fixed = ['requested', 'executing', 'resolving', 'blocked'];

/** Short real-parent write gate. Legacy v2 and convergence inspect it inside the same Git queue. */
export default {
  activeConvergenceLanding(parentId) {
    return this.store.deliveryRuns(parentId, ['landing', 'blocked'], 1000)
      .find(run => this.convergenceExecutionRetired(run)
        ? Boolean(run.landing_receipt) : run.state === 'landing' || run.landing_receipt) ?? null;
  },

  /** Missing historical publication facts cannot authorize a competing parent write. */
  retiredConvergenceParentBlocked(parentId) {
    const rows = this.store.all(`SELECT id,reservation FROM tasks WHERE json_valid(reservation)
      AND json_extract(reservation,'$.version')=3 AND json_extract(reservation,'$.parent_id')=?
      AND json_extract(reservation,'$.status') IN ('executing','blocked')`, parentId);
    return rows.some(task => {
      if (!this.store.executionRetired(task.id)) return false;
      const request = convergenceJSON(task.reservation);
      const run = Number.isSafeInteger(request.run_id) && request.run_id > 0 ? this.store.deliveryRun(request.run_id) : null;
      return !run || run.parent_id !== parentId;
    });
  },

  nextConvergenceLanding(parentId) {
    if (this.retiredConvergenceParentBlocked(parentId)) return null;
    const candidates = this.store.deliveryRuns(parentId, ['ready'], 1000).filter(run => !this.convergenceExecutionRetired(run));
    return candidates.map(run => ({ run, sequence: Math.min(...this.store.deliveryMembers(run.id, true).map(member => member.enqueue_seq)) }))
      .filter(item => Number.isFinite(item.sequence)).sort((a, b) => a.sequence - b.sequence || a.run.id - b.run.id)[0] ?? null;
  },

  convergenceCanPublish(run) {
    const parent = this.store.task(run.parent_id), upward = convergenceJSON(parent.reservation);
    if (this.stopping || this.clearing || this.maintenancePaused() || this.convergenceExecutionRetired(run) || TERMINAL.has(parent.status)
      || parent.branch !== run.target_branch || fixed.includes(upward?.status) || this.retiredConvergenceParentBlocked(parent.id)
      || this.running.has(parent.id) || parent.status === 'running' || this.taskSyncBusy?.has(parent.id)
      || this.commandHookRunning?.has(parent.id) || this.taskMergeBusy?.has(parent.id)
      || (run.integration_worker_id && this.running.has(run.integration_worker_id))) return false;
    const old = this.activeTaskMerge(parent.id), active = this.activeConvergenceLanding(parent.id);
    if (old || (active && active.id !== run.id)) return false;
    const freeze = this.branchFreeze(parent.branch);
    if (freeze && !(freeze.kind === 'convergence' && freeze.run_id === run.id)) return false;
    if (['order', 'child'].includes(parent.task_kind) && this.hasActionableMessages(parent.id)) { this.wake(parent.id); return false; }
    if (run.state === 'ready') {
      const next = this.nextConvergenceLanding(parent.id);
      if (next && next.run.id !== run.id) return false;
      const oldCandidates = this.store.all(`SELECT id,reservation FROM tasks WHERE json_valid(reservation)
        AND json_extract(reservation,'$.version')=2 AND json_extract(reservation,'$.status')='requested'
        AND json_extract(reservation,'$.parent_id')=? ORDER BY json_extract(reservation,'$.enqueue_seq'),id`, parent.id);
      const first = oldCandidates.find(task => !this.store.executionRetired(task.id) && this.store.deps(task.id).filter(edge => edge.kind === 'code')
        .every(edge => this.store.task(edge.depends_on).integration === 'merged'));
      if (first && convergenceJSON(first.reservation).enqueue_seq < next?.sequence) return false;
    }
    return true;
  },

  finalizeConvergence(runId, generation, receipt, parentHead) {
    const memberEvents = [];
    this.store.transaction(() => {
      const { run, parent, members } = this.assertConvergenceRun(runId, generation, ['landing', 'blocked']);
      check(run.landing_receipt === JSON.stringify(receipt) && run.candidate_commit === receipt.commit
        && run.candidate_tree === receipt.tree && run.baseline === receipt.baseline,
        'exact convergence publication receipt changed');
      for (const member of members) {
        const task = this.store.task(member.task_id), booking = convergenceBooking(task);
        this.store.update(task.id, { status: 'awaiting_acceptance', integration: 'merged', integration_error: null,
          iteration_base_commit: member.source_commit, reservation: JSON.stringify({ ...booking, status: 'integrated',
            landed_commit: receipt.commit, integrated_at: new Date().toISOString() }) });
        const event = this.store.event(task.id, 'task.merge_integrated', { convergence: true, run_id: runId, generation,
          source_commit: member.source_commit, commit: receipt.commit, tree: receipt.tree, parent_head: parentHead,
          parent_id: parent.id, delivery_id: member.delivery_id, squash: true, batch_receipt: receipt });
        this.recordCompletionDelivery(task.id, event); memberEvents.push({ task_id: task.id, event_id: event });
        this.store.run("UPDATE messages SET consumed=1 WHERE task_id=? AND sender_id=? AND signal_type='merge.requested'", parent.id, task.id);
      }
      this.store.update(parent.id, { head_commit: parentHead });
      this.store.updateDeliveryRun(runId, { state: 'integrated', error: null }, generation);
      this.store.releaseDeliveryMembers(runId);
      // Exactly one real parent Hook observation/submission per batch, not one per member.
      const received = this.store.event(parent.id, 'worker.merge_received', { convergence: true, run_id: runId, generation,
        commit: receipt.commit, source_worker_ids: memberEvents.map(item => item.task_id), source_events: memberEvents });
      this.submitMergeReceivedCommandHooks(parent.id, received);
      this.emitTaskHook(parent.id, 'worker.merge_received', received);
      const key = `convergence-completed:${runId}:${generation}`;
      const message = this.store.signal(parent.id, null, 'merge.completed', key, JSON.stringify({ version: 1, signal: 'merge.completed', key,
        source_task_id: null, target_task_id: parent.id, payload: { run_id: runId, generation,
          commit: receipt.commit, members: memberEvents.map(item => item.task_id) } }));
      if (message.inserted) this.store.event(parent.id, 'task.signal', { signal: 'merge.completed', key, message_id: message.id });
    });
    for (const item of memberEvents) { this.emitTaskHook(item.task_id, 'delivery.integrated'); this.scheduleTaskCompletion(item.task_id); }
    this.scheduleTaskHooks();
    return memberEvents;
  },

  async publishConvergence(runId) {
    let run = this.store.deliveryRun(runId);
    if (!run || !['ready', 'landing', 'blocked'].includes(run.state) || !this.convergenceCanPublish(run)) return false;
    let refix = false, landed = false;
    try {
      await this.workspaces.exclusive(async () => {
        run = this.store.deliveryRun(runId);
        if (!this.convergenceCanPublish(run)) return;
        let { parent, members } = this.assertConvergenceRun(runId, run.generation, ['ready', 'landing', 'blocked']);
        let receipt = convergenceJSON(run.landing_receipt);
        if (!receipt) {
          this.assertConvergenceCommand(run);
          if (convergenceVerificationMode(convergenceJSON(run.data, {}).verification_mode, run.validation) === 'command') {
            const evidence = convergenceJSON(run.validation_result);
            check(evidence?.state === 'passed' && evidence.tested_commit === run.candidate_commit
              && evidence.tested_tree === run.candidate_tree, 'exact final convergence tree has not passed validation');
          } else check(run.validation_result === null, 'agent convergence cannot claim runtime command validation');
          const tip = await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${parent.branch}`);
          this.assertConvergenceRun(runId, run.generation, ['ready']);
          if (tip !== run.baseline) { refix = true; return; }
          await this.workspaces.assertCleanBranches([parent.branch, ...members.map(member => member.source_branch)]);
          if (!this.convergenceCanPublish(run)) return;
          receipt = convergenceJSON(run.data, {}).prepared_receipt;
          check(receipt?.commit === run.candidate_commit && receipt.tree === run.candidate_tree && receipt.baseline === run.baseline
            && receipt.run_id === runId && receipt.generation === run.generation, 'prepared publication receipt changed');
          // Persist exact parent object and all fixed members before the first target-side mutation.
          this.setConvergenceState(runId, run.generation, 'landing', { landing_receipt: JSON.stringify(receipt) });
          this.store.event(parent.id, 'convergence.landing_prepared', { run_id: runId, generation: run.generation, receipt });
          await this.workspaces.applyConvergencePublishUnsafe(receipt, () => {
            this.assertConvergenceRun(runId, run.generation, ['landing']);
            this.assertConvergenceCommand(this.store.deliveryRun(runId));
            check(this.convergenceCanPublish(this.store.deliveryRun(runId)), 'parent publication gate changed');
          });
        }
        // Recovery proves the exact prepared object. Never repeat an unknown apply.
        check(await this.workspaces.verifyConvergencePublishUnsafe(receipt), 'convergence publication effects are unconfirmed');
        const parentHead = await this.readTaskMergeParentHead({ target_branch: parent.branch }, receipt.commit);
        for (const member of members) {
          await this.workspaces.assertCleanBranches([member.source_branch]);
          check(await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${member.source_branch}`) === member.source_commit,
            'fixed convergence source changed after publication');
        }
        check(this.convergenceCanPublish(this.store.deliveryRun(runId)), 'parent publication gate changed during reconciliation');
        this.finalizeConvergence(runId, run.generation, receipt, parentHead); landed = true;
      });
    } catch {
      const live = this.store.deliveryRun(runId);
      if (live?.generation === run.generation && live.state !== 'integrated')
        this.setConvergenceState(runId, run.generation, live.landing_receipt ? 'blocked' : 'failed', {
          error: live.landing_receipt ? '父侧发布结果待精确核验；现场与写门保留，禁止盲重放。' : '发布前检查未通过；未写入真实父分支。' });
    }
    if (refix) await this.refreshConvergenceBaseline(runId, run.generation);
    if (landed && !this.stopping) {
      for (const member of this.store.deliveryMembers(runId)) this.releaseTaskInputs(member.task_id);
      this.releaseTaskInputs(run.parent_id);
      await this.runParentReadyHooks(run.parent_id);
      this.scheduleTaskMerge(run.parent_id);
      if (this.hasActionableMessages(run.parent_id)) this.wake(run.parent_id);
    }
    return landed;
  },
};
