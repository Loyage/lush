import { check, id, text, TERMINAL } from '../types.js';

function storedReservation(raw) {
  if (raw === null) return null;
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error('reservation state is invalid; inspect task before changing it'); }
  check(value && typeof value === 'object' && !Array.isArray(value) && value.version === 1
    && ['merge','showcase'].includes(value.kind) && typeof value.status === 'string',
  'reservation state is invalid; inspect task before changing it');
  return value;
}

/** 请求失效的唯一诊断文案：三个触发点（父分支自己提交 / 集成 / 批准）说同一句话，才不会被去重成多条事件。 */
function parentMovedReason(branch, parentHead, commit) {
  return `父分支 ${branch} 在本请求发出后被推进到 ${String(parentHead).slice(0, 12)}，`
    + `固定提交 ${String(commit).slice(0, 12)} 已不能快进：撤销这个请求（任务、分支与提交保留），`
    + `或先把该固定提交合入 ${branch} 再确认集成。`;
}

/** New task-owned input path. Legacy input.submit and draft.commit remain readable and executable. */
export default {
  /** Bootstrap only when the project's local main ref already exists; never create or guess a ref. */
  async bootstrapMain() {
    try { await this.workspaces.git(this.config.project, 'show-ref', '--verify', 'refs/heads/main'); }
    catch { return null; }
    return this.ensureMainTask();
  },

  /** A stable logical root; no provider invocation is started merely by creating it. */
  async ensureMainTask() {
    const existing = this.store.all("SELECT * FROM tasks WHERE task_kind='main' AND branch='main' ORDER BY id");
    check(existing.length <= 1, 'main branch has more than one owning task');
    if (existing.length) return existing[0];
    let commit = null;
    try {
      await this.workspaces.git(this.config.project, 'show-ref', '--verify', 'refs/heads/main');
      commit = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', 'refs/heads/main^{commit}');
    } catch { /* no local main ref */ }
    check(commit, 'the new say protocol needs a local main branch; no branch was created automatically');
    return this.store.transaction(() => {
      const root = this.store.create({ role: 'agent', goal: '管理 main 分支及子任务合并请求', name: 'main', task_kind: 'main' });
      this.store.update(root.id, { status: 'waiting', branch: 'main', base_commit: commit, head_commit: commit });
      this.store.event(root.id, 'main.bound', { branch: 'main', commit });
      return this.store.task(root.id);
    });
  },

  /** User-confirmed ownership for an existing local branch. Do not rewrite a legacy task/branch row. */
  async bindBranch(branch, commit) {
    text(branch, 'branch');
    check(branch.length <= 512 && branch !== 'main', 'bind a non-main local branch; main has its own root');
    check(typeof commit === 'string' && /^[0-9a-f]{40,64}$/.test(commit), 'bind needs the exact local branch HEAD commit');
    this.assertBranchWritable(branch, 'bind it to a new Task');
    return this.workspaces.exclusive(async () => {
      const actual = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
        .catch(() => { throw new Error(`local branch ${branch} does not exist`); });
      check(actual === commit, `branch ${branch} moved; confirm its current HEAD before binding`);
      const old = this.store.branch(branch);
      check(!old || !['deleted','archived'].includes(old.status), `branch ${branch} has a deleted/archived historical record; inspect before binding`);
      const unfinished = this.store.get(`SELECT t.id FROM tasks t LEFT JOIN inputs i ON i.id=t.input_id
        WHERE t.task_kind IS NULL AND t.status NOT IN ('completed','failed','cancelled')
          AND (t.branch=? OR t.target_branch=? OR i.anchor_branch=?) LIMIT 1`, branch, branch, branch);
      check(!unfinished, `branch ${branch} still has an active old task #${unfinished?.id}; finish it before binding`);
      return this.store.transaction(() => {
        const owners = this.store.all("SELECT id FROM tasks WHERE branch=? AND task_kind IN ('main','owner','say')", branch);
        check(owners.length === 0, `branch ${branch} already has a new Task owner`);
        const owner = this.store.create({ role: 'agent', name: 'branch-owner', goal: `管理显式绑定的分支 ${branch}`,
          task_kind: 'owner' });
        this.store.update(owner.id, { status: 'waiting', branch, base_commit: commit, head_commit: commit });
        if (!old) this.store.recordBranch({ branch, created_from_commit: commit, task_id: owner.id });
        this.store.event(owner.id, 'branch.bound', { branch, commit, previous_task_id: old?.task_id ?? null });
        return this.store.task(owner.id);
      });
    });
  },

  /**
   * 用户专属：在 main/owner 下开一个**只读分析子 Task**，回答针对这条分支当前状态的问题。
   * 不建分支、不占地板：工具不限，但机制上拿不到任何分支（分离检出），所以既改不了 ref 也交付不了代码；
   * 回答成为该 Task 的 result，并在结算时留一条信息 notice。
   */
  async analyze(taskId, question) {
    const parent = this.store.task(id(taskId));
    check(['main','owner'].includes(parent.task_kind), 'only a branch owner Task analyzes its branch on demand');
    text(question, 'question');
    check(question.length <= 4000, 'analysis question exceeds 4000 characters');
    check(!TERMINAL.has(parent.status), 'branch owner has ended; bind the branch again first');
    return this.workspaces.exclusive(async () => {
      const branch = parent.branch;
      check(branch, `task #${parent.id} owns no branch to analyze`);
      const commit = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
        .catch(() => { throw new Error(`local branch ${branch} does not exist; nothing to analyze`); });
      const created = this.store.transaction(() => {
        const owner = this.store.task(parent.id);
        check(!TERMINAL.has(owner.status) && owner.branch === branch, 'branch owner changed while starting analysis');
        check(this.store.activeTasks().length < 1000, 'too many active tasks');
        const task = this.store.create({ parent_id: owner.id, input_id: null, role: 'agent', task_kind: 'analysis',
          goal: question });
        this.store.update(task.id, { target_branch: branch, base_commit: commit });
        this.store.event(task.id, 'task.analyze_requested', { parent_id: owner.id, branch, commit });
        return task;
      });
      this.kick();
      return { status: 'queued', task: this.progressView(created), branch, commit };
    });
  },

  /** Persistent, mutually exclusive user intention; not a merge/showcase authorization. */
  async reserveTask(taskId, kind) {
    check(kind === 'merge' || kind === 'showcase', 'reservation kind must be merge or showcase');
    if (kind === 'showcase') return this.bookShowcase(taskId);
    const accepted = this.store.transaction(() => {
      const task = this.store.task(id(taskId));
      check(task.task_kind === 'say', 'only new say Tasks support delivery reservations');
      check(!TERMINAL.has(task.status), 'cannot reserve an ended say Task');
      const previous = storedReservation(task.reservation);
      check(!previous || (previous.version === 1 && previous.status === 'pending' && ['merge','showcase'].includes(previous.kind)),
        'reservation state needs inspection before changing it');
      check(!previous || previous.kind === kind, `task #${task.id} already reserves ${previous?.kind}; unreserve it before choosing ${kind}`);
      if (previous) return { task_id: task.id, reservation: previous, changed: false };
      const reservation = { version: 1, kind, status: 'pending', created_at: new Date().toISOString() };
      this.store.update(task.id, { reservation: JSON.stringify(reservation) });
      this.store.event(task.id, 'task.reserved', { reservation });
      return { task_id: task.id, reservation, changed: true };
    });
    try {
      const current = storedReservation(this.store.task(accepted.task_id).reservation);
      // 已发出的请求没有 pending 可推进：重查它现在是否仍可落地、已被包含，还是已经失效。
      if (current?.status === 'requested') await this.recheckRequestedMerge(accepted.task_id);
      else await this.settleReservedMerge(accepted.task_id);
    } catch (error) { this.noteReservationBlocked(accepted.task_id, error.message); }
    return { ...accepted, reservation: storedReservation(this.store.task(accepted.task_id).reservation) };
  },

  /** 阻塞诊断：pending 是“还没能满足”，requested 是“已发出的请求失效了”。两种情况都只记录上次检查的快照。 */
  noteReservationBlocked(taskId, reason, code = null) {
    this.store.transaction(() => {
      const task = this.store.task(taskId);
      const reservation = storedReservation(task.reservation);
      if (!['merge','showcase'].includes(reservation?.kind) || !['pending','preparing','requested'].includes(reservation.status)) return;
      const blocked_reason = String(reason).slice(0, 1000);
      if (reservation.blocked_reason === blocked_reason && (reservation.blocked_code ?? null) === code) return;
      const { blocked_code: _previousCode, ...rest } = reservation;
      this.store.update(task.id, { reservation: JSON.stringify({ ...rest, blocked_reason,
        ...(code ? { blocked_code: code } : {}) }) });
      this.store.event(task.id, 'task.reservation_blocked', { reason: blocked_reason, code });
    });
  },

  /** 清掉过期的诊断：请求重新可以快进时，旧原因不能留着误导用户。 */
  clearReservationBlocked(taskId) {
    this.store.transaction(() => {
      const task = this.store.task(id(taskId));
      const reservation = storedReservation(task.reservation);
      if (!reservation || (!reservation.blocked_reason && !reservation.blocked_code)) return;
      const { blocked_reason: previous, blocked_code: code, ...clean } = reservation;
      this.store.update(task.id, { reservation: JSON.stringify(clean) });
      this.store.event(task.id, 'task.reservation_rechecked', { previous_reason: previous ?? null, code: code ?? null });
    });
  },

  /**
   * 已发出请求的只读复查：请求发出后 Git 会变（父分支被推进、外部人动过源分支），而 pending 的复查
   * 不覆盖这种状态。重启恢复与集成/批准失败都走这里，把结果如实写进 reservation 诊断。
   */
  async recheckRequestedMerge(taskId) {
    const task = this.store.task(id(taskId));
    const reservation = storedReservation(task.reservation);
    if (task.task_kind !== 'say' || reservation?.kind !== 'merge' || reservation.status !== 'requested') return null;
    const parent = this.store.task(task.parent_id);
    const commit = reservation.commit;
    const state = await this.workspaces.branchState(task.branch).catch(() => null);
    if (!state?.parent_head || state.child_head !== commit) {
      this.noteReservationBlocked(task.id,
        `源分支 ${task.branch} 的顶端已是 ${String(state?.child_head ?? '缺失').slice(0, 12)}，不再是请求里固定的提交 ${String(commit).slice(0, 12)}；`
        + '先检查现场，必要时撤销这个请求。', 'source_moved');
      return 'source_moved';
    }
    if (await this.workspaces.isAncestor(this.config.project, commit, state.parent_head)) {
      this.noteReservationBlocked(task.id,
        `固定提交 ${String(commit).slice(0, 12)} 已经在 ${parent.branch} 里：让直接父 Agent 确认（父为 say），`
        + '或你按固定值批准（父为 main/owner），两种方式都是幂等关闭。', 'contained');
      return 'contained';
    }
    if (!(await this.workspaces.isAncestor(this.config.project, state.parent_head, commit))) {
      this.noteReservationBlocked(task.id, parentMovedReason(parent.branch, state.parent_head, commit), 'parent_moved');
      return 'parent_moved';
    }
    this.clearReservationBlocked(task.id);
    return 'landable';
  },

  /** 父分支自己提交后，复查挂在它上面的请求：不能快进的请求如实记成 parent_moved，而不是继续显示“等待集成”。
   *  返回仍处于失效状态的请求 id（没有就返回 null）；重复调用只刷新一次诊断（同因同码不重写事件）。 */
  async noteBranchAdvance(taskId) {
    const task = this.store.task(taskId);
    if (!task.branch) return null;
    const lock = this.branchFreeze(task.branch);
    if (!lock || lock.kind !== 'delivery' || lock.task_id === task.id || !lock.commit) return null;
    const head = task.head_commit;
    if (!head) return null;
    if (await this.workspaces.isAncestor(this.config.project, lock.commit, head)) return null;
    this.noteReservationBlocked(lock.task_id, parentMovedReason(task.branch, head, lock.commit), 'parent_moved');
    return lock.task_id;
  },

  /** A user starts source-side conflict work, not a merge approval. The say Agent must later integrate it. */
  async resolveSayDivergence(taskId) {
    return this.workspaces.exclusive(async () => {
      const task = this.store.task(id(taskId));
      const reservation = storedReservation(task.reservation);
      check(task.task_kind === 'say' && reservation?.kind === 'merge' && reservation.status === 'pending',
        'only a pending say merge reservation can resolve parent divergence');
      const previous = this.store.get(`SELECT t.* FROM tasks t JOIN events e ON e.task_id=t.id
        LEFT JOIN branches b ON b.branch=t.branch
        WHERE t.parent_id=? AND e.type='task.divergence_resolution_requested'
          AND (t.status NOT IN ('completed','failed','cancelled')
            OR (t.integration!='merged' AND b.status='active'))
        ORDER BY t.id DESC LIMIT 1`, task.id);
      if (previous) return TERMINAL.has(previous.status)
        ? { status: 'needs_review', task: this.progressView(previous),
          reason: `解分歧子 Task #${previous.id} ${previous.status} 且尚未集成；先检查现场。完成的结果可由 say Agent 确认固定提交；若需重新派任务，须显式归档 ${previous.branch}（保留 Task 和会话，脏工作区需用户另行确认丢弃）。` }
        : { status: 'existing', task: this.progressView(previous) };
      const reason = this.reservationWaitReason(task);
      check(!reason, reason || 'say must be idle before resolving divergence');
      this.assertBranchWritable(task.branch, 'resolve its parent divergence');
      await this.workspaces.finish(task);
      const source = this.store.task(task.id);
      const parent = this.store.task(source.parent_id);
      check(['main','owner','say'].includes(parent.task_kind) && !TERMINAL.has(parent.status),
        'the directly bound parent is no longer active');
      const state = await this.workspaces.branchState(source.branch);
      check(state.parent === parent.branch && state.child_head === source.head_commit,
        'say branch moved during divergence check; inspect its current HEAD');
      check(state.status === 'diverged', `source is ${state.status}; resolve_divergence only applies to a diverged branch`);
      const blockers = state.blockers.filter(item => item !== `task:#${source.id}`);
      check(blockers.length === 0, `unintegrated child branches block divergence resolution: ${blockers.join(', ')}; inspect failed or rejected child work and explicitly archive only the unwanted child branch before retrying`);
      const goal = `在独立子任务工作区解决 say #${source.id} 与直接父分支 ${parent.branch} 的分歧。\n`
        + `基线是固定源提交 ${state.child_head}。请将固定父提交 ${state.parent_head} 合入本工作区（不要合入会移动的分支名）；`
        + `如有冲突，保留双方意图并解决，运行相关测试，再提交结果。只改自己的子任务分支，`
        + `不可修改 say 分支或父分支；完成后由 say #${source.id} Agent 检查固定子提交并另行确认集成。`;
      const created = this.store.transaction(() => {
        const live = this.store.task(source.id);
        const currentReservation = storedReservation(live.reservation);
        check(currentReservation?.kind === 'merge' && currentReservation.status === 'pending' && live.status === 'waiting'
          && live.head_commit === state.child_head && live.parent_id === parent.id,
          'say reservation changed while starting divergence work');
        check(this.store.activeTasks().length < 1000, 'too many active tasks');
        const child = this.store.create({ parent_id: live.id, input_id: live.input_id, role: 'agent',
          task_kind: 'child', name: `resolve-${live.id}`, goal });
        this.store.update(child.id, { base_commit: state.child_head, target_branch: live.branch });
        this.store.event(child.id, 'task.divergence_resolution_requested', { source_task_id: live.id,
          source_commit: state.child_head, parent_task_id: parent.id, parent_branch: parent.branch,
          parent_commit: state.parent_head });
        this.store.update(live.id, { reservation: JSON.stringify({ ...currentReservation,
          blocked_reason: `等待解分歧子 Task #${child.id} 完成并由 say Agent 确认集成`,
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

  /** A running direct parent Agent absorbs a diverged completed child commit into its own branch history.
   *  The child branch is never rewritten and the parent branch never takes a merge commit: a new Task contains
   *  both frozen tips and is landed by the same task.integrate confirmation, which then closes the source child. */
  async resolveChildDivergence(parentId, childId) {
    return this.workspaces.exclusive(async () => {
      const parent = this.store.task(id(parentId)), child = this.store.task(id(childId));
      check(['say','child'].includes(parent.task_kind), 'only a new Task agent can repair its own child branch');
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
          reason: `解分歧子 Task #${previous.id} 已结束且尚未集成；先检查现场。若需重做，由用户显式归档 ${previous.branch} 后再调用本接口（不会重放上一次 Agent）。` }
        : { status: 'existing', task: this.progressView(previous) };
      check(child.status === 'completed' && child.integration !== 'merged',
        'only a completed child whose work is not integrated yet can be repaired');
      // 交付锁：父分支上还有未集成的 say 请求时，先集成或撤销它，再分派新的分支工作。
      const lock = this.branchFreeze(parent.branch);
      check(!lock, lock ? `branch ${parent.branch} is frozen: ${lock.reason}; integrate or withdraw that request first` : '');
      await this.workspaces.finish(child);
      const live = this.store.task(child.id);
      const state = await this.workspaces.branchState(live.branch);
      check(state.parent === parent.branch && state.child_head === live.head_commit,
        'child branch moved after its completed commit; inspect it before repairing');
      check(state.status === 'diverged', `child is ${state.status}; repair only applies to a diverged child`);
      check(state.blockers.length === 0, `unintegrated descendants block repairing this child: ${state.blockers.join(', ')}`);
      const goal = `在独立子任务工作区解决子 Task #${live.id} 与直接父分支 ${parent.branch} 的分歧。\n`
        + `基线是固定子提交 ${state.child_head}。请将固定父提交 ${state.parent_head} 合入本工作区（不要合入会移动的分支名）；`
        + `如有冲突，保留双方意图并解决，运行相关测试，再提交结果。只改自己的子任务分支，`
        + `不可修改 #${live.id} 或 ${parent.branch}；完成后由 #${parent.id} Agent 用 task.integrate 确认固定子提交，集成会自动结算 #${live.id}。`;
      const created = this.store.transaction(() => {
        const current = this.store.task(live.id), owner = this.store.task(parent.id);
        check(owner.status === 'running' && current.status === 'completed' && current.integration !== 'merged'
          && current.head_commit === state.child_head && current.parent_id === owner.id,
        'child or parent changed while starting divergence repair');
        check(this.store.activeTasks().length < 1000, 'too many active tasks');
        const repair = this.store.create({ parent_id: owner.id, input_id: owner.input_id, role: 'agent',
          task_kind: 'child', name: `resolve-${current.id}`, goal });
        this.store.update(repair.id, { base_commit: state.child_head, target_branch: owner.branch });
        this.store.event(repair.id, 'task.divergence_resolution_requested', { source_task_id: current.id,
          source_commit: state.child_head, parent_task_id: owner.id, parent_branch: owner.branch,
          parent_commit: state.parent_head });
        this.store.event(current.id, 'task.divergence_resolution_started', { child_id: repair.id,
          source_commit: state.child_head, parent_commit: state.parent_head });
        return repair;
      });
      this.kick();
      return { status: 'queued', task: this.progressView(created), source_commit: state.child_head,
        parent_commit: state.parent_head };
    });
  },

  /** An observable execution barrier, not a Git verdict. A retry never skips a running invocation or unread signal. */
  reservationWaitReason(task) {
    if (this.running.has(task.id) || task.status === 'running') return 'Agent 正在调用或收尾，等待本轮安全结束';
    if (task.status === 'queued') return 'Task 等待下一轮 Agent 调用完成';
    if (task.status === 'awaiting' || this.questionPending(task.id)) return 'Task 正在等待用户答复';
    if (task.status !== 'waiting') return `Task 尚未静息（${task.status}）`;
    const reservation = storedReservation(task.reservation);
    const child = this.store.children(task.id).find(row => !TERMINAL.has(row.status)
      && !(reservation?.kind === 'showcase' && reservation.status === 'preparing' && row.id === reservation.child_id));
    if (child) return `等待子 Task #${child.id} 结算`;
    if (this.hasActionableMessages(task.id)) return '还有未处理的消息或子任务信号，需先交给 Agent';
    return null;
  },

  /** A request is not approval: pin both tips, settle atomically with the parent signal, never touch parent Git. */
  async settleReservedMerge(taskId) {
    const ready = () => {
      const task = this.store.task(taskId);
      const reservation = storedReservation(task.reservation);
      if (task.task_kind !== 'say' || reservation?.kind !== 'merge' || reservation.status !== 'pending') return null;
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
      check(['main','owner','say'].includes(parent.task_kind) && !TERMINAL.has(parent.status),
        'merge request needs a live directly bound parent Task');
      // 基线一旦固定，父分支就不能再被别的交付推进：同时只允许一个未集成的请求。
      const lock = this.branchFreeze(parent.branch);
      if (lock && lock.task_id !== task.id) {
        this.noteReservationBlocked(task.id, `父分支 ${parent.branch} 已被 ${lock.reason}；先集成或撤销那个请求`, 'parent_locked');
        return false;
      }
      const state = await this.workspaces.branchState(task.branch);
      check(state.parent === parent.branch && state.child_head === task.head_commit,
        'say branch moved while preparing its fixed merge request');
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
   * 用户专属：say Task 预约效果展示。点击即创建展示子 Task 并进入准备阶段；say 真正完成且满足展示准入后，
   * 由 signalReservedShowcase 发信号让它按最终提交交付。重复调用幂等，也不会重复建子 Task。
   */
  async bookShowcase(taskId) {
    const target = id(taskId);
    const current = this.store.task(target);
    check(current.task_kind === 'say', 'only new say Tasks support delivery reservations');
    check(!TERMINAL.has(current.status), 'cannot reserve an ended say Task');
    const previous = storedReservation(current.reservation);
    check(!previous || previous.kind === 'showcase',
      `task #${current.id} already reserves ${previous?.kind}; unreserve it before choosing showcase`);
    if (previous) {
      // 幂等复查：条件已满足就补发一次信号，否则保留 preparation 状态。
      // 必须放在 exclusive 之外，否则会与 signalReservedShowcase 自己的串行锁死锁。
      if (previous.status === 'preparing' && current.status === 'waiting') await this.signalReservedShowcase(target);
      return { task_id: target, reservation: storedReservation(this.store.task(target).reservation), changed: false,
        child_id: previous.child_id ?? null };
    }
    const created = await this.workspaces.exclusive(async () => {
      const task = this.store.task(target);
      check(task.task_kind === 'say' && task.reservation === null && !TERMINAL.has(task.status),
        'say changed while booking showcase');
      const prep = await this.showcasePreparation(task.branch);
      return this.store.transaction(() => {
        const live = this.store.task(target);
        check(live.task_kind === 'say' && live.reservation === null && !TERMINAL.has(live.status),
          'say changed while booking showcase');
        check(this.store.activeTasks().length < 1000, 'too many active tasks');
        const reservation = { version: 1, kind: 'showcase', status: 'preparing',
          created_at: new Date().toISOString(), child_id: null, prep_commit: prep.commit };
        const child = this.store.create({ parent_id: live.id, input_id: live.input_id, role: 'showcase',
          name: 'showcase', task_kind: 'showcase', showcase: { ...prep, phase: 'preparing' },
          goal: `效果展示：${live.branch}\n先做准备（理解改动、设计展示方案）；收到原 say 工作完成的信号后，再按最终固定提交交付自包含展示页与可运行预览。展示不是验收，也不自动合并。` });
        this.store.update(live.id, { reservation: JSON.stringify({ ...reservation, child_id: child.id }) });
        this.store.event(child.id, 'showcase.booked', { branch: live.branch, commit: prep.commit,
          baseline: prep.baseline_commit, phase: 'preparing' });
        this.store.event(live.id, 'task.showcase_booked', { child_id: child.id, commit: prep.commit });
        return child;
      });
    });
    this.kick();
    return { task_id: target, reservation: storedReservation(this.store.task(target).reservation), changed: true,
      child_id: created.id };
  },

  /**
   * 展示预约的第二阶段：say 真正完成（静息）且分支满足展示准入时，把既有展示子 Task 从 prep 提交重新固定到
   * 最终提交并唤醒它继续交付。say 仍保持非终态，等展示子 Task 结算后才终结。
   */
  async signalReservedShowcase(taskId) {
    return this.workspaces.exclusive(async () => {
      const task = this.store.task(id(taskId));
      const reservation = storedReservation(task.reservation);
      if (task.task_kind !== 'say' || reservation?.kind !== 'showcase' || reservation.status !== 'preparing') return false;
      const child = this.store.task(reservation.child_id);
      if (!child || child.role !== 'showcase' || child.task_kind !== 'showcase' || child.parent_id !== task.id) {
        this.noteReservationBlocked(task.id, '展示预约的子 Task 丢失或身份变化，请撤销后重新预约', 'missing_child');
        return false;
      }
      if (this.running.has(child.id) || child.status === 'queued' || child.status === 'running') return false;
      if (TERMINAL.has(child.status)) {
        this.noteReservationBlocked(task.id, `展示子 Task #${child.id} 已 ${child.status}，撤销后重新预约`, 'child_ended');
        return false;
      }
      const reason = this.reservationWaitReason(task);
      if (reason) { this.noteReservationBlocked(task.id, reason); return false; }
      const eligibility = await this.showcaseEligibility(task.branch, null, child.id, task.id);
      if (!eligibility.allowed) { this.noteReservationBlocked(task.id, eligibility.reason); return false; }
      const snapshot = eligibility.snapshot;
      await this.workspaces.showcaseRepin(child, JSON.parse(child.showcase), snapshot);
      this.store.transaction(() => {
        const current = storedReservation(this.store.task(task.id).reservation);
        check(current?.kind === 'showcase' && current.status === 'preparing' && current.child_id === child.id,
          'showcase reservation changed during signal');
        const { blocked_reason: _reason, blocked_code: _code, ...clean } = current;
        this.store.setShowcase(child.id, { ...snapshot, phase: 'final' });
        this.store.update(child.id, { base_commit: snapshot.commit, head_commit: snapshot.commit, baseline_commit: snapshot.baseline_commit });
        this.store.update(task.id, { head_commit: snapshot.commit,
          integration: snapshot.commit === task.base_commit ? 'none' : 'pending',
          reservation: JSON.stringify({ ...clean, status: 'started', commit: snapshot.commit,
            baseline: snapshot.baseline_commit, started_at: new Date().toISOString() }) });
        this.store.event(child.id, 'showcase.signaled', { commit: snapshot.commit, baseline: snapshot.baseline_commit });
        this.store.event(task.id, 'task.showcase_started', { child_id: child.id, commit: snapshot.commit,
          baseline: snapshot.baseline_commit });
      });
      this.wake(child.id);
      return child;
    });
  },

  /** Reserve a dedicated, detached showcase child; the say Task remains nonterminal until that child settles. */
  async startReservedShowcase(taskId) {
    const ready = (diagnose = true) => {
      const task = this.store.task(taskId);
      const reservation = storedReservation(task.reservation);
      if (this.stopping || task.task_kind !== 'say' || reservation?.kind !== 'showcase' || reservation.status !== 'pending') return null;
      const reason = this.reservationWaitReason(task);
      if (reason) { if (diagnose) this.noteReservationBlocked(task.id, reason); return null; }
      return task;
    };
    if (!ready()) return false;
    return this.workspaces.exclusive(async () => {
      const task = ready();
      if (!task) return false;
      const eligibility = await this.showcaseEligibility(task.branch, null, null, task.id);
      if (!eligibility.allowed) { this.noteReservationBlocked(task.id, eligibility.reason); return false; }
      const { snapshot } = eligibility;
      if (!ready()) return false;
      const child = this.store.transaction(() => {
        const current = ready(false);
        check(current && current.id === task.id, 'showcase reservation changed during admission');
        check(this.store.activeTasks().length < 1000, 'too many active tasks');
        const reservation = storedReservation(current.reservation);
        const created = this.store.create({ parent_id: current.id, input_id: current.input_id, role: 'showcase',
          name: 'showcase', task_kind: 'showcase', showcase: snapshot,
          goal: `效果展示：${current.branch}\n分析固定提交 ${snapshot.commit} 相对 ${snapshot.baseline_commit} 的修改，交付展示页和可运行预览。展示不是验收，也不自动合并。` });
        const { blocked_reason: _reason, ...cleanReservation } = reservation;
        this.store.update(current.id, { head_commit: snapshot.commit,
          integration: snapshot.commit === current.base_commit ? 'none' : 'pending',
          reservation: JSON.stringify({ ...cleanReservation, status: 'started', child_id: created.id,
            commit: snapshot.commit, baseline: snapshot.baseline_commit, started_at: new Date().toISOString() }) });
        this.store.event(created.id, 'showcase.requested', snapshot);
        this.store.event(current.id, 'task.showcase_started', { child_id: created.id, commit: snapshot.commit,
          baseline: snapshot.baseline_commit });
        return created;
      });
      this.kick();
      return child;
    });
  },

  /** Child settled first; then close the original say Task without conflating showcase with Git integration. */
  settleReservedShowcase(taskId) {
    const task = this.store.task(taskId);
    const reservation = storedReservation(task.reservation);
    // `started` 是正常交付阶段；`preparing` 只在准备子 Task 失败/取消时走到这里，同样要收束原 say。
    if (task.task_kind !== 'say' || reservation?.kind !== 'showcase'
      || !['preparing','started'].includes(reservation.status) || TERMINAL.has(task.status)) return task;
    const child = this.store.task(reservation.child_id);
    if (!TERMINAL.has(child.status)) return task;
    check(child.parent_id === task.id && child.task_kind === 'showcase' && child.role === 'showcase',
      'reserved showcase child identity changed; inspect before settlement');
    const status = child.status === 'completed' ? 'completed' : child.status === 'cancelled' ? 'cancelled' : 'failed';
    return this.finish(task.id, status, child.result, child.error, { showcaseSettlement: child.id });
  },

  unreserveTask(taskId) {
    let prepChild = null;
    const result = this.store.transaction(() => {
      const task = this.store.task(id(taskId));
      check(task.task_kind === 'say', 'only new say Tasks support delivery reservations');
      if (task.reservation === null) return { task_id: task.id, reservation: null, changed: false };
      const previous = storedReservation(task.reservation);
      // 已发出但尚未集成的合并请求可以撤销：否则父分支会被一个不再成立的请求一直冻住。
      // 展示预约在准备阶段仍可撤销：随之取消那个还没交付任何东西的 prep 子 Task。
      const withdrawable = previous.version === 1 && (['pending','preparing'].includes(previous.status)
        || (previous.kind === 'merge' && previous.status === 'requested'));
      check(withdrawable, 'started reservation cannot be withdrawn; inspect task');
      this.store.update(task.id, { reservation: null });
      if (previous.kind === 'showcase' && previous.status === 'preparing' && previous.child_id) prepChild = previous.child_id;
      this.store.event(task.id, previous.status === 'requested' ? 'task.request_withdrawn' : 'task.unreserved', { reservation: previous,
        ...(previous.status === 'requested' ? { commit: previous.commit ?? null, baseline: previous.baseline ?? null,
          note: 'withdrawn without integration; the work stays on its branch' } : {}) });
      return { task_id: task.id, reservation: null, changed: true,
        withdrawn: previous.status === 'requested' ? previous : null };
    });
    if (prepChild !== null) {
      const child = this.store.task(prepChild);
      if (child && !TERMINAL.has(child.status)) this.cancel(child.id, '展示预约已撤销，准备中的展示已取消');
    }
    return result;
  },

  /** A human approves precisely the previously requested source commit and parent baseline. */
  async approveReservedMerge(taskId, commit, baseline) {
    check(typeof commit === 'string' && /^[0-9a-f]{40,64}$/.test(commit), 'approve the exact requested commit');
    check(typeof baseline === 'string' && /^[0-9a-f]{40,64}$/.test(baseline), 'approve the exact parent baseline');
    return this.workspaces.exclusive(async () => {
      const task = this.store.task(id(taskId));
      const reservation = storedReservation(task.reservation);
      check(task.task_kind === 'say' && task.status === 'completed' && reservation?.kind === 'merge'
        && ['requested','integrated'].includes(reservation.status), 'no completed merge request for this say Task');
      check(reservation.commit === commit && reservation.baseline === baseline,
        'approval does not match the frozen request commit and parent baseline');
      const parent = this.store.task(task.parent_id);
      check(['main','owner'].includes(parent.task_kind) && reservation.parent_id === parent.id,
        'only a direct main/owner Task merge request can be approved by a user');
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
    const delivery = child.task_kind === 'say' ? storedReservation(child.reservation) : null;
    check(['say','child'].includes(parent.task_kind) && child.parent_id === parent.id
      && (child.task_kind === 'child' || (delivery?.kind === 'merge' && delivery.status === 'requested')),
      'only a direct child or requested say Task of a new Task can be integrated');
    check(parent.status === 'running', 'parent Agent must be running to confirm child integration');
    check(child.status === 'completed', 'child must complete before integration');
    check(child.branch && child.target_branch === parent.branch, 'child branch has no matching parent');
    check(typeof commit === 'string' && /^[0-9a-f]{40,64}$/.test(commit) && commit === child.head_commit
      && (!delivery || delivery.commit === commit),
      'confirm the completed child’s fixed head_commit, not a moving branch');
    // 交付锁：父分支上还有别的未集成请求时，只有那个请求自己的集成能写这条分支。
    const lock = this.branchFreeze(parent.branch);
    check(!lock || (lock.kind === 'delivery' && lock.task_id === child.id),
      lock ? `branch ${parent.branch} is frozen: ${lock.reason}; cannot integrate another Task` : '');
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
          // say 自身分歧：被修复的就是这个父 Task 的交付。
          check(parent.task_kind === 'say', 'a say-only divergence resolution cannot be integrated here');
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

  /** Every new say is one Input and one branch-owning Task, regardless of whether it writes code. */
  say(content = undefined, branch = null, references = [], draftId = null) {
    return this.write('send this say', () => this.sendSay(content, branch, references, draftId));
  },

  /** The body of say(); runs under the clear gate so an anchor created before a clear cannot commit after its purge. */
  async sendSay(content = undefined, branch = null, references = [], draftId = null) {
    let draft = null, draftReferences = null;
    if (draftId !== null && draftId !== undefined) {
      check(content === undefined && references.length === 0, 'draft_id cannot be combined with content or references');
      draft = this.store.draft(id(draftId));
      check(draft.input_id === null, `draft ${draft.id} was already submitted as input ${draft.input_id}`);
      draftReferences = this.store.draftReferences(draft.id);
      content = draft.content;
      references = draftReferences;
    }
    text(content, 'input');
    const normalized = this.normalizeReferences(references);
    if (branch !== null && branch !== undefined) text(branch, 'branch');
    const target = branch ?? await this.workspaces.git(this.config.project, 'symbolic-ref', '--short', 'HEAD')
      .catch(() => { throw new Error('select a local parent branch before sending from detached HEAD'); });
    this.assertBranchWritable(target, 'create a new task on it');
    if (target === 'main') await this.ensureMainTask();
    const owner = this.store.all("SELECT * FROM tasks WHERE branch=? AND task_kind IN ('main','owner','say') ORDER BY id", target);
    check(owner.length === 1, `branch ${target} needs exactly one explicitly bound Task before say`);
    const parent = owner[0];
    check(!TERMINAL.has(parent.status), `parent task #${parent.id} has ended; select an active parent Task`);
    check(parent.task_kind !== 'say' || storedReservation(parent.reservation)?.status !== 'started',
      'parent say Task is presenting its frozen commit; select another bound branch');
    // anchorInput always passes the chosen ref, never the possibly changed process HEAD.
    const { inputId, anchor } = await this.anchorInput(target);
    try {
      // Git was asynchronous: a clear may have started while the anchor was being created.
      this.assertWritable('send this say');
      const result = this.store.transaction(() => {
        const current = this.store.task(parent.id);
        check(!TERMINAL.has(current.status) && current.branch === target, 'parent task changed while creating the worktree');
        if (draft) {
          const live = this.store.draft(draft.id);
          check(live.input_id === null && live.content === draft.content
            && JSON.stringify(this.store.draftReferences(draft.id)) === JSON.stringify(draftReferences),
            `draft ${draft.id} changed while being submitted; retry with its latest contents`);
        }
        this.store.run(`INSERT INTO inputs(id,content,anchor_branch,anchor_commit,anchor_workspace,anchor_target_branch)
          VALUES (?,?,?,?,?,?)`, inputId, content, anchor.branch, anchor.commit, anchor.workspace, anchor.target);
        this.store.setInputReferences(inputId, normalized.map(reference => ({ segment: 1, reference })));
        const task = this.store.create({ parent_id: parent.id, input_id: inputId, role: 'agent', goal: content,
          name: `say-${inputId}`, task_kind: 'say' });
        this.store.update(task.id, { branch: anchor.branch, workspace: anchor.workspace,
          base_commit: anchor.commit, target_branch: target });
        this.store.run('UPDATE inputs SET task_id=? WHERE id=?', task.id, inputId);
        const attached = this.store.run('UPDATE branches SET task_id=? WHERE branch=? AND task_id IS NULL', task.id, anchor.branch);
        check(attached.changes === 1, 'input branch already belongs to another task');
        if (draft) {
          this.store.run('UPDATE drafts SET input_id=? WHERE id=?', inputId, draft.id);
          this.store.event(task.id, 'input.draft', { draft_ids: [draft.id] });
        }
        this.store.event(task.id, 'input.anchor', { input_id: inputId, branch: anchor.branch, commit: anchor.commit,
          target_branch: target, workspace: anchor.workspace, dirty_source: anchor.dirty_source });
        return { id: inputId, content, references: normalized, task: this.store.task(task.id), anchor,
          ...(draft ? { draft: draft.id } : {}) };
      });
      this.kick();
      return result;
    } catch (error) {
      await this.workspaces.releaseAnchor(anchor)
        .catch(failure => console.error(`say ${inputId}: anchor cleanup failed: ${failure.message}`));
      throw error;
    }
  },
};
