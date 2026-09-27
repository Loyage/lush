import { check, id, TERMINAL } from '../types.js';

const reservationOf = task => task.reservation ? JSON.parse(task.reservation) : null;
const codeTask = task => ['say', 'child'].includes(task.task_kind);

/** New task-owned delivery queue. The task tree is reparented only after a durable request. */
export default {
  async requestTaskMerge(taskId) {
    const task = this.store.task(id(taskId));
    check(codeTask(task), 'only say/child code Tasks can request a merge');
    const previous = reservationOf(task);
    const showcased = task.task_kind === 'say' && task.status === 'completed'
      && (!previous || (previous.kind === 'showcase' && previous.status === 'completed'))
      && task.integration === 'pending';
    check(!previous || showcased || (previous.kind === 'merge' && previous.version === 2),
      'another delivery reservation already exists');
    check(showcased || !TERMINAL.has(task.status), 'ended Tasks cannot request a merge');
    check(previous?.status !== 'integrated', 'this Task is already integrated');
    if (!previous || showcased) this.store.transaction(() => {
      const current = this.store.task(task.id);
      check((showcased && current.status === 'completed') || (!current.reservation && !TERMINAL.has(current.status)),
        'Task changed while reserving merge');
      this.store.update(task.id, { status: showcased ? 'waiting' : current.status,
        reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'pending',
          created_at: new Date().toISOString() }) });
      if (showcased) this.store.event(task.id, 'task.delivery_reopened', { reason: 'showcase completed; automatic merge requested' });
      this.store.event(task.id, 'task.reserved', { kind: 'merge', version: 2 });
    });
    if (previous?.status === 'requested') this.scheduleTaskMerge(previous.parent_id);
    else await this.settleQueuedMerge(task.id);
    return { task_id: task.id, changed: !previous || showcased, reservation: reservationOf(this.store.task(task.id)) };
  },

  async settleQueuedMerge(taskId) {
    const current = this.store.task(taskId);
    const reservation = reservationOf(current);
    if (!codeTask(current) || reservation?.version !== 2 || reservation.status !== 'pending') return false;
    const reason = this.reservationWaitReason(current);
    if (reason || this.running.has(taskId)) {
      if (reason) this.noteReservationBlocked(taskId, reason);
      return false;
    }
    return this.workspaces.exclusive(async () => {
      let task = this.store.task(taskId);
      if (reservationOf(task)?.status !== 'pending' || this.reservationWaitReason(task) || this.running.has(taskId)) return false;
      await this.workspaces.finish(task);
      task = this.store.task(taskId);
      const prior = reservationOf(task);
      const originalParent = this.store.task(prior.parent_id ?? task.parent_id);
      check(['say','child','main','owner'].includes(originalParent.task_kind) && !TERMINAL.has(originalParent.status),
        'merge needs an active direct parent');
      const state = await this.workspaces.branchState(task.branch);
      check(state.parent === originalParent.branch && state.child_head === task.head_commit && state.parent_head,
        'merge source or target moved; inspect the branch');
      check(state.blockers.every(blocker => blocker === `task:#${task.id}`),
        `unintegrated descendants block the request: ${state.blockers.join(', ')}`);
      if (state.child_head === task.base_commit || state.status === 'integrated') {
        this.noteReservationBlocked(task.id, '没有尚未合入的提交；请继续工作或显式结束这条 Task');
        return false;
      }
      this.store.transaction(() => {
        const live = this.store.task(task.id), pinned = reservationOf(live);
        check(pinned?.version === 2 && pinned.status === 'pending' && live.status === 'waiting'
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
          check(parent.branch === task.target_branch, 'merge request target no longer matches its parent');
          // Never rewrite a branch while its owner still has an invocation. Retry at its safe point.
          if (this.running.has(parentId) || parent.status === 'running' || parent.status === 'queued'
            || this.running.has(task.id)) return 'wait';
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
            this.store.update(task.id, { status: 'completed', integration: 'merged', integration_error: null,
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
          try {
            await this.workspaces.archiveSquashedTaskUnsafe(this.store.task(task.id), request.commit, landed.commit);
          } catch (error) {
            this.store.update(task.id, { integration_error: `已合并；自动归档受阻：${error.message}` });
            this.store.event(task.id, 'task.archive_blocked', { error: error.message });
          }
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
