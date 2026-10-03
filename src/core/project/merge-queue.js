import { check, id, TERMINAL } from '../types.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing, consumeIntegratedReservation, taskDeliveryState,
  resumeTaskDelivery, taskSyncDeliveryPaused } from './iteration.js';

const reservationOf = task => task.reservation ? JSON.parse(task.reservation) : null;
const codeTask = task => ['say', 'child'].includes(task.task_kind);

const ACTIVE = ['executing', 'resolving', 'blocked'];
const FROZEN = ['requested', ...ACTIVE];

/** Parent-owned delivery. Reservations are facts; messages are notifications only. */
export default {
  /** Persistent hook configuration is separate from the single delivery receipt. */
  autoMergeView(task) {
    if (!codeTask(task)) return null;
    const booking = reservationOf(task);
    if (booking && booking.version !== 2) return null; // historical approval stays historical
    const settings = task.auto_merge ? JSON.parse(task.auto_merge) : null;
    const enabled = settings?.enabled === true, locked = settings?.locked === true;
    let reason = null;
    if (locked) reason = '父Worker派生的子Worker默认自动合并，不能关闭';
    else if (TERMINAL.has(task.status) || task.status === 'awaiting_acceptance') reason = '本轮已交付或 Worker 已结束，不能调整自动合并';
    else if (booking && [...FROZEN, 'suspended'].includes(booking.status)) reason = '合并请求已发出，不能调整自动合并';
    else if (this.taskSyncBusy?.has(task.id) || taskSyncDeliveryPaused(this, task.id)) reason = '父分支同步正在执行或交付已暂停，不能调整自动合并';
    else if (this.mergeReadiness(task)?.ready) reason = '本轮开发已完成，请使用合并按钮';
    return { enabled, locked, editable: !reason, reason };
  },

  /** DB-only arming; never revives ended/delivered tasks or withdrawn historical hooks. */
  armTaskAutoMerge(taskId) {
    const task = this.store.task(taskId);
    if (!codeTask(task) || !task.auto_merge || !JSON.parse(task.auto_merge).enabled
      || task.reservation || TERMINAL.has(task.status) || task.status === 'awaiting_acceptance'
      || taskSyncDeliveryPaused(this, task.id)) return false;
    this.store.transaction(() => {
      this.store.update(task.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'pending',
        auto_merge: true, created_at: new Date().toISOString() }) });
      this.store.event(task.id, 'task.reserved', { kind: 'merge', version: 2, via: 'auto_merge' });
    });
    return true;
  },

  async setTaskAutoMerge(taskId, enabled) {
    check(typeof enabled === 'boolean', 'enabled must be a boolean');
    const task = this.store.task(id(taskId));
    const before = this.autoMergeView(task);
    check(before, 'only version 2 say/child Workers support auto merge');
    if (before.enabled === enabled) return { task_id: task.id, changed: false, auto_merge: before };
    check(before.editable, before.reason);
    assertTaskAncestorsOpen(this, task);
    this.store.transaction(() => {
      this.store.update(task.id, { auto_merge: JSON.stringify({ version: 1, enabled, locked: false }) });
      this.store.event(task.id, 'task.auto_merge_changed', { enabled, previous: before.enabled });
      const booking = reservationOf(task);
      if (!enabled && booking?.status === 'pending' && booking.auto_merge === true) {
        this.store.update(task.id, { reservation: null });
        this.store.event(task.id, 'task.unreserved', { reservation: booking, reason: 'auto merge disabled' });
      }
      if (enabled) this.armTaskAutoMerge(task.id);
    });
    if (enabled) await this.settleQueuedMerge(task.id).catch(error => this.noteReservationBlocked(task.id, error.message));
    return { task_id: task.id, changed: true, auto_merge: this.autoMergeView(this.store.task(task.id)) };
  },

  async requestTaskMerge(taskId) {
    let task = this.store.task(id(taskId));
    check(codeTask(task), 'only say/child code Workers can request a merge');
    this.restoreUnrequestedTaskParent(task.id);
    task = this.store.task(task.id);
    assertTaskAncestorsOpen(this, task);
    assertTaskNotSyncing(this, task.id);
    resumeTaskDelivery(this, task.id, 'explicit merge reservation');
    let previous = reservationOf(task);
    if (previous?.status === 'blocked' && previous.landing_receipt) {
      await this.workspaces.exclusive(async () => {
        if (await this.workspaces.verifyTaskSquashUnsafe(previous.landing_receipt)) return;
        await this.workspaces.assertCleanBranches([task.branch, task.target_branch]);
        check(await this.workspaces.workspaceForBranch(task.target_branch) === previous.landing_receipt.workspace,
          'landing target checkout moved; preserve blocked slot');
        const target = await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${task.target_branch}`);
        check(target === previous.baseline, 'unknown parent-side landing effects; preserve blocked slot and inspect Git');
        check(this.store.task(task.id).reservation === task.reservation, 'delivery changed during blocked inspection');
        const { landing_receipt, ...unwritten } = previous;
        this.store.update(task.id, { reservation: JSON.stringify({ ...unwritten, status: 'suspended',
          blocked_reason: '显式复核证明父分支未写入；重新排队' }) });
        this.store.event(task.id, 'merge.unwritten_attempt_released', { attempt_id: previous.attempt_id });
      });
      task = this.store.task(task.id); previous = reservationOf(task);
    }
    if (previous?.status === 'integrated' && !TERMINAL.has(task.status)) {
      check(!this.running.has(task.id), 'Agent is still in flight');
      const state = await this.workspaces.exclusive(async () => {
        await this.workspaces.finish(this.store.task(task.id));
        return taskDeliveryState(this, this.store.task(task.id));
      });
      this.store.update(task.id, { integration: state });
      if (state !== 'pending') return { task_id: task.id, changed: false, reservation: previous };
      this.store.transaction(() => {
        consumeIntegratedReservation(this, this.store.task(task.id), 'new merge reservation');
        this.store.update(task.id, { status: 'waiting' });
      });
      task = this.store.task(task.id); previous = reservationOf(task);
    }
    if (task.status === 'awaiting_acceptance') this.store.update(task.id, { status: 'waiting' });
    check(!previous || (previous.kind === 'merge' && previous.version === 2),
      'another delivery reservation already exists');
    check(!TERMINAL.has(task.status), 'ended Workers cannot request a merge');
    if (!previous) this.store.transaction(() => {
      const current = this.store.task(task.id);
      check(!current.reservation && !TERMINAL.has(current.status),
        'Worker changed while reserving merge');
      this.store.update(task.id, { status: current.status,
        reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'pending',
          created_at: new Date().toISOString() }) });
      this.store.event(task.id, 'task.reserved', { kind: 'merge', version: 2 });
    });
    // A manual request is an independent one-shot intent, not a change to the hook.
    // Keep it even if the user later switches off an unfinished task's hook.
    const intent = reservationOf(this.store.task(task.id));
    if (intent?.status === 'pending' && intent.auto_merge) {
      const { auto_merge: _automatic, ...explicit } = intent;
      this.store.update(task.id, { reservation: JSON.stringify(explicit) });
    }
    if (previous?.status === 'suspended') this.resumeQueuedTaskMerge(task.id);
    if (FROZEN.includes(previous?.status)) this.scheduleTaskMerge(previous.parent_id);
    else await this.settleQueuedMerge(task.id);
    return { task_id: task.id, changed: !previous, reservation: reservationOf(this.store.task(task.id)) };
  },

  async settleQueuedMerge(taskId) {
    const current = this.store.task(taskId);
    const reservation = reservationOf(current);
    if (!codeTask(current) || reservation?.version !== 2 || reservation.status !== 'pending') return false;
    if (taskSyncDeliveryPaused(this, taskId)) return false;
    const reason = this.reservationWaitReason(current);
    if (reason || this.running.has(taskId)) {
      if (reason) this.noteReservationBlocked(taskId, reason);
      return false;
    }
    return this.workspaces.exclusive(async () => {
      let task = this.store.task(taskId);
      if (reservationOf(task)?.status !== 'pending' || taskSyncDeliveryPaused(this, taskId)
        || this.taskSyncBusy?.has(taskId) || this.reservationWaitReason(task) || this.running.has(taskId)) return false;
      await this.workspaces.finish(task);
      task = this.store.task(taskId);
      const prior = reservationOf(task);
      if (prior?.version !== 2 || prior.status !== 'pending' || this.reservationWaitReason(task)
        || taskSyncDeliveryPaused(this, task.id)) return false;
      assertTaskAncestorsOpen(this, task);
      const originalParent = this.store.task(task.parent_id);
      check(!prior.parent_id || prior.parent_id === task.parent_id, 'delivery parent changed');
      check(['say','child','main','owner'].includes(originalParent.task_kind) && !TERMINAL.has(originalParent.status),
        'merge needs an active direct parent');
      const state = await this.workspaces.branchState(task.branch);
      check(state.parent === originalParent.branch && state.child_head === task.head_commit && state.parent_head,
        'merge source or target moved; inspect the branch');
      check(state.blockers.every(blocker => blocker === `task:#${task.id}`),
        `unintegrated descendants block the request: ${state.blockers.join(', ')}`);
      const delivery = await taskDeliveryState(this, task);
      await this.workspaces.assertCleanBranches([task.branch]);
      check(await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${task.branch}`) === state.child_head,
        'source ref moved during safe-point inspection');
      if (delivery !== 'pending' && (task.task_kind === 'child'
        || (prior.auto_merge && task.iteration_base_commit))) {
        // No-change children and automatic follow-ups deliver a result, not an
        // empty Squash. Recheck after Git awaits so new input/disabled hooks win.
        const delivered = this.store.transaction(() => {
          const live = this.store.task(task.id), current = reservationOf(live);
          if (current?.version !== 2 || current.status !== 'pending' || live.head_commit !== task.head_commit
            || this.reservationWaitReason(live) || taskSyncDeliveryPaused(this, live.id)) return false;
          this.store.update(task.id, { reservation: null, status: 'awaiting_acceptance', integration: delivery });
          const settled = this.store.event(task.id, 'task.delivered', { result: task.result, commit: task.head_commit, no_changes: true });
          this.store.event(task.id, 'task.unreserved', { reservation: prior, reason: 'no changes' });
          if (task.task_kind === 'child') {
            const key = `child:${task.id}:delivery:${settled}`;
            const receipt = this.store.signal(originalParent.id, task.id, 'child.completed', key,
              JSON.stringify({ version: 1, signal: 'child.completed', key, source_task_id: task.id,
                target_task_id: originalParent.id, payload: { result: task.result, commit: task.head_commit } }));
            if (receipt.inserted) this.store.event(originalParent.id, 'task.signal', {
              source_task_id: task.id, signal: 'child.completed', key, message_id: receipt.id });
          }
          return true;
        });
        if (delivered && task.task_kind === 'child') this.wake(originalParent.id);
        return delivered;
      }
      if (delivery !== 'pending' || state.status === 'integrated') {
        this.noteReservationBlocked(task.id, '没有尚未合入的提交；请继续工作或显式结束这条 Worker');
        return false;
      }
      this.store.transaction(() => {
        const live = this.store.task(task.id), pinned = reservationOf(live);
        check(pinned?.version === 2 && pinned.status === 'pending' && live.status === 'waiting'
          && !this.reservationWaitReason(live) && !taskSyncDeliveryPaused(this, live.id)
          && live.parent_id === originalParent.id
          && live.head_commit === state.child_head,
        'merge reservation changed during request');
        const { blocked_reason: _reason, blocked_code: _code, parent_commit: _parentCommit, ...ready } = pinned;
        const deliveryId = this.store.event(task.id, 'merge.enqueued', { parent_id: originalParent.id, commit: state.child_head });
        const request = { ...ready, queue_protocol: 1, status: 'requested', commit: state.child_head,
          delivery_id: deliveryId, enqueue_seq: deliveryId, parent_id: originalParent.id,
          requested_at: new Date().toISOString() };
        // A parent baseline belongs to an attempt, never to an enqueue.
        delete request.baseline; delete request.attempt_id; delete request.landing_receipt;
        this.store.update(task.id, { reservation: JSON.stringify(request) });
        const key = `merge-v2:${task.id}:delivery:${deliveryId}`;
        const payload = { branch: task.branch, commit: state.child_head, delivery_id: deliveryId, enqueue_seq: deliveryId };
        const body = JSON.stringify({ version: 1, signal: 'merge.requested', key,
          source_task_id: task.id, target_task_id: originalParent.id, payload });
        const row = this.store.signal(originalParent.id, task.id, 'merge.requested', key, body);
        this.store.event(task.id, 'task.merge_requested', { ...payload, parent_id: originalParent.id, message_id: row.id });
        if (row.inserted) this.store.event(originalParent.id, 'task.signal', {
          source_task_id: task.id, signal: 'merge.requested', key, message_id: row.id });
      });
      this.scheduleTaskMerge(originalParent.id);
      return true;
    });
  },

  /**
   * version 2 integration leaves the worktree and branch in place; unhook the delivered Task from
   * the reusable merge identity and put it back under the parent it was originally delivered to,
   * so the user can inspect it and decide when to archive. Archiving stays an explicit user action
   * (`worker.cleanup` / `branch archive`). Idempotent: a Worker already under its original parent is left alone.
   *
   * 「原父」只以预约里记下的 `parent_id` 为准，不要求分支还在：用户（或旧版自动归档路径）
   * 已经收走 branch / worktree 的 Task 同样要归位，否则它会永久挂在 merge 队列身份下。
   */
  restoreMergedTaskParent(taskId) {
    const task = this.store.task(id(taskId));
    const booking = reservationOf(task);
    if (booking?.version !== 2 || booking.status !== 'integrated') return false;
    const target = booking.parent_id;
    if (!target || task.parent_id === target) return false;
    const parent = this.store.task(target), queue = this.store.task(task.parent_id);
    const auditRow = this.store.get("SELECT data FROM events WHERE task_id=? AND type='task.reparented_for_merge' ORDER BY id DESC LIMIT 1", task.id);
    const audit = auditRow ? JSON.parse(auditRow.data) : null;
    check(queue.task_kind === 'merge' && queue.parent_id === target && audit?.from === target && audit?.to === queue.id
      && task.target_branch === parent.branch, 'cannot restore integrated parent without matching legacy reparent audit');
    this.store.transaction(() => {
      const live = this.store.task(task.id);
      if (live.parent_id === target) return;
      this.store.run("UPDATE tasks SET parent_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
        target, live.id);
      this.store.event(live.id, 'task.merge_parent_restored', { from: live.parent_id, to: target });
    });
    return true;
  },

  /** Repair only detached queue membership, never invent approval or replay an invocation. */
  restoreUnrequestedTaskParent(taskId) {
    const task = this.store.task(id(taskId)), booking = reservationOf(task);
    if (!codeTask(task) || !task.parent_id) return false;
    if (booking && !(booking.version === 2 && booking.kind === 'merge'
      && (['withdrawn','suspended'].includes(booking.status) || (booking.status === 'pending' && !booking.parent_id)))) return false;
    const queue = this.store.task(task.parent_id);
    if (queue.task_kind !== 'merge' || queue.name !== 'merge') return false;
    const row = this.store.get("SELECT data FROM events WHERE task_id=? AND type='task.reparented_for_merge' ORDER BY id DESC LIMIT 1", task.id);
    const audit = row ? JSON.parse(row.data) : null;
    const target = booking?.parent_id ?? audit?.from;
    check(target && audit?.from === target && audit?.to === queue.id && queue.parent_id === target,
      'cannot recover merge parent without matching reparent audit');
    const parent = this.store.task(target);
    check(['say','child','main','owner'].includes(parent.task_kind)
      && parent.branch === task.target_branch && this.store.branch(task.branch)?.parent === parent.branch,
      'cannot recover merge parent: branch ownership changed');
    this.store.transaction(() => {
      this.store.run("UPDATE tasks SET parent_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND parent_id=?",
        target, task.id, queue.id);
      this.store.event(task.id, 'task.merge_parent_restored', { from: queue.id, to: target,
        reason: 'merge request withdrawn or missing' });
    });
    if (!this.store.children(queue.id).length && queue.status !== 'completed') {
      this.store.update(queue.id, { status: 'completed' });
      this.store.event(queue.id, 'merge.queue_idle', { parent_id: target, historical: true });
    }
    this.scheduleTaskMerge(target);
    return true;
  },

  /** Compatibility is audited, never inferred from a branch name or merge identity. */
  recoverTaskDeliveries() {
    for (const task of this.store.tasks()) {
      let booking;
      try { booking = reservationOf(task); }
      catch (error) { this.store.update(task.id, { integration_error: `invalid delivery state: ${error.message}` }); continue; }
      if (!codeTask(task) || booking?.version !== 2 || !FROZEN.includes(booking.status)) continue;
      if (booking.queue_protocol === 1) {
        // A crashed pre-write inspection is safe to suspend; an apply needs exact reconciliation.
        if (booking.status === 'executing' && !booking.landing_receipt)
          this.suspendTaskMerge(task.id, 'daemon interrupted before landing; explicitly requeue');
        if (booking.status === 'resolving' && task.status === 'waiting' && !booking.repair_ready)
          this.suspendTaskMerge(task.id, 'daemon interrupted repair; inspect before requeue');
        if (booking.landing_receipt || (booking.status === 'resolving' && booking.repair_ready))
          this.scheduleTaskMerge(booking.parent_id);
        continue;
      }
      const queue = task.parent_id ? this.store.task(task.parent_id) : null;
      const auditRow = this.store.get("SELECT data FROM events WHERE task_id=? AND type='task.reparented_for_merge' ORDER BY id DESC LIMIT 1", task.id);
      const audit = auditRow ? JSON.parse(auditRow.data) : null;
      const parentId = booking.parent_id;
      try {
        check(parentId, 'legacy delivery lacks explicit original parent');
        const parent = this.store.task(parentId);
        check(parent.branch === task.target_branch && this.store.branch(task.branch)?.parent === parent.branch,
          'legacy delivery parent ownership mismatch');
        if (task.parent_id !== parentId) {
          check(queue?.task_kind === 'merge' && queue.parent_id === parentId
            && audit?.from === parentId && audit?.to === queue.id, 'legacy delivery lacks matching reparent audit');
          this.store.run('UPDATE tasks SET parent_id=? WHERE id=? AND parent_id=?', parentId, task.id, queue.id);
          this.store.event(task.id, 'task.merge_parent_restored', { from: queue.id, to: parentId, reason: 'legacy in-flight compatibility' });
          if (!this.store.children(queue.id).length) this.store.update(queue.id, { status: 'completed' });
        }
        // An old implementation may have committed before recording its DB receipt.
        // Leave the old baseline intact until a read-only exact legacy check has completed.
        void this.workspaces.exclusive(async () => {
          const live = this.store.task(task.id), old = reservationOf(live);
          if (old?.queue_protocol === 1 || !FROZEN.includes(old?.status)) return;
          const tip = await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${parent.branch}`);
          const parents = await this.workspaces.git(this.config.project, 'show', '-s', '--format=%P', tip);
          const title = await this.workspaces.git(this.config.project, 'show', '-s', '--format=%s', tip);
          const tree = await this.workspaces.commitTree(tip);
          const sourceTree = await this.workspaces.commitTree(old.commit);
          // Historical titles are recovery credentials, not display labels; keep the task marker.
          const matches = old.baseline && parents === old.baseline && tree === sourceTree
            && title === `Merge task #${task.id}: ${task.goal.split('\n')[0].slice(0, 100)}`;
          const now = this.store.task(task.id);
          check(now.reservation === live.reservation && now.parent_id === parentId, 'legacy delivery changed during recovery');
          const deliveryId = this.store.event(task.id, 'merge.legacy_queue_recovered', { parent_id: parentId, landed: matches });
          const requestEvent = this.store.get("SELECT id FROM events WHERE task_id=? AND type='task.merge_requested' ORDER BY id DESC LIMIT 1", task.id);
          const converted = { ...old, queue_protocol: 1, delivery_id: deliveryId, enqueue_seq: requestEvent?.id ?? deliveryId,
            status: old.status === 'resolving' ? 'suspended' : 'requested' };
          delete converted.baseline; delete converted.parent_commit;
          if (matches) {
            const workspace = await this.workspaces.workspaceForBranch(parent.branch);
            check(this.store.task(task.id).reservation === live.reservation, 'legacy delivery changed while identifying checkout');
            const attemptId = this.store.event(task.id, 'merge.legacy_landing_identified', { commit: tip, baseline: old.baseline });
            Object.assign(converted, { status: 'blocked', attempt_id: attemptId, baseline: old.baseline,
              landing_receipt: { child: task.branch, source: old.commit, commit: tip, baseline: old.baseline,
                tree: sourceTree, parent: parent.branch, workspace } });
            // Preserve exact credentials even when source or target is dirty/drifted.
          }
          this.store.update(task.id, { reservation: JSON.stringify(converted) });
          this.scheduleTaskMerge(parentId);
        }).catch(error => this.store.update(task.id, { integration_error: `legacy delivery recovery blocked: ${error.message}` }));
      } catch (error) { this.store.update(task.id, { integration_error: error.message }); }
    }
  },

  /** Dispatch the parent's merge signal without waking its development Agent. */
  scheduleTaskMerge(parentId) {
    if (this.stopping || !parentId) return;
    // A signal delivered while the driver awaits Git must survive a busy early return.
    (this.taskMergeWakePending ??= new Set()).add(parentId);
    queueMicrotask(() => this.driveTaskMerge(parentId).catch(error => {
      const pending = this.store.get(`SELECT id FROM tasks WHERE json_valid(reservation) AND json_extract(reservation,'$.version')=2
        AND json_extract(reservation,'$.status')='requested'
        AND json_extract(reservation,'$.parent_id')=? ORDER BY id LIMIT 1`, parentId);
      if (pending) this.store.update(pending.id, { integration_error: error.message.slice(0, 1000) });
      this.store.event(parentId, 'merge.queue_failed', { error: error.message });
      console.error(`merge queue parent #${parentId}: ${error.stack || error}`);
    }));
  },

  /** Persistent logical owner, unlike the short-lived global Git queue. */
  activeTaskMerge(parentId) {
    return this.store.get(`SELECT * FROM tasks WHERE json_valid(reservation) AND json_extract(reservation,'$.version')=2
      AND json_extract(reservation,'$.parent_id')=?
      AND json_extract(reservation,'$.status') IN ('executing','resolving','blocked')
      ORDER BY json_extract(reservation,'$.attempt_id'),id LIMIT 1`, parentId);
  },

  /** Explicit suspension invalidates old repair responses and releases only an unwritten target. */
  suspendTaskMerge(taskId, reason) {
    const task = this.store.task(taskId), booking = reservationOf(task);
    if (booking?.version !== 2 || !['requested','executing','resolving'].includes(booking.status)) return false;
    check(!booking.landing_receipt, 'landing may have modified the parent; preserve its execution slot');
    this.store.transaction(() => {
      this.store.update(task.id, { reservation: JSON.stringify({ ...booking, status: 'suspended',
        repair_ready: false, blocked_reason: reason }) });
      this.store.event(task.id, 'merge.attempt_suspended', { delivery_id: booking.delivery_id,
        attempt_id: booking.attempt_id, reason });
      this.store.run("UPDATE messages SET consumed=1 WHERE task_id=? AND signal_type='merge.repair'", task.id);
    });
    this.scheduleTaskMerge(booking.parent_id);
    return true;
  },

  resumeQueuedTaskMerge(taskId) {
    const task = this.store.task(taskId), booking = reservationOf(task);
    if (booking?.version !== 2 || booking.status !== 'suspended') return false;
    const { baseline, attempt_id, landing_receipt, parent_commit, repair_ready, repair_run_id, blocked_reason,
      enqueue_seq, delivery_id, original_commit, ...intent } = booking;
    this.store.update(task.id, { reservation: JSON.stringify({ ...intent, status: 'pending' }) });
    this.store.event(task.id, 'merge.attempt_resumed', { previous_delivery_id: delivery_id, previous_attempt_id: attempt_id });
    return true;
  },

  /** Guard after every asynchronous inspection, and immediately before the Git write. */
  assertTaskMergeAttempt(taskId, attemptId, allowRepair = false) {
    const task = this.store.task(taskId), request = reservationOf(task);
    check(request?.attempt_id === attemptId && ['executing', ...(allowRepair ? ['resolving','blocked'] : [])].includes(request.status),
      'delivery attempt changed or was cancelled');
    const parent = this.store.task(request.parent_id);
    check(!TERMINAL.has(task.status) && !TERMINAL.has(parent.status)
      && task.parent_id === parent.id && task.target_branch === parent.branch, 'delivery identities changed');
    check(!this.running.has(parent.id) && parent.status !== 'running' && !this.running.has(task.id)
      && !this.taskSyncBusy?.has(parent.id) && !this.taskSyncBusy?.has(task.id), 'delivery invocation/sync still in flight');
    check(!this.reservationWaitReason(task), this.reservationWaitReason(task) || 'source no longer idle');
    const owner = this.activeTaskMerge(parent.id);
    check(owner?.id === task.id, 'parent execution slot changed');
    return { task, request, parent };
  },

  async readTaskMergeParentHead(task, landedCommit) {
    const head = await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${task.target_branch}`);
    await this.workspaces.assertCleanBranches([task.target_branch]);
    check(await this.workspaces.isAncestor(this.config.project, landedCommit, head),
      'exact landed commit no longer survives on parent');
    check(await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${task.target_branch}`) === head,
      'parent ref moved during delivery reconciliation');
    return head;
  },

  finalizeTaskMerge(taskId, attemptId, landedCommit, parentHead = landedCommit) {
    this.store.transaction(() => {
      const { task, request, parent } = this.assertTaskMergeAttempt(taskId, attemptId, true);
      this.store.update(task.id, { status: 'awaiting_acceptance', integration: 'merged', integration_error: null,
        iteration_base_commit: request.commit, retry_profile: null,
        reservation: JSON.stringify({ ...request, status: 'integrated', landed_commit: landedCommit,
          integrated_at: new Date().toISOString() }) });
      this.store.update(parent.id, { head_commit: parentHead });
      this.store.event(task.id, 'task.merge_integrated', { source_commit: request.commit, commit: landedCommit,
        parent_head: parentHead, parent_id: parent.id, delivery_id: request.delivery_id, attempt_id: attemptId, squash: true });
      const key = `merge-v2-completed:${task.id}:${request.delivery_id}:${attemptId}`;
      const receipt = this.store.signal(parent.id, task.id, 'merge.completed', key,
        JSON.stringify({ version: 1, signal: 'merge.completed', key, source_task_id: task.id,
          target_task_id: parent.id, payload: { commit: landedCommit, parent_head: parentHead, source_commit: request.commit,
            delivery_id: request.delivery_id, attempt_id: attemptId } }));
      if (receipt.inserted) this.store.event(parent.id, 'task.signal', { message_id: receipt.id,
        source_task_id: task.id, signal: 'merge.completed', key });
      this.store.run("UPDATE messages SET consumed=1 WHERE task_id=? AND sender_id=? AND signal_type='merge.requested'", parent.id, task.id);
    });
  },

  async driveTaskMerge(parentId) {
    if (this.stopping || !parentId) return;
    this.taskMergeBusy ??= new Set();
    if (this.taskMergeBusy.has(parentId)) return;
    this.taskMergeBusy.add(parentId);
    this.taskMergeWakePending?.delete(parentId); // consume only after actually acquiring the driver
    let landed = false, taskId = null;
    try {
      await this.workspaces.exclusive(async () => {
        let row = this.activeTaskMerge(parentId);
        const parent = this.store.task(parentId);
        // The parent itself may be a frozen source in an upward delivery. Its
        // fixed tree cannot simultaneously accept a descendant landing.
        if (FROZEN.includes(reservationOf(parent)?.status)) return;
        const foreignLock = this.branchFreeze(parent.branch);
        if (foreignLock && (!row || foreignLock.task_id !== row.id || foreignLock.kind !== 'delivery')) return;
        if (!row) {
          // Each landing is a scheduling boundary: urgent ordinary input gets its turn.
          if (this.hasActionableMessages(parentId) && ['say','child'].includes(parent.task_kind)) {
            this.wake(parentId); return;
          }
          const candidates = this.store.all(`SELECT * FROM tasks WHERE json_valid(reservation) AND json_extract(reservation,'$.version')=2
            AND json_extract(reservation,'$.status')='requested'
            AND json_extract(reservation,'$.parent_id')=?
            ORDER BY json_extract(reservation,'$.enqueue_seq'),id`, parentId);
          row = candidates.find(candidate => this.store.deps(candidate.id).filter(edge => edge.kind === 'code')
            .every(edge => this.store.task(edge.depends_on).integration === 'merged'));
        }
        if (!row) return;
        taskId = row.id;
        let task = this.store.task(row.id), request = reservationOf(task);
        if (!FROZEN.includes(request?.status) || request.queue_protocol !== 1) return;
        if (this.running.has(parentId) || parent.status === 'running' || this.taskSyncBusy?.has(parentId)
          || this.running.has(task.id) || this.taskSyncBusy?.has(task.id)) return;
        check(!TERMINAL.has(parent.status) && parent.branch === task.target_branch, 'delivery parent changed or ended');
        assertTaskAncestorsOpen(this, task);
        if (request.status === 'resolving' && !request.repair_ready) return;
        if (request.status === 'requested') {
          // Acquire the persistent writer slot synchronously BEFORE inspecting Git.
          check(task.parent_id === parent.id, 'legacy reparented delivery needs audited recovery');
          const attemptId = this.store.event(task.id, 'merge.attempt_started', { delivery_id: request.delivery_id, parent_id: parentId });
          request = { ...request, status: 'executing', attempt_id: attemptId, original_commit: request.commit };
          this.store.update(task.id, { reservation: JSON.stringify(request) });
        }
        if (request.landing_receipt) {
          // Exact Git/DB recovery. Never replay an apply whose side effects are unknown.
          check(await this.workspaces.verifyTaskSquashUnsafe(request.landing_receipt),
            'unconfirmed landing: preserve parent worktree and execution slot; inspect Git');
          await this.workspaces.assertCleanBranches([task.branch]);
          check(await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${task.branch}`) === request.commit,
            'landed source ref drifted; preserve exact receipt and inspect');
          const parentHead = await this.readTaskMergeParentHead(task, request.landing_receipt.commit);
          check(await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${task.branch}`) === request.commit,
            'landed source ref drifted during parent reconciliation');
          this.assertTaskMergeAttempt(task.id, request.attempt_id, true);
          this.finalizeTaskMerge(task.id, request.attempt_id, request.landing_receipt.commit, parentHead);
          landed = true; return;
        }
        const state = await this.workspaces.branchState(task.branch);
        this.assertTaskMergeAttempt(task.id, request.attempt_id, true);
        check(state.parent === parent.branch && state.child_head === (request.repair_ready ? task.head_commit : request.commit),
          'requested source/target moved; preserve its worktree');
        check(state.blockers.every(blocker => blocker === `task:#${task.id}`), `unintegrated descendants: ${state.blockers.join(', ')}`);
        await this.workspaces.assertCleanBranches([task.branch, parent.branch]);
        this.assertTaskMergeAttempt(task.id, request.attempt_id, true);
        if (!request.baseline) {
          request = { ...request, baseline: state.parent_head };
          this.store.update(task.id, { reservation: JSON.stringify(request) });
          this.store.event(task.id, 'merge.baseline_fixed', { attempt_id: request.attempt_id, baseline: request.baseline });
        }
        check(state.parent_head === request.baseline, 'fixed parent baseline drifted externally; suspend and retry on a new baseline');
        if (request.repair_ready) {
          check(await this.workspaces.isAncestor(this.config.project, request.original_commit, task.head_commit)
            && await this.workspaces.isAncestor(this.config.project, request.baseline, task.head_commit),
            'repair must preserve both original source and fixed parent commits');
          this.assertTaskMergeAttempt(task.id, request.attempt_id, true);
          request = { ...request, status: 'executing', commit: task.head_commit, repair_ready: false };
          this.store.update(task.id, { reservation: JSON.stringify(request) });
        }
        if (state.status === 'diverged' && !request.repair_run_id) {
          this.assertTaskMergeAttempt(task.id, request.attempt_id);
          const key = `merge-repair:${request.delivery_id}:${request.attempt_id}`;
          const payload = { delivery_id: request.delivery_id, attempt_id: request.attempt_id,
            source_commit: request.original_commit, parent_commit: request.baseline };
          this.store.transaction(() => {
            this.store.update(task.id, { status: 'queued', reservation: JSON.stringify({ ...request, status: 'resolving',
              parent_commit: request.baseline, blocked_reason: `源侧修复固定父提交 ${request.baseline}，父执行位保留` }) });
            this.store.signal(task.id, parentId, 'merge.repair', key, JSON.stringify({ version: 1, signal: 'merge.repair', key,
              source_task_id: parentId, target_task_id: task.id, payload: {
                instruction: `合并分歧：请在你的工作区合入固定父提交 ${request.baseline}，保留原源提交 ${request.original_commit}，`
                  + `合入前先查看双方从共同祖先以来的提交和 diff（含改名），检查自己的改动是否需要跟随父侧的改名、接口迁移或架构重构，`
                  + `即使没有文本冲突也要做语义迁移检查；再解决冲突、适配、测试并提交，结果说明检查结论与未验证风险；不要修改父分支。`
                  + `交付 ${request.delivery_id} 尝试 ${request.attempt_id}。`, ...payload } }));
            this.store.event(task.id, 'merge.divergence_returned', payload);
          });
          this.kick(); return;
        }
        check(state.status === 'fast_forward' || state.status === 'integrated', 'source is not landable after repair');
        // Keep the established Squash policy: an equal source/parent tree needs no empty commit.
        const sourceTree = await this.workspaces.commitTree(request.commit);
        if (sourceTree === await this.workspaces.commitTree(request.baseline)) {
          await this.workspaces.assertCleanBranches([task.branch, parent.branch]);
          check(await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${parent.branch}`) === request.baseline
            && await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${task.branch}`) === request.commit,
            'equal-tree source/target moved during inspection');
          this.assertTaskMergeAttempt(task.id, request.attempt_id);
          this.store.event(task.id, 'merge.tree_already_present', { attempt_id: request.attempt_id, tree: sourceTree,
            source_commit: request.commit, parent_commit: request.baseline });
          this.finalizeTaskMerge(task.id, request.attempt_id, request.baseline);
          landed = true; return;
        }
        const receipt = await this.workspaces.prepareTaskSquashUnsafe(task.branch, request.commit, request.baseline,
          `Merge task #${task.id}: ${task.goal.split('\n')[0].slice(0, 100)} [delivery ${request.delivery_id}, attempt ${request.attempt_id}]`);
        this.assertTaskMergeAttempt(task.id, request.attempt_id);
        // Persist exact SHA before ANY parent mutation (the Git/DB double-write window).
        request = { ...request, landing_receipt: receipt };
        this.store.update(task.id, { reservation: JSON.stringify(request) });
        this.store.event(task.id, 'merge.landing_prepared', { delivery_id: request.delivery_id, attempt_id: request.attempt_id, receipt });
        await this.workspaces.applyTaskSquashUnsafe(receipt, () => this.assertTaskMergeAttempt(task.id, request.attempt_id));
        const parentHead = await this.readTaskMergeParentHead(task, receipt.commit);
        check(await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${task.branch}`) === request.commit,
          'source ref drifted during landing reconciliation');
        this.finalizeTaskMerge(task.id, request.attempt_id, receipt.commit, parentHead);
        landed = true;
      });
    } catch (error) {
      if (taskId) {
        const task = this.store.task(taskId), request = reservationOf(task);
        if (ACTIVE.includes(request?.status)) {
          if (request.landing_receipt) {
            this.store.update(taskId, { reservation: JSON.stringify({ ...request, status: 'blocked', blocked_reason: error.message }),
              integration_error: error.message });
            this.store.event(taskId, 'merge.landing_blocked', { attempt_id: request.attempt_id, error: error.message });
          } else this.suspendTaskMerge(taskId, error.message);
        }
      }
      this.store.event(parentId, 'merge.queue_failed', { task_id: taskId, error: error.message });
    } finally {
      this.taskMergeBusy.delete(parentId);
      if (landed && this.hasActionableMessages(parentId)) this.wake(parentId);
      const pendingWake = this.taskMergeWakePending?.delete(parentId);
      if (landed || pendingWake) this.scheduleTaskMerge(parentId); // drain a busy-time signal at the item boundary
      this.kick();
    }
  },
};
