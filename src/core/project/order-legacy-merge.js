import { check, id, TERMINAL } from '../types.js';
import { storedReservation, parentMovedReason } from './order-state.js';

/** Historical fixed-tip fast-forward requests and explicit parent / user confirmation.
 * Current queued delivery stays in merge-queue.js; these methods preserve its bypass guards. */
export default {

  /** A request is not approval: pin both tips, settle atomically with the parent signal, never touch parent Git. */
  async settleReservedMerge(taskId) {
    const ready = () => {
      const task = this.store.task(taskId);
      const reservation = storedReservation(task.reservation);
      if (task.task_kind !== 'order' || reservation?.kind !== 'merge' || reservation.status !== 'pending'
        || reservation.blocked_code === 'resolving') return null;
      const reason = this.reservationWaitReason(task);
      if (reason) { this.noteReservationBlocked(task.id, reason); return null; }
      return task;
    };
    if (!ready()) return false;
    return this.workspaces.exclusive(async () => {
      let task = ready();
      if (!task) return false;
      await this.workspaces.finish(task); // clean worktree, exact branch, immutable committed tip
      task = ready();
      if (!task) return false;
      if (task.head_commit === task.base_commit) {
        this.noteReservationBlocked(task.id, 'no committed source changes yet');
        return false;
      }
      const parent = this.store.task(task.parent_id);
      check(['main','owner','order'].includes(parent.task_kind) && !TERMINAL.has(parent.status),
        'merge request needs a live directly bound parent Worker');
      // 基线一旦固定，父分支就不能再被别的交付推进：同时只允许一个未集成的请求。
      const lock = this.branchFreeze(parent.branch);
      if (lock && lock.task_id !== task.id) {
        this.noteReservationBlocked(task.id, `父分支 ${parent.branch} 已被 ${lock.reason}；先集成或撤销那个请求`, 'parent_locked');
        return false;
      }
      const state = await this.workspaces.branchState(task.branch);
      check(state.parent === parent.branch && state.child_head === task.head_commit,
        'order branch moved while preparing its fixed merge request');
      if (state.status === 'diverged') {
        const blockers = state.blockers.filter(item => item !== `task:#${task.id}`);
        const detail = blockers.length ? `; unintegrated child branches: ${blockers.join(', ')}. Inspect the child work before explicitly archiving unwanted branches` : '';
        this.noteReservationBlocked(task.id, `cannot request a merge from a diverged branch; resolve it first${detail}`, 'diverged');
        return false;
      }
      check(state.status === 'fast_forward', `cannot request a merge from a ${state.status} branch; resolve it first`);
      const blockers = state.blockers.filter(item => item !== `task:#${task.id}`);
      check(blockers.length === 0, `unintegrated child branches block merge request: ${blockers.join(', ')}`);
      task = ready();
      if (!task || task.head_commit !== state.child_head) return false;
      this.finish(task.id, 'completed', task.result, null, {
        mergeRequest: { commit: state.child_head, baseline: state.parent_head, parent_id: parent.id },
      });
      return true;
    });
  },

  /**
   * 历史终态 order 解分歧后仍需要一张固定提交的合并请求。
   * `merge` 预约的 pending 阶段依赖 order 静息等待，终态 Task 永远等不到，所以这里直接固定源 tip 与父基线、
   * 在事务里写一次 requested 并给父 Task 发 `merge.requested` 信号；不改动已经终结的生命周期。
   * 父子分歧时不抛错，而是留一条 pending/diverged 预约，用户可派独立解分歧子 Task 吸收固定的父提交。
   */
  /** 调用方必须已持有 Git 串行锁；仅供历史终态 order 解分歧收尾。 */
  async requestCompletedMergeUnsafe(taskId) {
    const current = this.store.task(id(taskId));
    const reservation = storedReservation(current.reservation);
    const pendingResolution = reservation?.kind === 'merge' && reservation.status === 'pending';
    check(current.task_kind === 'order' && current.status === 'completed'
      && pendingResolution,
    'only a completed order with a pending legacy merge can request a merge after resolution');
    check(current.integration !== 'merged', 'this order is already integrated into its parent');
    const parent = this.store.task(current.parent_id);
    check(['main','owner','order'].includes(parent.task_kind) && !TERMINAL.has(parent.status),
      'merge request needs a live directly bound parent Worker');
    // 交付锁与普通合并请求同源：同一父分支同时只允许一个未集成的请求。
    const lock = this.branchFreeze(parent.branch);
    check(!lock || lock.task_id === current.id,
      lock ? `父分支 ${parent.branch} 已被 ${lock.reason}；先集成或撤销那个请求` : '');
    await this.workspaces.finish(current); // 清理工作区并复核任务分支仍是自己的分支
    let task = this.store.task(current.id);
    check(task.head_commit && task.base_commit && task.head_commit !== task.base_commit,
      'no committed source changes to request a merge for');
    const state = await this.workspaces.branchState(task.branch);
    check(state.parent === parent.branch && state.child_head === task.head_commit,
      'order branch moved while preparing its fixed merge request');
    const blockers = state.blockers.filter(item => item !== `task:#${task.id}`);
    if (state.status === 'diverged') {
      // 分歧不是失败：固定成 pending/diverged，让用户在源侧派独立解分歧子 Task。子分支未收拢也一并说清。
      const detail = blockers.length ? `；先收拢未集成子分支：${blockers.join(', ')}` : '';
      const blocked = { version: 1, kind: 'merge', status: 'pending', created_at: new Date().toISOString(),
        blocked_reason: `分支与直接父分支已分歧；先派独立解分歧子Worker 吸收固定的父提交，再重新发合并请求${detail}。`,
        blocked_code: 'diverged' };
      this.store.transaction(() => {
        const live = this.store.task(task.id);
        check(live.status === 'completed' && live.head_commit === state.child_head,
          'order changed while preparing its fixed merge request');
        this.store.update(task.id, { reservation: JSON.stringify(blocked) });
        this.store.event(task.id, 'task.reservation_blocked', { reason: blocked.blocked_reason, code: 'diverged' });
      });
      return { task_id: task.id, reservation: storedReservation(this.store.task(task.id).reservation), changed: true };
    }
    check(blockers.length === 0, `unintegrated child branches block merge request: ${blockers.join(', ')}`);
    check(state.status === 'fast_forward', `cannot request a merge from a ${state.status} branch; resolve it first`);
    task = this.store.task(current.id);
    check(task.head_commit === state.child_head, 'order branch moved while preparing its fixed merge request');
    return this.pinSettledMergeRequest(task, parent, state.child_head, state.parent_head);
  },

  /** 终态 order 固定源提交与父基线、发一次 requested 并通知父 Task；调用方必须已持有 Git 串行锁。 */
  pinSettledMergeRequest(task, parent, commit, baseline) {
    const requested = { version: 1, kind: 'merge', status: 'requested', created_at: new Date().toISOString(),
      commit, baseline, parent_id: parent.id, requested_at: new Date().toISOString() };
    const key = `merge:${task.id}:${commit}`;
    const payload = { branch: task.branch, commit, baseline };
    const body = JSON.stringify({ version: 1, signal: 'merge.requested', key, source_task_id: task.id,
      target_task_id: parent.id, payload });
    this.store.transaction(() => {
      const live = this.store.task(task.id);
      check(live.status === 'completed' && live.head_commit === commit,
        'order changed while preparing its fixed merge request');
      const row = this.store.signal(parent.id, task.id, 'merge.requested', key, body);
      this.store.event(task.id, 'task.merge_requested', { ...payload, parent_id: parent.id, message_id: row.id });
      if (row.inserted) this.store.event(parent.id, 'task.signal', { message_id: row.id,
        source_task_id: task.id, signal: 'merge.requested', key });
      this.store.update(task.id, { reservation: JSON.stringify(requested) });
    });
    return { task_id: task.id, reservation: storedReservation(this.store.task(task.id).reservation), changed: true };
  },

  /** A human approves precisely the previously requested source commit and parent baseline. */
  async approveReservedMerge(taskId, commit, baseline) {
    check(typeof commit === 'string' && /^[0-9a-f]{40,64}$/.test(commit), 'approve the exact requested commit');
    check(typeof baseline === 'string' && /^[0-9a-f]{40,64}$/.test(baseline), 'approve the exact parent baseline');
    return this.workspaces.exclusive(async () => {
      const task = this.store.task(id(taskId));
      const reservation = storedReservation(task.reservation);
      check(task.task_kind === 'order' && task.status === 'completed' && reservation?.version === 1 && reservation.kind === 'merge'
        && ['requested','integrated'].includes(reservation.status), 'no completed merge request for this order Worker');
      check(reservation.commit === commit && reservation.baseline === baseline,
        'approval does not match the frozen request commit and parent baseline');
      const parent = this.store.task(task.parent_id);
      check(['main','owner'].includes(parent.task_kind) && reservation.parent_id === parent.id,
        'only a direct main/owner Worker merge request can be approved by a user');
      const lock = this.branchFreeze(parent.branch);
      check(!lock || (lock.kind === 'delivery' && lock.task_id === task.id),
        lock ? `branch ${parent.branch} is frozen: ${lock.reason}; cannot approve another delivery` : '');
      const state = await this.workspaces.branchState(task.branch);
      check(state.parent === parent.branch && state.child_head === commit, 'requested source branch moved; review it again');
      // 固定提交已经在父分支里（用户手工合入、或另一个请求把它带了进去）：批准退化成幂等记账，不再要求旧基线。
      const contained = state.parent_head
        ? await this.workspaces.isAncestor(this.config.project, commit, state.parent_head) : false;
      if (!contained) {
        if (state.parent_head && !(await this.workspaces.isAncestor(this.config.project, state.parent_head, commit)))
          this.noteReservationBlocked(task.id, parentMovedReason(parent.branch, state.parent_head, commit), 'parent_moved');
        check(state.parent_head === baseline || state.parent_head === commit,
          'parent branch moved since the request; the old approval cannot advance it');
      }
      if (reservation.status === 'integrated') {
        check(state.parent_head === commit, 'recorded integration no longer matches parent branch');
        return { task: this.store.task(task.id), parent: this.store.task(parent.id), already_integrated: true };
      }
      this.store.event(task.id, 'task.merge_approved', { commit, baseline, parent_id: parent.id });
      const outcome = await this.workspaces.mergeBranchUnsafe(task.branch, commit, state.parent_head);
      check(outcome.merged || outcome.already_integrated, 'approval requires a clean fast-forward');
      this.store.transaction(() => {
        const current = storedReservation(this.store.task(task.id).reservation);
        check(current?.status === 'requested' && current.commit === commit, 'request changed during approval');
        const { blocked_reason: _blocked, blocked_code: _blockedCode, ...cleanCurrent } = current;
        this.store.update(task.id, { integration: 'merged', integration_error: null,
          reservation: JSON.stringify({ ...cleanCurrent, status: 'integrated', integrated_at: new Date().toISOString() }) });
        this.store.update(parent.id, { head_commit: commit });
        this.store.event(task.id, 'task.merge_integrated', { commit, baseline, parent_id: parent.id,
          already_integrated: outcome.already_integrated === true });
      });
      return { task: this.store.task(task.id), parent: this.store.task(parent.id), merge: outcome };
    });
  },

  /** A live parent Agent confirms one pinned child commit; only ff-only child→direct-parent is allowed. */
  async integrateChild(parentId, childId, commit) {
    const parent = this.store.task(id(parentId)), child = this.store.task(id(childId));
    const delivery = child.task_kind === 'order' ? storedReservation(child.reservation) : null;
    const queuedDelivery = storedReservation(child.reservation);
    check(!queuedDelivery || queuedDelivery.version !== 2 || queuedDelivery.status === 'integrated',
      'version 2 delivery belongs to the parent runtime queue, not a parent Agent Git write');
    check(['order','child'].includes(parent.task_kind) && child.parent_id === parent.id
      && (child.task_kind === 'child' || (delivery?.kind === 'merge' && delivery.status === 'requested')),
      'only a direct child or requested order Worker of a new Worker can be integrated');
    check(parent.status === 'running', 'parent Agent must be running to confirm child integration');
    check(child.status === 'completed', 'child must complete before integration');
    check(child.branch && child.target_branch === parent.branch, 'child branch has no matching parent');
    check(typeof commit === 'string' && /^[0-9a-f]{40,64}$/.test(commit) && commit === child.head_commit
      && (!delivery || delivery.commit === commit),
      'confirm the completed child’s fixed head_commit, not a moving branch');
    // 交付锁：父分支上还有别的未集成请求时，只有那个请求自己的集成能写这条分支。
    const lock = this.branchFreeze(parent.branch);
    check(!lock || (lock.kind === 'delivery' && lock.task_id === child.id),
      lock ? `branch ${parent.branch} is frozen: ${lock.reason}; cannot integrate another Worker` : '');
    return this.workspaces.exclusive(async () => {
      const state = await this.workspaces.branchState(child.branch);
      check(state.parent === parent.branch && state.child_head === commit,
        'child branch moved after its completed commit; inspect it before integrating');
      // 父分支在本请求期间自己前进了：如实记成失效，而不是等最后一句“不能快进”。
      if (delivery && state.parent_head && !(await this.workspaces.isAncestor(this.config.project, commit, state.parent_head))
        && !(await this.workspaces.isAncestor(this.config.project, state.parent_head, commit)))
        this.noteReservationBlocked(child.id, parentMovedReason(parent.branch, state.parent_head, commit), 'parent_moved');
      const resolution = this.store.get("SELECT data FROM events WHERE task_id=? AND type='task.divergence_resolution_requested' ORDER BY id DESC LIMIT 1", child.id);
      let repaired = null;
      if (resolution) {
        const fixed = JSON.parse(resolution.data);
        check(fixed.source_commit === child.base_commit,
          'divergence resolution child has a mismatched frozen base commit');
        if (fixed.source_task_id === parent.id) {
          // order 自身分歧：被修复的就是这个父 Task 的交付。
          check(parent.task_kind === 'order', 'an order-only divergence resolution cannot be integrated here');
        } else {
          const source = this.store.task(fixed.source_task_id);
          check(source.parent_id === parent.id && source.task_kind === 'child' && source.status === 'completed'
            && source.integration !== 'merged' && fixed.source_commit === source.head_commit,
          'divergence resolution must repair a completed direct child of this parent');
          repaired = source;
        }
        check(await this.workspaces.isAncestor(this.config.project, fixed.source_commit, commit)
          && await this.workspaces.isAncestor(this.config.project, fixed.parent_commit, commit),
        'resolution child must contain both frozen source and parent commits before integration');
      }
      check(this.store.task(parent.id).status === 'running', 'parent Agent stopped before integration');
      this.store.event(parent.id, 'child.integration_requested', { child: child.id, commit, baseline: state.parent_head });
      const outcome = await this.workspaces.mergeBranchUnsafe(child.branch, commit);
      check(outcome.merged || outcome.already_integrated, 'child integration needs a clean fast-forward');
      this.store.transaction(() => {
        const { blocked_reason: _blocked, blocked_code: _blockedCode, ...cleanDelivery } = delivery ?? {};
        this.store.update(child.id, { integration: 'merged', integration_error: null,
          ...(delivery ? { reservation: JSON.stringify({ ...cleanDelivery, status: 'integrated', integrated_at: new Date().toISOString() }) } : {}) });
        this.store.update(parent.id, { head_commit: outcome.landed ?? commit });
        this.store.event(parent.id, 'child.integrated', { child: child.id, commit,
          baseline: state.parent_head, already_integrated: outcome.already_integrated === true });
        // 解分歧子任务落地后，它修复的那个已完子任务也一并结算：两者都在父分支里了。
        if (repaired) {
          this.store.update(repaired.id, { integration: 'merged', integration_error: null });
          this.store.event(repaired.id, 'child.integrated_via_resolution', { resolution: child.id, commit,
            source_commit: repaired.head_commit, parent_id: parent.id });
        }
      });
      return { child: this.store.task(child.id), parent: this.store.task(parent.id), merge: outcome };
    });
  },
};
