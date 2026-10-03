import { check, id, text, TERMINAL, isSettled } from '../types.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing, consumeIntegratedReservation, resumeTaskDelivery } from './iteration.js';
import fs from 'node:fs';
import path from 'node:path';
import { readInputRule, saveInputRule, snapshotPath } from '../task-input-rule.js';
import { forkCheckpoint } from '../../agent/fork.js';
import { checkDraftRevision } from './input-history.js';

function storedReservation(raw) {
  if (raw === null) return null;
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error('reservation state is invalid; inspect worker before changing it'); }
  check(value && typeof value === 'object' && !Array.isArray(value) && [1,2].includes(value.version)
    && value.kind === 'merge' && typeof value.status === 'string',
  'reservation state is invalid; inspect worker before changing it');
  return value;
}

/** 请求失效的唯一诊断文案：三个触发点（父分支自己提交 / 集成 / 批准）说同一句话，才不会被去重成多条事件。 */
function assertQuietResolutionParent(project, parent) {
  check(!project.running.has(parent.id) && !['running', 'queued'].includes(parent.status),
    `父Worker #${parent.id} 尚未到安全点；等待当前 Agent 调用结束后再冻结并派解分歧 Worker`);
}

function parentMovedReason(branch, parentHead, commit) {
  return `父分支 ${branch} 在本请求发出后被推进到 ${String(parentHead).slice(0, 12)}，`
    + `固定提交 ${String(commit).slice(0, 12)} 已不能快进：撤销这个请求（Worker、分支与提交保留），`
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
    check(existing.length <= 1, 'main branch has more than one owning worker');
    if (existing.length) return existing[0];
    let commit = null;
    try {
      await this.workspaces.git(this.config.project, 'show-ref', '--verify', 'refs/heads/main');
      commit = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', 'refs/heads/main^{commit}');
    } catch { /* no local main ref */ }
    check(commit, 'the new order protocol needs a local main branch; no branch was created automatically');
    return this.store.transaction(() => {
      const root = this.store.create({ role: 'agent', goal: '管理 main 分支及子Worker合并请求', name: 'main', task_kind: 'main' });
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
    this.assertBranchWritable(branch, 'bind it to a new Worker');
    return this.workspaces.exclusive(async () => {
      const actual = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
        .catch(() => { throw new Error(`local branch ${branch} does not exist`); });
      check(actual === commit, `branch ${branch} moved; confirm its current HEAD before binding`);
      const old = this.store.branch(branch);
      check(!old || !['deleted','archived'].includes(old.status), `branch ${branch} has a deleted/archived historical record; inspect before binding`);
      const unfinished = this.store.get(`SELECT t.id FROM tasks t LEFT JOIN inputs i ON i.id=t.input_id
        WHERE t.task_kind IS NULL AND t.status NOT IN ('completed','failed','cancelled')
          AND (t.branch=? OR t.target_branch=? OR i.anchor_branch=?) LIMIT 1`, branch, branch, branch);
      check(!unfinished, `branch ${branch} still has an active old worker #${unfinished?.id}; finish it before binding`);
      return this.store.transaction(() => {
        const owners = this.store.all("SELECT id FROM tasks WHERE branch=? AND task_kind IN ('main','owner','order','say')", branch);
        check(owners.length === 0, `branch ${branch} already has a new Worker owner`);
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
    check(['main','owner'].includes(parent.task_kind), 'only a branch owner Worker analyzes its branch on demand');
    text(question, 'question');
    check(question.length <= 4000, 'analysis question exceeds 4000 characters');
    check(!TERMINAL.has(parent.status), 'branch owner has ended; bind the branch again first');
    return this.workspaces.exclusive(async () => {
      const branch = parent.branch;
      check(branch, `worker #${parent.id} owns no branch to analyze`);
      const commit = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
        .catch(() => { throw new Error(`local branch ${branch} does not exist; nothing to analyze`); });
      const created = this.store.transaction(() => {
        const owner = this.store.task(parent.id);
        check(!TERMINAL.has(owner.status) && owner.branch === branch, 'branch owner changed while starting analysis');
        check(this.store.activeTasks().length < 1000, 'too many active workers');
        const task = this.store.create({ parent_id: owner.id, input_id: null, role: 'agent', task_kind: 'analysis',
          goal: question });
        this.store.update(task.id, { target_branch: branch, base_commit: commit });
        this.store.event(task.id, 'task.analyze_requested', { parent_id: owner.id, branch, commit });
        return task;
      });
      // Read-only tasks still fork a private checkout at creation. They never own a
      // writable branch; their Pi conversation can fork from the same frozen commit.
      const dir = path.join(this.config.home, 'worktrees', `task-${created.id}-analysis`);
      try {
        this.store.update(created.id, { baseline_workspace: dir });
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await this.workspaces.git(this.config.project, 'worktree', 'add', '--detach', dir, commit);
        this.store.event(created.id, 'analysis.checkout', { workspace: dir, commit, branch });
        const pointer = this.store.get('SELECT session_path AS session, entry_id AS entry FROM commit_contexts WHERE commit_hash=?', commit);
        if (pointer) forkCheckpoint(this.config.home, { ...pointer, commit });
      } catch (error) {
        this.store.transaction(() => {
          this.store.update(created.id, { status: 'failed', error: `analysis fork failed: ${error.message}` });
          const eventId = this.store.event(created.id, 'analysis.fork_failed', { error: error.message });
          this.notifyTaskLifecycle(created.id, eventId);
        });
        throw new Error(`analysis #${created.id} fork failed; inspect its checkout: ${error.message}`);
      }
      this.kick();
      return { status: 'queued', task: this.progressView(created), branch, commit };
    });
  },

  /**
   * 用户专属：把一个**没有代码改动**的 order 标记为「已解决」。它与「放弃任务」区分开：
   * 前者表示这次输入只是想了解/确认、你已经没有别的需求；后者是因为别的原因放弃正在进行的工作。
   * 只有分支没有新提交、工作区干净、没有正在调用的 Agent，且没有发出的合并请求时才允许；
   * 有提交的 order 请走「请求合并」交付，或直接「放弃任务」。结算后照常落一条完成提醒。
   */
  async resolveTask(taskId) {
    const target = id(taskId);
    const task = this.store.task(target);
    assertTaskNotSyncing(this, task.id);
    check(task.task_kind === 'order', 'only a new order Worker can be marked resolved');
    check(!TERMINAL.has(task.status), 'worker already ended; retry it or send a new input');
    check(!this.running.has(task.id), 'Agent 正在调用，等本轮安全结束后再标记已解决');
    const reservation = storedReservation(task.reservation);
    check(reservation?.kind !== 'merge' || reservation.status !== 'requested',
      '这条指令已经有发出的合并请求；请先批准或撤销请求，再标记已解决');
    check(!task.head_commit || !task.base_commit || task.head_commit === task.base_commit,
      '这条指令已经有提交；请用「请求合并」交付，或用「放弃 Worker」放弃');
    return this.workspaces.exclusive(async () => {
      // 清理工作区并复核任务分支与顶端提交；有未提交改动或换过分支会在这里拒绝。
      await this.workspaces.finish(task);
      const current = this.store.task(task.id);
      check(current.head_commit === current.base_commit,
        '这条指令已经有提交；请用「请求合并」交付，或用「放弃 Worker」放弃');
      return this.finish(current.id, 'completed', current.result, null, { resolvedByUser: true });
    });
  },

  /** Persistent merge intention; not an authorization to mutate Git. */
  async reserveTask(taskId, kind) {
    assertTaskNotSyncing(this, id(taskId));
    check(kind === 'merge', 'reservation kind must be merge');
    const code = this.store.task(id(taskId));
    if (code.task_kind === 'child' || !code.reservation || JSON.parse(code.reservation)?.version === 2)
      return this.requestTaskMerge(taskId);
    const accepted = this.store.transaction(() => {
      const task = this.store.task(id(taskId));
      check(task.task_kind === 'order', 'only new order Workers support delivery reservations');
      check(!TERMINAL.has(task.status), 'cannot reserve an ended order Worker');
      const previous = storedReservation(task.reservation);
      check(!previous || (previous.version === 1 && previous.status === 'pending' && previous.kind === 'merge'),
        'reservation state needs inspection before changing it');
      check(!previous || previous.kind === kind, `worker #${task.id} already reserves ${previous?.kind}; unreserve it before choosing ${kind}`);
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

  /**
   * 用户专属：把一条目标分支（例如 main）下所有已静息、待合并的 Task 一次性放进父 Task 的 merge 子任务。
   * 每条仍走与单条 `worker.reserve` 完全相同的准入（静息、工作区、固定提交、父基线、子分支收拢），
   * 所以这里只是把「逐条点请求合并」收成一个入口，不新增任何绕过校验的捷径；不满足条件的保持 pending
   * 预约并记录 `blocked_reason`，由 merge 队列按 id 顺序串行落地。返回逐条结果供界面汇总。
   */
  async reserveMergeAll(targetBranch) {
    const name = String(targetBranch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    // 只有还停在自己分支上、尚未集成的 order/child 才有资格。
    const rows = this.store.all(`SELECT id FROM tasks
      WHERE task_kind IN ('order','say','child') AND status='waiting' AND integration='pending' AND target_branch=?
        AND (reservation IS NULL OR json_extract(reservation,'$.kind')='merge')
      ORDER BY id`, name);
    const tasks = [];
    for (const row of rows) {
      try {
        const booked = await this.reserveTask(row.id, 'merge');
        const reservation = booked.reservation ?? null;
        tasks.push({ id: row.id,
          status: reservation?.status === 'requested' ? 'requested' : 'blocked',
          reservation, blocked_reason: reservation?.blocked_reason ?? null });
      } catch (error) {
        tasks.push({ id: row.id, status: 'failed', error: error.message });
      }
    }
    return { target_branch: name, total: rows.length,
      requested: tasks.filter(task => task.status === 'requested').length,
      blocked: tasks.filter(task => task.status === 'blocked').length,
      failed: tasks.filter(task => task.status === 'failed').length, tasks };
  },

  /** 阻塞诊断：pending 是“还没能满足”，requested 是“已发出的请求失效了”。两种情况都只记录上次检查的快照。 */
  noteReservationBlocked(taskId, reason, code = null) {
    this.store.transaction(() => {
      const task = this.store.task(taskId);
      const reservation = storedReservation(task.reservation);
      if (reservation?.kind !== 'merge' || !['pending','requested','resolving'].includes(reservation.status)) return;
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
    if (task.task_kind !== 'order' || reservation?.kind !== 'merge' || reservation.status !== 'requested') return null;
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
        `固定提交 ${String(commit).slice(0, 12)} 已经在 ${parent.branch} 里：让直接父 Agent 确认（父为指令），`
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
            ? `解分歧子Worker #${previous.id} ${previous.status} 且尚未集成；先检查现场。若需重新派 Worker，须显式归档 ${previous.branch}（保留 Worker 和会话，脏工作区需用户另行确认丢弃）。`
            : `解分歧子Worker #${previous.id} ${previous.status} 且尚未集成；先检查现场。完成的结果可由指令 Agent 确认固定提交；若需重新派 Worker，须显式归档 ${previous.branch}（保留 Worker 和会话，脏工作区需用户另行确认丢弃）。` }
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
      const goal = `在独立子Worker工作区解决指令 #${source.id} 与直接父分支 ${parent.branch} 的分歧。\n`
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
        this.store.update(child.id, { base_commit: state.child_head, target_branch: live.branch });
        this.store.event(child.id, 'task.divergence_resolution_requested', { source_task_id: live.id,
          source_commit: state.child_head, parent_task_id: parent.id, parent_branch: parent.branch,
          parent_commit: state.parent_head });
        this.store.update(live.id, { reservation: JSON.stringify({ ...currentReservation,
          blocked_reason: terminal
            ? `等待独立解分歧子Worker #${child.id} 完成后由 runtime 推进指令分支并重新发合并请求`
            : `等待解分歧子Worker #${child.id} 完成并由指令 Agent 确认集成`,
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
      blocked_reason: `解分歧子Worker #${resolution.id} ${status}${error ? `：${error}` : ''}；检查现场后显式归档旧分支再重新派。`,
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
          reason: `解分歧子Worker #${previous.id} 已结束且尚未集成；先检查现场。若需重做，由用户显式归档 ${previous.branch} 后再调用本接口（不会重放上一次 Agent）。` }
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
      const goal = `在独立子Worker工作区解决子Worker #${live.id} 与直接父分支 ${parent.branch} 的分歧。\n`
        + `基线是固定子提交 ${state.child_head}。请将固定父提交 ${state.parent_head} 合入本工作区（不要合入会移动的分支名）；`
        + `如有冲突，保留双方意图并解决，运行相关测试，再提交结果。只改自己的子Worker分支，`
        + `不可修改 #${live.id} 或 ${parent.branch}；完成后由 runtime 核对两端固定提交，依次快进 #${live.id} 与 #${parent.id} 的分支。`;
      const created = this.store.transaction(() => {
        const current = this.store.task(live.id), owner = this.store.task(parent.id);
        check(owner.status === 'running' && current.status === 'completed' && current.integration !== 'merged'
          && current.head_commit === state.child_head && current.parent_id === owner.id,
        'child or parent changed while starting divergence repair');
        check(this.store.activeTasks().length < 1000, 'too many active workers');
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
      this.requestPreempt(parent.id, '解分歧已冻结父子分支，等待本轮安全结束');
      this.kick();
      return { status: 'queued', task: this.progressView(created), source_commit: state.child_head,
        parent_commit: state.parent_head };
    });
  },

  /** Read-only request readiness, shared by detail and graph; Git admission still runs on reserve. */
  mergeReadiness(task) {
    if (!['order','child'].includes(task.task_kind)) return null;
    const reason = this.reservationWaitReason(task);
    if (reason) return { ready: false, reason };
    if (task.integration !== 'pending' || !task.branch || !task.head_commit
      || !task.base_commit || task.head_commit === (task.iteration_base_commit ?? task.base_commit))
      return { ready: false, reason: '没有登记的待交付提交，等待本轮工作完成' };
    return { ready: true, reason: null };
  },

  /** An observable execution barrier, not a Git verdict. A retry never skips a running invocation or unread signal. */
  reservationWaitReason(task) {
    if (this.taskSyncBusy?.has(task.id)) return 'Worker 父分支同步正在执行，请等待安全点';
    const inbound = this.activeTaskMerge(task.id);
    if (inbound) return `等待子Worker #${inbound.id} 的父分支执行位释放`;
    if (this.running.has(task.id) || task.status === 'running') return 'Agent 正在调用或收尾，等待本轮安全结束';
    if (task.status === 'queued') return 'Worker 等待下一轮 Agent 调用完成';
    if (task.status === 'awaiting' || this.questionPending(task.id)) return 'Worker 正在等待用户答复';
    if (task.status !== 'waiting') return `Worker 尚未静息（${task.status}）`;
    const child = this.store.children(task.id).find(row => !isSettled(row));
    if (child) return `等待子Worker #${child.id} 结算`;
    if (this.hasActionableMessages(task.id)) return '还有未处理的消息或子Worker信号，需先交给 Agent';
    return null;
  },

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

  unreserveTask(taskId) {
    const requested = this.store.task(id(taskId));
    assertTaskNotSyncing(this, requested.id);
    const automatic = this.autoMergeView(requested);
    check(!automatic?.locked, '父Worker派生的子Worker自动合并已锁定，不能撤销；如需停止工作，请取消 Worker');
    // A persistent hook would immediately recreate an automatic intention. Make
    // the user explicitly switch it off (with the same readiness gate) instead.
    check(!automatic?.enabled || !requested.reservation || !JSON.parse(requested.reservation).auto_merge,
      '请关闭自动合并开关，不要通过撤销请求关闭持久 hook');
    if (['order','child'].includes(requested.task_kind) && requested.reservation
      && JSON.parse(requested.reservation)?.version === 2) {
      const booking = JSON.parse(requested.reservation);
      const abandonedRepair = booking.status === 'resolving' && ['failed','cancelled'].includes(requested.status)
        && !this.running.has(requested.id);
      check(booking.status === 'pending' || abandonedRepair,
        'a sent merge request cannot be withdrawn; wait for integration or resolve the divergence');
      this.store.transaction(() => {
        this.store.update(requested.id, { reservation: null });
        this.store.event(requested.id, 'task.unreserved', { reservation: booking });
      });
      if (abandonedRepair && booking.parent_id) this.scheduleTaskMerge(booking.parent_id);
      return { task_id: requested.id, reservation: null, changed: true };
    }
    const result = this.store.transaction(() => {
      const task = this.store.task(id(taskId));
      check(task.task_kind === 'order', 'only new order Workers support delivery reservations');
      if (task.reservation === null) return { task_id: task.id, reservation: null, changed: false };
      const previous = storedReservation(task.reservation);
      if (previous.blocked_code === 'resolving' && previous.resolution_child_id) {
        const resolution = this.store.task(previous.resolution_child_id);
        check(TERMINAL.has(resolution.status) && (resolution.integration === 'merged'
          || !resolution.branch || this.store.branch(resolution.branch)?.status === 'archived'),
        `解分歧 Worker #${resolution.id} 仍占用冻结；先等待它落地，或取消并显式归档其分支`);
      }
      // 已发出但尚未集成的合并请求可以撤销：否则父分支会被一个不再成立的请求一直冻住。
      const withdrawable = previous.version === 1 && previous.kind === 'merge'
        && ['pending','requested'].includes(previous.status);
      check(withdrawable, 'started reservation cannot be withdrawn; inspect worker');
      this.store.update(task.id, { reservation: null });
      this.store.event(task.id, previous.status === 'requested' ? 'task.request_withdrawn' : 'task.unreserved', { reservation: previous,
        ...(previous.status === 'requested' ? { commit: previous.commit ?? null, baseline: previous.baseline ?? null,
          note: 'withdrawn without integration; the work stays on its branch' } : {}) });
      return { task_id: task.id, reservation: null, changed: true,
        withdrawn: previous.status === 'requested' ? previous : null };
    });
    return result;
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

  /** Every new order is one Input and one branch-owning Task, regardless of whether it writes code. */
  order(content = undefined, branch = null, references = [], draftId = null, start = true, expectedRevision = undefined) {
    return this.write('send this order', () => this.sendOrder(content, branch, references, draftId, start, expectedRevision));
  },

  /** The body of order(); runs under the clear gate so an anchor created before a clear cannot commit after its purge. */
  async sendOrder(content = undefined, branch = null, references = [], draftId = null, start = true, expectedRevision = undefined) {
    let draft = null, draftReferences = null;
    const buffered = expectedRevision !== undefined;
    if (draftId !== null && draftId !== undefined) {
      check(content === undefined && references.length === 0, 'draft_id cannot be combined with content or references');
      draft = this.store.draft(id(draftId));
      check(draft.input_id === null, `draft ${draft.id} was already submitted as input ${draft.input_id}`);
      if (buffered) {
        checkDraftRevision(draft, expectedRevision);
        check(draft.parent_id !== null, 'legacy draft has no saved parent Worker; edit it and explicitly select a parent before sending');
        branch = this.assertInputParent(draft.parent_id).branch;
      }
      draftReferences = this.store.draftReferences(draft.id);
      content = draft.content;
      references = draftReferences;
    }
    text(content, 'input');
    const normalized = this.normalizeReferences(references);
    if (branch !== null && branch !== undefined) text(branch, 'branch');
    const target = branch ?? await this.workspaces.git(this.config.project, 'symbolic-ref', '--short', 'HEAD')
      .catch(() => { throw new Error('select a local parent branch before sending from detached HEAD'); });
    this.assertBranchWritable(target, 'create a new worker on it');
    if (target === 'main') await this.ensureMainTask();
    const owner = this.store.all("SELECT * FROM tasks WHERE branch=? AND task_kind IN ('main','owner','order','say') ORDER BY id", target);
    check(owner.length === 1, `branch ${target} needs exactly one explicitly bound Worker before order`);
    const parent = owner[0];
    if (buffered) check(parent.id === draft.parent_id, 'saved parent Worker changed; edit the draft before sending');
    assertTaskNotSyncing(this, parent.id);
    check(!TERMINAL.has(parent.status), `parent worker #${parent.id} has ended; select an active parent Worker`);
    assertTaskAncestorsOpen(this, parent);
    // anchorInput always passes the chosen ref, never the possibly changed process HEAD.
    const { inputId, anchor } = await this.anchorInput(target);
    let ruleTaskId = null;
    try {
      const pointer = this.store.get('SELECT session_path AS session, entry_id AS entry FROM commit_contexts WHERE commit_hash=?', anchor.commit);
      if (pointer) forkCheckpoint(this.config.home, { ...pointer, commit: anchor.commit });
      const rule = await readInputRule(this.workspaces, this.config.project, anchor.commit);
      // Git was asynchronous: a clear may have started while the anchor was being created.
      this.assertWritable('send this order');
      const result = this.store.transaction(() => {
        const current = this.store.task(parent.id);
        if (buffered) this.assertInputParent(draft.parent_id, target);
        check(!TERMINAL.has(current.status) && current.branch === target, 'parent worker changed while creating the worktree');
        assertTaskAncestorsOpen(this, current);
        assertTaskNotSyncing(this, current.id);
        resumeTaskDelivery(this, current.id, 'new child input');
        if (current.status === 'awaiting_acceptance') {
          consumeIntegratedReservation(this, current, 'new child input');
          this.store.update(current.id, { status: 'waiting' });
        }
        if (draft) {
          const live = this.store.draft(draft.id);
          if (buffered) {
            checkDraftRevision(live, expectedRevision);
            check(live.parent_id === draft.parent_id, 'draft parent changed while being submitted');
          }
          check(live.input_id === null && live.content === draft.content
            && JSON.stringify(this.store.draftReferences(draft.id)) === JSON.stringify(draftReferences),
            `draft ${draft.id} changed while being submitted; retry with its latest contents`);
        }
        this.store.run(`INSERT INTO inputs(id,content,anchor_branch,anchor_commit,anchor_workspace,anchor_target_branch)
          VALUES (?,?,?,?,?,?)`, inputId, content, anchor.branch, anchor.commit, anchor.workspace, anchor.target);
        this.store.setInputReferences(inputId, normalized.map(reference => ({ segment: 1, reference })));
        const task = this.store.create({ parent_id: parent.id, input_id: inputId, role: 'agent', goal: content,
          name: `order-${inputId}`, task_kind: 'order' });
        this.store.update(task.id, { branch: anchor.branch, workspace: anchor.workspace,
          auto_merge: JSON.stringify({ version: 1, enabled: false, locked: false }),
          base_commit: anchor.commit, target_branch: target, ...(start ? {} : { status: 'paused' }) });
        if (rule !== null) {
          ruleTaskId = task.id;
          saveInputRule(this.config.home, task.id, rule);
          this.store.event(task.id, 'task.input_rule_frozen', { source: '.lush-task/input.mjs', commit: anchor.commit });
        }
        this.store.run('UPDATE inputs SET task_id=? WHERE id=?', task.id, inputId);
        const attached = this.store.run('UPDATE branches SET task_id=? WHERE branch=? AND task_id IS NULL', task.id, anchor.branch);
        check(attached.changes === 1, 'input branch already belongs to another worker');
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
      if (ruleTaskId !== null) fs.rmSync(snapshotPath(this.config.home, ruleTaskId), { force: true });
      await this.workspaces.releaseAnchor(anchor)
        .catch(failure => console.error(`order ${inputId}: anchor cleanup failed: ${failure.message}`));
      throw error;
    }
  },
};
