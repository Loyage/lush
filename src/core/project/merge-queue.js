import { check, id, TERMINAL } from '../types.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing, consumeIntegratedReservation, taskDeliveryState,
  resumeTaskDelivery, taskSyncDeliveryPaused } from './iteration.js';

const reservationOf = task => task.reservation ? JSON.parse(task.reservation) : null;
const codeTask = task => ['say', 'child'].includes(task.task_kind);

/** New task-owned delivery queue. The task tree is reparented only after a durable request. */
export default {
  /** Persistent hook configuration is separate from the single delivery receipt. */
  autoMergeView(task) {
    if (!codeTask(task)) return null;
    const booking = reservationOf(task);
    if (booking && booking.version !== 2) return null; // historical approval stays historical
    const settings = task.auto_merge ? JSON.parse(task.auto_merge) : null;
    const enabled = settings?.enabled === true, locked = settings?.locked === true;
    let reason = null;
    if (locked) reason = '父任务派生的子 Task 默认自动合并，不能关闭';
    else if (TERMINAL.has(task.status) || task.status === 'awaiting_acceptance') reason = '本轮已交付或任务已结束，不能调整自动合并';
    else if (booking && ['requested','resolving'].includes(booking.status)) reason = '合并请求已发出，不能调整自动合并';
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
    check(before, 'only version 2 say/child Tasks support auto merge');
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
    check(codeTask(task), 'only say/child code Tasks can request a merge');
    this.restoreUnrequestedTaskParent(task.id);
    task = this.store.task(task.id);
    assertTaskAncestorsOpen(this, task);
    assertTaskNotSyncing(this, task.id);
    resumeTaskDelivery(this, task.id, 'explicit merge reservation');
    let previous = reservationOf(task);
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
    check(!TERMINAL.has(task.status), 'ended Tasks cannot request a merge');
    if (!previous) this.store.transaction(() => {
      const current = this.store.task(task.id);
      check(!current.reservation && !TERMINAL.has(current.status),
        'Task changed while reserving merge');
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
    if (previous?.status === 'requested') this.scheduleTaskMerge(previous.parent_id);
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
      const originalParent = this.store.task(prior.parent_id ?? task.parent_id);
      check(['say','child','main','owner'].includes(originalParent.task_kind) && !TERMINAL.has(originalParent.status),
        'merge needs an active direct parent');
      const state = await this.workspaces.branchState(task.branch);
      check(state.parent === originalParent.branch && state.child_head === task.head_commit && state.parent_head,
        'merge source or target moved; inspect the branch');
      check(state.blockers.every(blocker => blocker === `task:#${task.id}`),
        `unintegrated descendants block the request: ${state.blockers.join(', ')}`);
      const delivery = await taskDeliveryState(this, task);
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
        this.noteReservationBlocked(task.id, '没有尚未合入的提交；请继续工作或显式结束这条 Task');
        return false;
      }
      this.store.transaction(() => {
        const live = this.store.task(task.id), pinned = reservationOf(live);
        check(pinned?.version === 2 && pinned.status === 'pending' && live.status === 'waiting'
          && !this.reservationWaitReason(live) && !taskSyncDeliveryPaused(this, live.id)
          && (live.parent_id === originalParent.id || this.store.task(live.parent_id).parent_id === originalParent.id)
          && live.head_commit === state.child_head,
        'merge reservation changed during request');
        const { blocked_reason: _reason, blocked_code: _code, parent_commit: _parentCommit, ...ready } = pinned;
        const request = { ...ready, status: 'requested', commit: state.child_head,
          baseline: state.parent_head, parent_id: originalParent.id, requested_at: new Date().toISOString() };
        this.store.update(task.id, { reservation: JSON.stringify(request) });
        const key = `merge-v2:${task.id}:${state.child_head}`;
        const payload = { branch: task.branch, commit: state.child_head, baseline: state.parent_head };
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
   * (`task.cleanup` / `branch archive`). Idempotent: a Task already under its original parent is left alone.
   *
   * 「原父」只以预约里记下的 `parent_id` 为准，不要求分支还在：用户（或旧版自动归档路径）
   * 已经收走 branch / worktree 的 Task 同样要归位，否则它会永久挂在 merge 队列身份下。
   */
  restoreMergedTaskParent(taskId) {
    const task = this.store.task(id(taskId));
    const booking = reservationOf(task);
    if (booking?.version !== 2 || booking.status !== 'integrated') return false;
    const target = booking.parent_id ?? task.parent_id;
    if (!target || task.parent_id === target) return false;
    check(this.store.task(target), `merged Task #${task.id} has no original parent to return to`);
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
      && (booking.status === 'withdrawn' || (booking.status === 'pending' && !booking.parent_id)))) return false;
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
    this.scheduleTaskMerge(target);
    return true;
  },

  /** Dispatch the parent's merge signal without waking its development Agent. */
  scheduleTaskMerge(parentId) {
    if (this.stopping) return;
    queueMicrotask(() => this.driveTaskMerge(parentId).catch(error => {
      const pending = this.store.get(`SELECT id FROM tasks WHERE json_extract(reservation,'$.version')=2
        AND json_extract(reservation,'$.status')='requested'
        AND json_extract(reservation,'$.parent_id')=? ORDER BY id LIMIT 1`, parentId);
      if (pending) this.store.update(pending.id, { integration_error: error.message.slice(0, 1000) });
      this.store.event(parentId, 'merge.queue_failed', { error: error.message });
      console.error(`merge queue parent #${parentId}: ${error.stack || error}`);
    }));
  },

  async driveTaskMerge(parentId) {
    if (this.stopping) return;
    this.taskMergeBusy ??= new Set();
    if (this.taskMergeBusy.has(parentId)) return;
    this.taskMergeBusy.add(parentId);
    try {
      while (!this.stopping) {
        // The oldest request is the only one allowed to advance this parent's branch.
        const row = this.store.get(`SELECT * FROM tasks WHERE json_extract(reservation,'$.version')=2
          AND json_extract(reservation,'$.status')='requested'
          AND json_extract(reservation,'$.parent_id')=? ORDER BY id LIMIT 1`, parentId);
        if (!row) break;
        const outcome = await this.workspaces.exclusive(async () => {
          const task = this.store.task(row.id), request = reservationOf(task);
          if (request?.status !== 'requested') return 'next';
          const parent = this.store.task(parentId);
          assertTaskAncestorsOpen(this, task);
          check(!TERMINAL.has(parent.status), 'merge parent has ended');
          check(parent.branch === task.target_branch, 'merge request target no longer matches its parent');
          // Never rewrite a branch while its owner still has an invocation. A queued
          // owner is already held by the request's branch freeze: waiting for it to
          // run would deadlock when an urgent message arrives during delivery.
          if (this.running.has(parentId) || parent.status === 'running' || this.taskSyncBusy?.has(parentId)
            || this.taskSyncBusy?.has(task.id) || this.running.has(task.id)) return 'wait';
          let merger = this.store.get("SELECT * FROM tasks WHERE parent_id=? AND task_kind='merge' AND name='merge' ORDER BY id LIMIT 1", parentId);
          if (!merger) merger = this.store.transaction(() => {
            const created = this.store.create({ parent_id: parentId, input_id: parent.input_id, role: 'agent',
              task_kind: 'merge', name: 'merge', goal: `串行处理 Task #${parentId} 的合并请求` });
            this.store.update(created.id, { status: 'waiting', target_branch: parent.branch });
            this.store.event(created.id, 'merge.queue_started', { parent_id: parentId });
            return created;
          });
          if (merger.status === 'completed') this.store.update(merger.id, { status: 'waiting' });
          if (task.parent_id === parentId) this.store.transaction(() => {
            this.store.run("UPDATE tasks SET parent_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND parent_id=?",
              merger.id, task.id, parentId);
            this.store.event(task.id, 'task.reparented_for_merge', { from: parentId, to: merger.id });
          });
          else check(task.parent_id === merger.id, 'requested Task moved outside its merge queue');
          const state = await this.workspaces.branchState(task.branch);
          check(state.parent === parent.branch && state.child_head === request.commit,
            'requested source branch moved; preserve its worktree for inspection');
          check(state.blockers.every(blocker => blocker === `task:#${task.id}`),
            `unintegrated descendants block merge: ${state.blockers.join(', ')}`);
          // Git can succeed immediately before the DB transaction. Recognize only our
          // exact one-parent squash of the pinned request; never replay the commit.
          const previousParent = await this.workspaces.git(this.config.project, 'rev-parse', `${state.parent_head}^`).catch(() => null);
          const previousTitle = await this.workspaces.git(this.config.project, 'log', '-1', '--format=%s', state.parent_head);
          const previousTree = await this.workspaces.git(this.config.project, 'rev-parse', `${state.parent_head}^{tree}`);
          const sourceTree = await this.workspaces.git(this.config.project, 'rev-parse', `${request.commit}^{tree}`);
          const landedPreviously = previousParent === request.baseline && previousTree === sourceTree
            && previousTitle.startsWith(`Merge task #${task.id}: `);
          if (state.status === 'diverged' && !landedPreviously) {
            // This Task, not an unrelated resolver, owns the repair. It runs on its original source branch.
            this.store.transaction(() => {
              const live = reservationOf(this.store.task(task.id));
              this.store.update(task.id, { reservation: JSON.stringify({ ...live, status: 'resolving',
                blocked_reason: `父分支 ${parent.branch} 已分歧；请在自己的分支合入固定父提交 ${state.parent_head}，解决冲突并测试，再重新提交合并请求。`,
                parent_commit: state.parent_head }), status: 'queued' });
              this.store.message(task.id, `合并分歧：请在你的工作区合入固定父提交 ${state.parent_head}（不要修改父分支），解决冲突、测试并提交；完成后自动再次请求合并。`, merger.id);
              this.store.event(task.id, 'merge.divergence_returned', { parent_commit: state.parent_head, merger_id: merger.id });
            });
            this.kick();
            return 'wait';
          }
          // Other pending requests can have gone stale since they were pinned. The first one
          // remains the only writer; a later one will be returned to its own Agent for repair.
          check(landedPreviously || state.status === 'fast_forward' || state.status === 'integrated',
            'merge source is not landable');
          const landed = landedPreviously ? { commit: state.parent_head, already_integrated: true }
            : await this.workspaces.squashBranchUnsafe(task.branch, request.commit, state.parent_head,
              `Merge task #${task.id}: ${task.goal.split('\n')[0].slice(0, 100)}`);
          this.store.transaction(() => {
            const live = this.store.task(task.id), booked = reservationOf(live);
            check(booked?.status === 'requested' && booked.commit === request.commit, 'merge request changed during landing');
            this.store.update(task.id, { status: 'awaiting_acceptance', integration: 'merged', integration_error: null,
              iteration_base_commit: request.commit,
              reservation: JSON.stringify({ ...booked, status: 'integrated', integrated_at: new Date().toISOString(),
                landed_commit: landed.commit }), retry_profile: null });
            this.store.update(parent.id, { head_commit: landed.commit });
            this.store.event(task.id, 'task.merge_integrated', { source_commit: request.commit,
              commit: landed.commit, parent_id: parentId, merger_id: merger.id, squash: true });
            const key = `merge-v2-completed:${task.id}:${landed.commit}`;
            const receipt = this.store.signal(parentId, task.id, 'merge.completed', key,
              JSON.stringify({ version: 1, signal: 'merge.completed', key, source_task_id: task.id,
                target_task_id: parentId, payload: { commit: landed.commit, source_commit: request.commit } }));
            if (receipt.inserted) this.store.event(parentId, 'task.signal', {
              message_id: receipt.id, source_task_id: task.id, signal: 'merge.completed', key });
            this.store.run("UPDATE messages SET consumed=1 WHERE id IN (SELECT id FROM messages WHERE task_id=? AND sender_id=? AND signal_type='merge.requested')",
              parentId, task.id);
          });
          // Deliberately do not archive after landing: return the delivered Task to its original
          // parent and keep its worktree/branch, so the user decides when to reclaim it.
          this.restoreMergedTaskParent(task.id);
          return 'next';
        });
        if (outcome === 'wait') break;
      }
      // A persistent merge identity can be reopened for later requests, but it must not
      // leave an active descendant behind when its parent finishes.
      const merger = this.store.get("SELECT * FROM tasks WHERE parent_id=? AND task_kind='merge' AND name='merge' ORDER BY id LIMIT 1", parentId);
      if (merger?.status === 'waiting' && this.store.children(merger.id).every(child =>
        TERMINAL.has(child.status) && reservationOf(child)?.status !== 'resolving')) {
        this.store.transaction(() => {
          this.store.update(merger.id, { status: 'completed' });
          this.store.event(merger.id, 'merge.queue_idle', { parent_id: parentId });
        });
        if (this.hasActionableMessages(parentId)) this.wake(parentId);
      }
    } finally { this.taskMergeBusy.delete(parentId); this.kick(); }
  },
};
