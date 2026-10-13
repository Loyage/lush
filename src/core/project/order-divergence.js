import { check, id, TERMINAL } from '../types.js';
import { workerLabel } from '../worker-number.js';
import { storedReservation } from './order-state.js';

function assertQuietResolutionParent(project, parent) {
  check(!project.running.has(parent.id) && !['running', 'queued'].includes(parent.status),
    `父Worker ${workerLabel(parent)} 尚未到安全点；等待当前 Agent 调用结束后再冻结并派解分歧 Worker`);
}


/** Historical independent source-side repairs, frozen-tip validation and runtime finalization. */
export default {

  /**
   * A user starts source-side conflict work, not a merge approval. 活动 order 的独立子 Task 完成后由 order Agent
   * 确认集成；已经终结的历史 order 没有可唤醒的 Agent，改用不挂在它子树下的独立 Task，结算后由
   * runtime 把产物推进回 order 分支并重新发合并请求。
   */
  async resolveOrderDivergence(taskId) {
    return this.workspaces.exclusive(async () => {
      const task = this.store.task(id(taskId));
      const reservation = storedReservation(task.reservation);
      check(task.task_kind === 'order' && reservation?.version === 1 && reservation.kind === 'merge' && reservation.status === 'pending',
        'only a legacy pending order merge reservation can use this resolution path');
      const terminal = TERMINAL.has(task.status);
      const previous = this.store.get(`SELECT t.* FROM tasks t JOIN events e ON e.task_id=t.id
        LEFT JOIN branches b ON b.branch=t.branch
        WHERE ${terminal ? 't.resolves_task_id' : 't.parent_id'}=? AND e.type='task.divergence_resolution_requested'
          AND (t.status NOT IN ('completed','failed','cancelled')
            OR (t.integration!='merged' AND b.status='active'))
        ORDER BY t.id DESC LIMIT 1`, task.id);
      if (previous) return TERMINAL.has(previous.status)
        ? { status: 'needs_review', task: this.progressView(previous),
          reason: terminal
            ? `解分歧子Worker ${workerLabel(previous)} ${previous.status} 且尚未集成；先检查现场。若需重新派 Worker，须显式归档 ${previous.branch}（保留 Worker 和会话，脏工作区需用户另行确认丢弃）。`
            : `解分歧子Worker ${workerLabel(previous)} ${previous.status} 且尚未集成；先检查现场。完成的结果可由指令 Agent 确认固定提交；若需重新派 Worker，须显式归档 ${previous.branch}（保留 Worker 和会话，脏工作区需用户另行确认丢弃）。` }
        : { status: 'existing', task: this.progressView(previous) };
      if (!terminal) {
        const reason = this.reservationWaitReason(task);
        check(!reason, reason || 'order must be idle before resolving divergence');
      }
      this.assertBranchWritable(task.branch, 'resolve its parent divergence');
      await this.workspaces.finish(task);
      const source = this.store.task(task.id);
      const parent = this.store.task(source.parent_id);
      check(['main','owner','order'].includes(parent.task_kind) && !TERMINAL.has(parent.status),
        'the directly bound parent is no longer active');
      assertQuietResolutionParent(this, parent);
      const state = await this.workspaces.branchState(source.branch);
      check(state.parent === parent.branch && state.child_head === source.head_commit,
        'order branch moved during divergence check; inspect its current HEAD');
      check(state.status === 'diverged', `source is ${state.status}; resolve_divergence only applies to a diverged branch`);
      const blockers = state.blockers.filter(item => item !== `task:#${source.id}`);
      check(blockers.length === 0, `unintegrated child branches block divergence resolution: ${blockers.join(', ')}; inspect failed or rejected child work and explicitly archive only the unwanted child branch before retrying`);
      const goal = `在独立子Worker工作区解决指令 ${workerLabel(source)} 与直接父分支 ${parent.branch} 的分歧。\n`
        + `基线是固定源提交 ${state.child_head}。请将固定父提交 ${state.parent_head} 合入本工作区（不要合入会移动的分支名）；`
        + `如有冲突，保留双方意图并解决，运行相关测试，再提交结果。只改自己的子Worker分支，`
        + `不可修改指令分支或父分支；`
        + (terminal
          ? `完成后由 runtime 检查产物含两端固定提交，把它快进推进回指令分支，再重新发出固定提交的合并请求。`
          : `完成后由 runtime 检查产物含两端固定提交、推进指令分支，再发固定合并请求；原指令 Agent 在冻结期间不调用。`);
      const created = this.store.transaction(() => {
        const live = this.store.task(source.id);
        const currentReservation = storedReservation(live.reservation);
        check(currentReservation?.kind === 'merge' && currentReservation.status === 'pending'
          && live.status === (terminal ? 'completed' : 'waiting')
          && live.head_commit === state.child_head && live.parent_id === parent.id,
          'order reservation changed while starting divergence work');
        assertQuietResolutionParent(this, this.store.task(parent.id));
        check(this.store.activeTasks().length < 1000, 'too many active workers');
        const child = this.store.create({ parent_id: terminal ? parent.id : live.id, input_id: live.input_id,
          role: 'agent', task_kind: 'child', name: `resolve-${live.id}`, goal,
          ...(terminal ? { resolves_task_id: live.id } : {}) });
        this.initializeNewWorkerConvergence(child);
        this.store.update(child.id, { base_commit: state.child_head, target_branch: live.branch });
        this.store.event(child.id, 'task.divergence_resolution_requested', { source_task_id: live.id,
          source_commit: state.child_head, parent_task_id: parent.id, parent_branch: parent.branch,
          parent_commit: state.parent_head });
        this.store.update(live.id, { reservation: JSON.stringify({ ...currentReservation,
          blocked_reason: terminal
            ? `等待独立解分歧子Worker ${workerLabel(child)} 完成后由 runtime 推进指令分支并重新发合并请求`
            : `等待解分歧子Worker ${workerLabel(child)} 完成并由指令 Agent 确认集成`,
          blocked_code: 'resolving', resolution_child_id: child.id }) });
        this.store.event(live.id, 'task.divergence_resolution_started', { child_id: child.id,
          source_commit: state.child_head, parent_commit: state.parent_head });
        return child;
      });
      this.kick();
      return { status: 'queued', task: this.progressView(created), source_commit: state.child_head,
        parent_commit: state.parent_head };
    });
  },

  /**
   * 新式解分歧统一由 runtime 收尾：验证两端固定 tip，先把源分支快进到解分歧产物。
   * order 重新固定合并请求，child 继续把源 child ff-only 收入父分支；不唤醒被冻结的 Agent 去写父分支。
   * 中途 Git 已快进而库尚未结算时从固定提交核对后补记，不重放 Agent 工作。
   */
  async finalizeTerminalDivergence(resolutionId) {
    const resolution = this.store.task(id(resolutionId));
    if (!resolution || resolution.status !== 'completed' || !resolution.head_commit) return null;
    const requestEvent = this.store.get("SELECT data FROM events WHERE task_id=? AND type='task.divergence_resolution_requested' ORDER BY id DESC LIMIT 1", resolution.id);
    if (!requestEvent) return null;
    const fixed = JSON.parse(requestEvent.data);
    if (fixed.orchestrated === true) return null; // 编排 driver 自己收尾
    const order = this.store.task(fixed.source_task_id);
    if (!order || !['order','child'].includes(order.task_kind)) return null;
    if (order.task_kind === 'child') {
      if (order.status !== 'completed' || order.integration === 'merged') return null;
    } else {
      if (!['waiting','completed'].includes(order.status)) return null;
      const reservation = storedReservation(order.reservation);
      if (reservation?.kind !== 'merge' || reservation.status !== 'pending'
        || reservation.blocked_code !== 'resolving' || reservation.resolution_child_id !== resolution.id) return null;
    }
    return this.workspaces.exclusive(async () => {
      const liveResolution = this.store.task(resolution.id);
      const liveOrder = this.store.task(order.id);
      const current = liveOrder.task_kind === 'order' ? storedReservation(liveOrder.reservation) : null;
      if (liveResolution.status !== 'completed' || !liveResolution.head_commit) return null;
      if (liveOrder.task_kind === 'child') {
        if (liveOrder.status !== 'completed' || liveOrder.integration === 'merged') return null;
      } else if (!['waiting','completed'].includes(liveOrder.status)
        || current?.resolution_child_id !== liveResolution.id || current.blocked_code !== 'resolving') return null;
      check(fixed.source_task_id === liveOrder.id, 'terminal divergence resolution targets the wrong order');
      check(await this.workspaces.isAncestor(this.config.project, fixed.source_commit, liveResolution.head_commit)
        && await this.workspaces.isAncestor(this.config.project, fixed.parent_commit, liveResolution.head_commit),
        'terminal divergence resolution must contain both frozen commits before it can be finalized');
      const state = await this.workspaces.branchState(liveOrder.branch);
      const advanced = state.child_head === liveResolution.head_commit;
      check(state.parent === liveOrder.target_branch
        && (state.child_head === fixed.source_commit || advanced)
        && (state.parent_head === fixed.parent_commit
          || (liveOrder.task_kind === 'child' && advanced && state.parent_head === liveResolution.head_commit)),
        'source or parent branch moved before divergence resolution was finalized; inspect the branch');
      if (!advanced) await this.workspaces.fastForwardBranchUnsafe(liveOrder.branch, liveResolution.head_commit);
      if (liveOrder.head_commit !== liveResolution.head_commit) this.store.transaction(() => {
        this.store.update(liveOrder.id, { head_commit: liveResolution.head_commit, integration: 'pending',
          integration_error: null });
        this.store.event(liveOrder.id, 'task.divergence_resolved', { resolution: liveResolution.id,
          commit: liveResolution.head_commit, source_commit: fixed.source_commit, parent_commit: fixed.parent_commit });
      });
      if (liveOrder.task_kind === 'child') {
        const owner = this.store.task(liveOrder.parent_id);
        check(!this.running.has(owner.id) && !['running','queued'].includes(owner.status),
          '父 Agent 尚未到安全点，不能落地解分歧结果');
        if (state.parent_head === fixed.parent_commit) await this.workspaces.mergeBranchUnsafe(
          liveOrder.branch, liveResolution.head_commit, fixed.parent_commit);
        this.store.transaction(() => {
          this.store.update(liveResolution.id, { integration: 'merged', integration_error: null });
          this.store.event(liveResolution.id, 'resolution.merged', { commit: liveResolution.head_commit,
            source_task_id: liveOrder.id, source_commit: fixed.source_commit, parent_commit: fixed.parent_commit });
          this.store.update(liveOrder.id, { integration: 'merged', integration_error: null });
          this.store.event(liveOrder.id, 'task.divergence_integrated', { resolution: liveResolution.id,
            commit: liveResolution.head_commit, parent_commit: fixed.parent_commit });
        });
        this.kick();
        return this.store.task(liveOrder.id);
      }
      if (liveResolution.integration !== 'merged') this.store.transaction(() => {
        this.store.update(liveResolution.id, { integration: 'merged', integration_error: null });
        this.store.event(liveResolution.id, 'resolution.merged', { commit: liveResolution.head_commit,
          source_task_id: liveOrder.id, source_commit: fixed.source_commit, parent_commit: fixed.parent_commit });
      });
      if (liveOrder.status === 'waiting') {
        // 活动 order 的 Agent 不在被冻结的父分支上重新执行；runtime 校验并结算固定请求。
        return this.finish(liveOrder.id, 'completed', liveOrder.result, null, {
          mergeRequest: { commit: liveResolution.head_commit, baseline: fixed.parent_commit, parent_id: liveOrder.parent_id },
        });
      }
      return this.requestCompletedMergeUnsafe(liveOrder.id).catch(error => {
        this.noteReservationBlocked(liveOrder.id, error.message);
        return null;
      });
    });
  },

  /** 解分歧子 Task 结算后调度一次收尾；失败只记事件并保留冻结/现场供检查。 */
  scheduleTerminalDivergenceFinalize(resolutionId) {
    if (this.stopping) return;
    queueMicrotask(() => this.finalizeTerminalDivergence(resolutionId).catch(error => {
      this.store.event(resolutionId, 'resolution.finalize_failed', { error: error.message });
      console.error(`terminal divergence finalize #${resolutionId}: ${error.stack || error}`);
    }));
  },

  /** 终态 order 的独立解分歧子 Task 失败/取消：把预约落回可分派的 diverged 状态，保留失败现场。 */
  noteTerminalDivergenceFailure(resolution, status, error) {
    const order = this.store.task(resolution.resolves_task_id);
    if (!order || order.task_kind !== 'order' || !['waiting','completed'].includes(order.status)) return false;
    const reservation = storedReservation(order.reservation);
    if (reservation?.kind !== 'merge' || reservation.status !== 'pending'
      || reservation.resolution_child_id !== resolution.id) return false;
    this.store.update(order.id, { reservation: JSON.stringify({ ...reservation,
      blocked_reason: `解分歧子Worker ${workerLabel(resolution)} ${status}${error ? `：${error}` : ''}；检查现场后显式归档旧分支再重新派。`,
      blocked_code: 'diverged' }) });
    this.store.event(order.id, 'task.divergence_resolution_failed', { resolution: resolution.id, status, error: error ?? null });
    return true;
  },

  /** A running direct parent Agent absorbs a diverged completed child commit into its own branch history.
   *  The child branch is never rewritten and the parent branch never takes a merge commit: a new Task contains
   *  both frozen tips and is landed by the same worker.integrate confirmation, which then closes the source child. */
  async resolveChildDivergence(parentId, childId) {
    return this.workspaces.exclusive(async () => {
      const parent = this.store.task(id(parentId)), child = this.store.task(id(childId));
      check(['order','child'].includes(parent.task_kind), 'only a new Worker agent can repair its own child branch');
      check(child.task_kind === 'child' && child.parent_id === parent.id, 'a parent can only repair its own direct child');
      const previous = this.store.get(`SELECT t.* FROM tasks t JOIN events e ON e.task_id=t.id
        LEFT JOIN branches b ON b.branch=t.branch
        WHERE t.parent_id=? AND e.type='task.divergence_resolution_requested'
          AND json_extract(e.data,'$.source_task_id')=?
          AND (t.status NOT IN ('completed','failed','cancelled')
            OR (t.integration!='merged' AND b.status='active'))
        ORDER BY t.id DESC LIMIT 1`, parent.id, child.id);
      if (previous) return TERMINAL.has(previous.status)
        ? { status: 'needs_review', task: this.progressView(previous),
          reason: `解分歧子Worker ${workerLabel(previous)} 已结束且尚未集成；先检查现场。若需重做，由用户显式归档 ${previous.branch} 后再调用本接口（不会重放上一次 Agent）。` }
        : { status: 'existing', task: this.progressView(previous) };
      check(child.status === 'completed' && child.integration !== 'merged',
        'only a completed child whose work is not integrated yet can be repaired');
      // 交付锁：父分支上还有未集成的 order 请求时，先集成或撤销它，再分派新的分支工作。
      const lock = this.branchFreeze(parent.branch);
      check(!lock, lock ? `branch ${parent.branch} is frozen: ${lock.reason}; integrate or withdraw that request first` : '');
      // 此入口由正在运行的父 Agent 调用：先固定请求并阻止新的写入，等它本轮安全结束后才准许解分歧子 Task 开始。
      await this.workspaces.finish(child);
      const live = this.store.task(child.id);
      const state = await this.workspaces.branchState(live.branch);
      check(state.parent === parent.branch && state.child_head === live.head_commit,
        'child branch moved after its completed commit; inspect it before repairing');
      check(state.status === 'diverged', `child is ${state.status}; repair only applies to a diverged child`);
      check(state.blockers.length === 0, `unintegrated descendants block repairing this child: ${state.blockers.join(', ')}`);
      const goal = `在独立子Worker工作区解决子Worker ${workerLabel(live)} 与直接父分支 ${parent.branch} 的分歧。\n`
        + `基线是固定子提交 ${state.child_head}。请将固定父提交 ${state.parent_head} 合入本工作区（不要合入会移动的分支名）；`
        + `如有冲突，保留双方意图并解决，运行相关测试，再提交结果。只改自己的子Worker分支，`
        + `不可修改 ${workerLabel(live)} 或 ${parent.branch}；完成后由 runtime 核对两端固定提交，依次快进 ${workerLabel(live)} 与 ${workerLabel(parent)} 的分支。`;
      const created = this.store.transaction(() => {
        const current = this.store.task(live.id), owner = this.store.task(parent.id);
        check(owner.status === 'running' && current.status === 'completed' && current.integration !== 'merged'
          && current.head_commit === state.child_head && current.parent_id === owner.id,
        'child or parent changed while starting divergence repair');
        check(this.store.activeTasks().length < 1000, 'too many active workers');
        const repair = this.store.create({ parent_id: owner.id, input_id: owner.input_id, role: 'agent',
          task_kind: 'child', name: `resolve-${current.id}`, goal });
        this.initializeNewWorkerConvergence(repair);
        this.store.update(repair.id, { base_commit: state.child_head, target_branch: owner.branch });
        this.store.event(repair.id, 'task.divergence_resolution_requested', { source_task_id: current.id,
          source_commit: state.child_head, parent_task_id: owner.id, parent_branch: owner.branch,
          parent_commit: state.parent_head });
        this.store.event(current.id, 'task.divergence_resolution_started', { child_id: repair.id,
          source_commit: state.child_head, parent_commit: state.parent_head });
        return repair;
      });
      this.requestPreempt(parent.id, '解分歧已冻结父子分支，等待本轮安全结束');
      this.kick();
      return { status: 'queued', task: this.progressView(created), source_commit: state.child_head,
        parent_commit: state.parent_head };
    });
  },
};
