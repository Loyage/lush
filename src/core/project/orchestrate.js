import { check, TERMINAL } from '../types.js';
import { descendantsOf } from '../genealogy.js';

/**
 * 合并编排：在 main / owner 下派一个真正的 `task_kind='merge'` 编排 Task，用户确认一次完整计划后，
 * runtime 按叶子→根的固定顺序自动把所有待合并的 say 子分支 ff-only 收拢进目标分支；遇到分歧自动在源侧
 * 派独立解分歧子 Task，等它结算后继续；直到全部完成、失败或用户取消。
 *
 * 与旧 `branch.merge_all`（`project/merge-all.js`）的关系：
 * - 复用同一份「目标分支附属的 `branches.merge_run` versioned JSON」运行态与同一套分支写冻结
 *   （`branch-freeze.js` 只按 active run 现算，不看 mode），所以两者共用冻结、取消释放与恢复语义。
 * - 但本文件的执行面只面向新交付模型：每条待合并项是一个已固定 commit + 父基线的 `task_kind='say'`
 *   合并请求；落地走 `mergeBranchUnsafe`（ff-only），绝不 no-ff、绝不 rebase，也不经旧
 *   `branch.merge` / `branch.sync` 绕过固定 commit 校验。
 * - `merge_run` 用 `mode:'orchestrate'` 与 `task_id` 区分旧一键合并；旧 driver 见到 orchestrate run 会退出，
 *   本 driver 见到旧 run 同样退出。
 *
 * 不新增表 / 列 / 业务实体：编排 Task 承载 status / result / 可 inspect / 可取消，运行态仍在
 * `branches.merge_run`（只加 `mode` / `task_id` 字段，遵循「只加不改」）。
 */
const MERGE_TASK_GOAL = target => `合并编排：把 ${target} 下所有待合并的 say 子分支按叶子到根自动 ff-only 收拢。\n`
  + '本任务由 runtime 驱动（没有 agent invocation）：只在用户确认计划一次后自动执行，遇分歧自动派源侧解分歧子任务，'
  + '直到全部合并、失败或用户取消。用户可在分支图或 `lush branch orchestrate-cancel` 取消。';

/** 解析 say Task 的预约 JSON；损坏值按「没有预约」处理，不抛错拦住整条读面。 */
function reservationOf(task) {
  if (!task?.reservation) return null;
  try { const value = JSON.parse(task.reservation); return value && typeof value === 'object' ? value : null; }
  catch { return null; }
}

const RESUMABLE = new Set(['running', 'paused']);

export default {
  /**
   * 只读编排计划：目标分支的整棵后代子树里，每个 say 子分支给出固定 commit、父基线、当前分支状态
   * （fast_forward / diverged / integrated / missing）、动作（merge / resolve / skip）与 blockers。
   * 按「叶子在前」排序（谱系深度降序，其次创建时间、名字）。执行时逐条重算，不信任这份快照。
   */
  async orchestratePlan(targetBranch) {
    const name = String(targetBranch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    const rows = this.store.branches().filter(row => row.status === 'active');
    const byBranch = new Map(rows.map(row => [row.branch, row]));
    const descendants = descendantsOf(rows, name);
    const depth = branch => { let d = 0; for (let cur = branch; cur && cur !== name; cur = byBranch.get(cur)?.parent ?? null) { d++; if (d > 1000) break; } return d; };
    const sayByBranch = new Map();
    for (const say of this.store.all("SELECT * FROM tasks WHERE task_kind='say' ORDER BY id")) {
      if (say.branch) sayByBranch.set(say.branch, say);
    }
    const sorted = descendants.slice().sort((a, b) => depth(b) - depth(a)
      || String(byBranch.get(a)?.created_at ?? '').localeCompare(String(byBranch.get(b)?.created_at ?? ''))
      || a.localeCompare(b));
    const items = [];
    for (const branch of sorted) {
      const say = sayByBranch.get(branch) ?? null;
      let state;
      try { state = await this.workspaces.branchState(branch); }
      catch (error) {
        items.push({ branch, task_id: say?.id ?? null, parent: byBranch.get(branch)?.parent ?? null, depth: depth(branch),
          status: 'unknown', action: 'skip', ready: false, commit: null, baseline: null, blockers: [error.message] });
        continue;
      }
      const reservation = reservationOf(say);
      const merge = reservation?.kind === 'merge' ? reservation : null;
      const commit = merge?.commit ?? say?.head_commit ?? state.child_head ?? null;
      const baseline = merge?.baseline ?? state.parent_head ?? null;
      // 分支自己的 owner Task 就是这条 say；它未终结不该算「子分支未收拢」阻塞，过滤掉自己的 task 标记。
      const blockers = state.blockers.filter(item => item !== `task:#${say?.id}`);
      let action = 'skip';
      let autoRequest = false;
      if (!say) blockers.push('该分支没有 say Task 拥有');
      // 已经在父分支历史里（含没有预约的旧提交）：明确报「已合入」，不再拿「没有合并预约」误导用户。
      else if (state.status === 'integrated' || merge?.status === 'integrated') action = 'skip';
      else if (merge) {
        if (reservation.blocked_code === 'resolving') blockers.push('已有解分歧子任务在处理');
        else if (!['waiting', 'completed'].includes(say.status)) blockers.push(`say #${say.id} 仍在 ${say.status}`);
        else if (!['pending', 'requested'].includes(reservation.status)) blockers.push(`预约状态 ${reservation.status}`);
        else if (state.status === 'diverged') action = 'resolve';
        else if (state.status === 'fast_forward') {
          if (reservation.status === 'requested' && reservation.commit && state.child_head !== reservation.commit) {
            blockers.push(`源分支顶端已是 ${String(state.child_head).slice(0, 12)}，不再是固定提交 ${String(reservation.commit).slice(0, 12)}`);
          } else action = 'merge';
        } else blockers.push(`无法从 ${state.status} 分支合并`);
      } else {
        // 没有合并预约：用户确认整份计划后由编排代发固定提交请求（见 autoReserveOrchestratedMerge）。
        const autoBlockers = this.autoRequestBlockers(say, state);
        if (autoBlockers.length) blockers.push(...autoBlockers);
        else { autoRequest = true; action = state.status === 'diverged' ? 'resolve' : 'merge'; }
      }
      if (action === 'resolve' && say?.parent_id) {
        const owner = this.store.task(say.parent_id);
        if (this.running.has(owner.id) || owner.status === 'running')
          blockers.push(`父 Task #${owner.id} 正在调用；编排先冻结，等安全点再派解分歧`);
      }
      const ready = action !== 'skip' && blockers.length === 0;
      items.push({ branch, task_id: say?.id ?? null, parent: state.parent ?? byBranch.get(branch)?.parent ?? null,
        depth: depth(branch), status: state.status, commit, baseline, action, ready, auto_request: autoRequest,
        blockers: [...new Set(blockers)] });
    }
    const order = items.filter(item => item.action !== 'skip').map(item => item.branch);
    const run = this.store.branchMergeRun(name);
    return { target_branch: name, items, order,
      ready: items.filter(item => item.ready).length, total: items.length,
      frozen: Boolean(this.branchFreeze().find(row => row.branch === name)),
      active_run: run && RESUMABLE.has(run.status) ? run : null };
  },

  /**
   * 用户确认计划一次后开始编排：落一条 `task_kind='merge'` 的编排 Task（parent 是目标分支的 main/owner），
   * 把运行写入目标分支 `merge_run`（`mode:'orchestrate'`），然后由 runtime 异步驱动。目标已有运行在跑时拒绝。
   * 免逐条批准的范围仅限：「按这份只读计划，把已固定 commit+父基线的 say 请求 ff-only 落地，分歧时在源侧派解分歧子任务」，
   * 不包含 no-ff / rebase、不绕过固定 commit 校验、也不允许 main Agent 自己发起。
   */
  async orchestrate(targetBranch) {
    const name = String(targetBranch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    const run = this.store.branchMergeRun(name);
    check(!run || !RESUMABLE.has(run.status), `${name} already has an active merge run`);
    const plan = await this.orchestratePlan(name);
    await this.ensureMergeTarget(name);
    let owner = this.store.get(`SELECT * FROM tasks WHERE branch=? AND task_kind IN ('main','owner') AND status NOT IN ('completed','failed','cancelled') ORDER BY id`, name);
    if (!owner && name === 'main') owner = await this.ensureMainTask();
    check(owner, `branch ${name} has no main/owner Task to own the merge orchestration; bind it first`);
    if (!plan.order.length) return { target_branch: name, status: 'empty', plan };
    const now = new Date().toISOString();
    const created = this.store.transaction(() => {
      check(this.store.activeTasks().length < 1000, 'too many active tasks');
      const task = this.store.create({ parent_id: owner.id, input_id: null, role: 'agent', task_kind: 'merge',
        name: `merge-${name.split('/').at(-1).slice(0, 24)}`, goal: MERGE_TASK_GOAL(name) });
      this.store.update(task.id, { status: 'waiting', target_branch: name });
      const record = { version: 1, mode: 'orchestrate', task_id: task.id, status: 'running', order: plan.order, index: 0,
        done: [], skipped: [], waiting_task_id: null, started_at: now, updated_at: now };
      this.store.setBranchMergeRun(name, record);
      this.store.event(task.id, 'merge.orchestrate.started', { target: name, order: plan.order });
      this.store.event(owner.id, 'merge.orchestrate.started', { target: name, task_id: task.id });
      return this.store.task(task.id);
    });
    this.scheduleOrchestrate(name);
    return { target_branch: name, status: 'running', task: this.progressView(created), plan,
      run: this.store.branchMergeRun(name) };
  },

  /** 取消编排：先清运行（释放冻结），再取消等待中的解分歧子任务，最后把编排 Task 结算为 cancelled；已落地的合并不回滚。 */
  cancelOrchestrate(targetBranch) {
    const name = String(targetBranch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    const run = this.store.branchMergeRun(name);
    check(run && run.mode === 'orchestrate' && RESUMABLE.has(run.status), `${name} has no active merge orchestration to cancel`);
    const taskId = run.task_id ?? null;
    const waitingId = run.waiting_task_id ?? null;
    this.store.transaction(() => {
      this.store.setBranchMergeRun(name, null);
      this.store.event(taskId, 'merge.orchestrate.cancelled', { target: name, done: run.done ?? [],
        pending: (run.order ?? []).filter(branch => !(run.done ?? []).includes(branch)) });
    });
    if (waitingId !== null) {
      const waiting = this.store.task(waitingId);
      if (waiting && !TERMINAL.has(waiting.status)) this.cancel(waiting.id, '合并编排已取消');
    }
    if (taskId !== null) {
      const task = this.store.task(taskId);
      if (task && !TERMINAL.has(task.status)) this.finish(taskId, 'cancelled', null, '合并编排已取消');
    }
    return { target_branch: name, status: 'cancelled', task_id: taskId, done: run.done ?? [] };
  },

  /** 单飞调度：与旧一键合并共用 `mergeRunsDriving`，同一目标同时只有一个 driver。 */
  scheduleOrchestrate(target) {
    if (this.stopping || this.mergeRunsDriving.has(target)) return;
    queueMicrotask(() => {
      if (this.stopping) return;
      const run = this.store.branchMergeRun(target);
      const drive = run?.mode === 'orchestrate' ? () => this.driveOrchestrate(target) : () => this.driveMergeRun(target);
      drive().catch(error => {
        console.error(`merge run ${target}: ${error.stack || error}`);
        try {
          const current = this.store.branchMergeRun(target);
          if (current?.mode === 'orchestrate') this.finishOrchestrate(target, 'failed', null, error.message);
          else this.finishMergeRun(target, 'failed', error.message);
        } catch { /* 终态清理失败不再递归 */ }
      });
    });
  },

  /**
   * 逐条推进：每轮重读运行与每条分支实时状态。分歧时在源侧建独立解分歧子 Task，运行置 paused 停在这里；
   * 子任务结算后由 lifecycle 调 `resumeMergeRun` 再次驱动。全部落地或没有可推进项时收口。
   */
  async driveOrchestrate(target) {
    if (this.mergeRunsDriving.has(target)) return;
    this.mergeRunsDriving.add(target);
    try {
      for (let pass = 0; pass <= (this.store.branchMergeRun(target)?.order?.length ?? 0) + 3; pass++) {
        const run = this.store.branchMergeRun(target);
        if (!run || run.mode !== 'orchestrate' || !RESUMABLE.has(run.status)) return;
        // 目标分支的父 Agent 还在原调用时，先冻结并等待安全点，不能并发开解分歧子任务。
        if (run.waiting_safe_task_id) {
          const owner = this.store.task(run.waiting_safe_task_id);
          if (this.running.has(owner.id) || owner.status === 'running') return;
          run.waiting_safe_task_id = null;
          run.status = 'running';
          run.updated_at = new Date().toISOString();
          this.store.setBranchMergeRun(target, run);
        }
        // 暂停中：等解分歧子任务。完成则由 runtime 把它同时含两端固定提交的产物快进回 say 分支；否则整场失败。
        if (run.waiting_task_id !== null && run.waiting_task_id !== undefined) {
          const waited = this.store.task(run.waiting_task_id);
          if (!TERMINAL.has(waited.status)) return;
          if (waited.status !== 'completed') {
            this.finishOrchestrate(target, 'failed', null, `解分歧子 Task #${waited.id} ${waited.status}`);
            return;
          }
          try { await this.finalizeOrchestratedDivergence(waited.id); }
          catch (error) { this.finishOrchestrate(target, 'failed', null, `收尾解分歧子 Task #${waited.id}：${error.message}`); return; }
          run.waiting_task_id = null;
          run.status = 'running';
          run.index = (run.index ?? 0) + 1;
          run.updated_at = new Date().toISOString();
          this.store.setBranchMergeRun(target, run);
          continue;
        }
        const done = new Set(run.done ?? []);
        const skipped = new Map((run.skipped ?? []).map(row => [row.branch, row.reason]));
        let progressed = false;
        let paused = false;
        for (const branch of run.order ?? []) {
          if (done.has(branch)) continue;
          const item = await this.orchestrateItem(branch);
          if (item.status === 'integrated' || item.status === 'landed') { done.add(branch); skipped.delete(branch); progressed = true; continue; }
          if (item.status === 'requested') { progressed = true; continue; }
          if (item.status === 'diverged') {
            const say = this.store.get("SELECT parent_id FROM tasks WHERE task_kind='say' AND branch=? ORDER BY id DESC LIMIT 1", branch);
            const parent = say?.parent_id ? this.store.task(say.parent_id) : null;
            if (parent && (this.running.has(parent.id) || parent.status === 'running')) {
              run.waiting_safe_task_id = parent.id;
              run.status = 'paused';
              run.done = [...done];
              run.skipped = [...skipped].map(([name, reason]) => ({ branch: name, reason }));
              run.updated_at = new Date().toISOString();
              this.store.setBranchMergeRun(target, run);
              this.requestPreempt(parent.id, '合并编排已冻结目标分支，等待本轮安全结束');
              paused = true;
              break;
            }
            const child = await this.spawnOrchestratedResolution(branch);
            if (!child) { skipped.set(branch, 'diverged; no resolution child could be created'); continue; }
            run.waiting_task_id = child.id;
            run.status = 'paused';
            run.done = [...done];
            run.skipped = [...skipped].map(([name, reason]) => ({ branch: name, reason }));
            run.updated_at = new Date().toISOString();
            this.store.transaction(() => {
              this.store.setBranchMergeRun(target, run);
              this.store.event(this.branchHost(target), 'merge.orchestrate.paused', { target, branch, resolution: child.id });
            });
            paused = true;
            break;
          }
          if (item.status === 'failed') { this.finishOrchestrate(target, 'failed', null, `合并 ${branch} 失败：${item.reason}`); return; }
          skipped.set(branch, item.reason ?? 'skipped');
        }
        if (paused) return;
        run.done = [...done];
        run.skipped = [...skipped].map(([name, reason]) => ({ branch: name, reason }));
        run.updated_at = new Date().toISOString();
        this.store.setBranchMergeRun(target, run);
        if (!progressed) {
          const remaining = (run.order ?? []).filter(branch => !done.has(branch));
          this.finishOrchestrate(target, 'completed',
            `合并编排完成：已落地 ${done.size} 条分支${remaining.length ? `，跳过 ${remaining.length} 条（见 skipped）` : ''}。`);
          return;
        }
      }
      this.finishOrchestrate(target, 'failed', null, '合并编排未收敛');
    } finally {
      this.mergeRunsDriving.delete(target);
    }
  },

  /**
   * 单条分支的一步：读 say / 预约 / 实时分支状态，决定并执行可做的最小动作。
   * 返回 `{ status: 'integrated' | 'landed' | 'requested' | 'diverged' | 'skip' | 'failed', reason? }`。
   */
  async orchestrateItem(branch) {
    const say = this.store.get("SELECT * FROM tasks WHERE branch=? AND task_kind='say' ORDER BY id DESC LIMIT 1", branch);
    if (!say) return { status: 'skip', reason: '该分支没有 say Task 拥有' };
    let reservation = reservationOf(say);
    if (reservation?.blocked_code === 'resolving') return { status: 'skip', reason: '已有解分歧子任务在处理' };
    let state;
    try { state = await this.workspaces.branchState(branch); }
    catch (error) { return { status: 'failed', reason: error.message }; }
    const merge = reservation?.kind === 'merge' ? reservation : null;
    if (state.status === 'integrated' || merge?.status === 'integrated') return this.markOrchestratedIntegrated(say.id, state);
    if (state.status === 'missing') return { status: 'skip', reason: '分支 ref 缺失' };
    const blockers = state.blockers.filter(item => item !== `task:#${say.id}`);
    if (blockers.length) return { status: 'skip', reason: `等待子分支收拢：${blockers.join('、')}` };
    if (!merge) {
      // 没有合并预约：用户确认整份计划后由编排代发固定提交请求；本轮先固定 pending，下一轮复用既有流程。
      const autoBlockers = this.autoRequestBlockers(say, state);
      if (autoBlockers.length) return { status: 'skip', reason: autoBlockers.join('；') };
      const reserved = await this.autoReserveOrchestratedMerge(say.id);
      if (!reserved) return { status: 'skip', reason: '无法自动补发合并请求' };
      reservation = reserved;
    }
    if (state.status === 'diverged') return { status: 'diverged' };
    if (state.status !== 'fast_forward') return { status: 'skip', reason: `无法从 ${state.status} 分支合并` };
    if (reservation.status === 'pending') {
      if (!say.head_commit || say.head_commit === say.base_commit) return { status: 'skip', reason: '还没有已提交的源改动' };
      if (state.child_head !== say.head_commit) return { status: 'failed', reason: 'say 分支在准备合并时移动' };
      // 终态 say 的 pending 只可能是「解分歧收尾后重新挂起」，直接按最新 Git 事实补固定请求；活动 say 走静息结算。
      const pinned = say.status === 'completed'
        ? await this.pinOrchestratedRequest(say.id, state)
        : await this.settleOrchestratedMerge(say.id);
      return pinned ? { status: 'requested' } : { status: 'skip', reason: 'say 尚未静息或无法固定合并请求' };
    }
    if (reservation.status !== 'requested') return { status: 'skip', reason: `预约状态 ${reservation.status}` };
    if (state.child_head !== reservation.commit) return { status: 'failed', reason: '源分支已越过固定提交' };
    return this.landOrchestratedMerge(say.id, reservation);
  },

  /**
   * 自动代发合并请求的准入（计划面与执行面共用）：没有合并预约的 say 只有在「已静息、有已提交改动、
   * 分支可快进或可解分歧、没有未收拢子分支」时才由编排代为固定 commit + 父基线。返回阻塞原因数组；
   * 空数组表示可以自动请求。已经有合并预约的分支不走这里。
   */
  autoRequestBlockers(say, state) {
    const blockers = [];
    if (!say) { blockers.push('该分支没有 say Task 拥有'); return blockers; }
    const reservation = reservationOf(say);
    // 展示预约未完成时不能同时请求合并；展示已交付的终态 say 允许补发一次固定提交请求。
    if (reservation && !(reservation.kind === 'showcase' && reservation.status === 'completed')) {
      blockers.push(reservation.kind === 'showcase' ? '展示预约尚未完成' : `预约状态 ${reservation.status}`);
      return blockers;
    }
    if (say.status === 'running' || say.status === 'queued') blockers.push(`say #${say.id} 仍在 ${say.status}`);
    else if (say.status === 'awaiting') blockers.push(`say #${say.id} 正在等待用户答复`);
    else if (!['waiting', 'completed'].includes(say.status)) blockers.push(`say #${say.id} 状态 ${say.status} 不能自动请求合并`);
    else if (say.status === 'waiting') {
      const reason = this.reservationWaitReason(say);
      if (reason) blockers.push(reason);
    }
    if (!say.head_commit || !say.base_commit || say.head_commit === say.base_commit) blockers.push('没有已提交的源改动');
    if (!state) { blockers.push('无法读取分支状态'); return blockers; }
    if (state.status === 'missing') blockers.push('分支 ref 缺失');
    else if (state.status === 'integrated') blockers.push('已合入父分支');
    else if (!['fast_forward', 'diverged'].includes(state.status)) blockers.push(`无法从 ${state.status} 分支合并`);
    if (state.child_head !== say.head_commit) blockers.push('分支顶端与 Task 记录的固定提交不一致，先检查现场');
    const childBlockers = state.blockers.filter(item => item !== `task:#${say.id}`);
    if (childBlockers.length) blockers.push(`等待子分支收拢：${childBlockers.join('、')}`);
    return blockers;
  },

  /**
   * 编排代发固定提交请求：用户已把整份计划确认一次，对没有合并预约、已静息、有已提交改动且无未收拢
   * 子分支的 say，runtime 直接写一条 pending 合并预约（等价于用户点一次「请求合并」的第一步）。
   * 后续轮次复用既有 pending → requested / diverged 流程，仍然只按固定 commit + 父基线 ff-only 落地。
   */
  autoReserveOrchestratedMerge(sayId) {
    return this.workspaces.exclusive(async () => {
      const say = this.store.task(sayId);
      const state = await this.workspaces.branchState(say?.branch).catch(() => null);
      if (this.autoRequestBlockers(say, state).length) return null;
      const now = new Date().toISOString();
      const reservation = { version: 1, kind: 'merge', status: 'pending', created_at: now };
      if (state.status === 'diverged') {
        reservation.blocked_reason = '分支与直接父分支已分歧；编排将派源侧解分歧子 Task 吸收固定的父提交。';
        reservation.blocked_code = 'diverged';
      }
      const parent = this.store.task(say.parent_id);
      this.store.transaction(() => {
        const live = this.store.task(sayId);
        if (live.task_kind !== 'say' || live.reservation !== say.reservation || live.head_commit !== say.head_commit) {
          throw new Error('say changed while auto-reserving its merge request');
        }
        check(['main', 'owner', 'say'].includes(parent?.task_kind) && !TERMINAL.has(parent.status),
          'merge request needs a live directly bound parent Task');
        this.store.update(sayId, { reservation: JSON.stringify(reservation) });
        this.store.event(sayId, 'task.reserved', { reservation, via: 'orchestrate' });
      });
      return reservation;
    });
  },

  /**
   * 内部结算：等价于 `settleReservedMerge` 的核心（静息检查、工作区复核、固定源与父基线、ff-only 前置），
   * 但跳过「必须用户逐条批准」与交付锁的冻结检查——编排运行自己冻结了目标分支，且用户已一次性确认过计划。
   * 仍然只允许把固定源提交 fast-forward 进直接父分支。
   */
  async settleOrchestratedMerge(sayId) {
    const ready = () => {
      const task = this.store.task(sayId);
      const reservation = reservationOf(task);
      if (task.task_kind !== 'say' || reservation?.kind !== 'merge' || reservation.status !== 'pending') return null;
      return this.reservationWaitReason(task) ? null : task;
    };
    if (!ready()) return null;
    return this.workspaces.exclusive(async () => {
      let task = ready();
      if (!task) return null;
      await this.workspaces.finish(task);
      task = ready();
      if (!task) return null;
      if (!task.head_commit || task.head_commit === task.base_commit) return null;
      const parent = this.store.task(task.parent_id);
      if (!parent) return null;
      const state = await this.workspaces.branchState(task.branch);
      if (state.parent !== parent.branch || state.child_head !== task.head_commit) return null;
      if (state.status !== 'fast_forward' || state.blockers.filter(item => item !== `task:#${task.id}`).length) return null;
      this.finish(task.id, 'completed', task.result, null, {
        mergeRequest: { commit: state.child_head, baseline: state.parent_head, parent_id: parent.id },
      });
      return this.store.task(task.id);
    });
  },

  /** 终态 say 在解分歧收尾后重新固定一次 requested 请求（不经过用户批准，也不经旧 branch.merge）。 */
  async pinOrchestratedRequest(sayId, state) {
    return this.workspaces.exclusive(async () => {
      const say = this.store.task(sayId);
      const reservation = reservationOf(say);
      if (say.task_kind !== 'say' || say.status !== 'completed' || reservation?.kind !== 'merge' || reservation.status !== 'pending') return null;
      const parent = this.store.task(say.parent_id);
      if (!parent) return null;
      const live = await this.workspaces.branchState(say.branch);
      if (live.status !== 'fast_forward' || live.blockers.filter(item => item !== `task:#${say.id}`).length) return null;
      if (!say.head_commit || live.child_head !== say.head_commit) return null;
      const now = new Date().toISOString();
      const requested = { version: 1, kind: 'merge', status: 'requested', created_at: now,
        commit: live.child_head, baseline: (state ?? live).parent_head, parent_id: parent.id, requested_at: now };
      this.store.transaction(() => {
        const current = reservationOf(this.store.task(sayId));
        check(current?.status === 'pending', '预约在编排固定请求时发生变化');
        this.store.update(sayId, { reservation: JSON.stringify(requested), head_commit: live.child_head });
        this.store.event(sayId, 'task.merge_requested', { branch: say.branch, commit: live.child_head,
          baseline: requested.baseline, parent_id: parent.id, via: 'orchestrate' });
      });
      return requested;
    });
  },

  /** 把一条已固定的 requested 请求 ff-only 落进直接父分支，并幂等关闭它的预约。 */
  async landOrchestratedMerge(sayId, reservation) {
    return this.workspaces.exclusive(async () => {
      const say = this.store.task(sayId);
      const current = reservationOf(say);
      if (current?.kind !== 'merge') return { status: 'skip', reason: '预约已变化' };
      if (current.status === 'integrated') return { status: 'integrated' };
      if (current.status !== 'requested') return { status: 'skip', reason: `预约状态 ${current.status}` };
      const parent = this.store.task(say.parent_id);
      if (!parent) return { status: 'failed', reason: '直接父 Task 已不存在' };
      const state = await this.workspaces.branchState(say.branch);
      if (state.status === 'integrated') return this.markOrchestratedIntegrated(sayId, state);
      if (state.status !== 'fast_forward') return { status: state.status === 'diverged' ? 'diverged' : 'skip', reason: `状态 ${state.status}` };
      if (state.child_head !== current.commit) return { status: 'failed', reason: '源分支已越过固定提交' };
      const outcome = await this.workspaces.mergeBranchUnsafe(say.branch, current.commit, state.parent_head);
      check(outcome.merged || outcome.already_integrated, '编排合并要求干净的 fast-forward');
      this.store.transaction(() => {
        const live = this.store.task(sayId);
        const liveReservation = reservationOf(live);
        check(liveReservation?.status === 'requested' && liveReservation.commit === current.commit,
          '预约在编排落地时发生变化');
        const { blocked_reason: _reason, blocked_code: _code, resolution_child_id: _child, ...clean } = liveReservation;
        this.store.update(sayId, { integration: 'merged', integration_error: null,
          reservation: JSON.stringify({ ...clean, status: 'integrated', integrated_at: new Date().toISOString() }) });
        this.store.update(parent.id, { head_commit: current.commit });
        this.store.event(sayId, 'task.merge_integrated', { commit: current.commit, baseline: state.parent_head,
          parent_id: parent.id, via: 'orchestrate', already_integrated: outcome.already_integrated === true });
        this.store.event(parent.id, 'child.integrated', { child: sayId, commit: current.commit,
          baseline: state.parent_head, via: 'orchestrate' });
      });
      return { status: 'landed' };
    });
  },

  /** 固定提交已经在父分支历史里：把预约幂等收成 integrated，不动父分支 ref。 */
  async markOrchestratedIntegrated(sayId, state) {
    return this.workspaces.exclusive(async () => {
      const say = this.store.task(sayId);
      const reservation = reservationOf(say);
      if (reservation?.kind === 'merge' && reservation.status !== 'integrated') {
        const { blocked_reason: _reason, blocked_code: _code, resolution_child_id: _child, ...clean } = reservation;
        this.store.update(sayId, { integration: 'merged',
          reservation: JSON.stringify({ ...clean, status: 'integrated', integrated_at: new Date().toISOString() }) });
      } else if (!reservation) {
        this.store.update(sayId, { integration: 'merged' });
      }
      this.store.event(sayId, 'task.merge_integrated', { commit: state?.child_head ?? null, via: 'orchestrate',
        already_integrated: true });
      return { status: 'integrated' };
    });
  },

  /**
   * 分歧时在源侧派独立解分歧子 Task：基线固定为 say 固定源提交，要求合入当时固定的父 tip 并测试；
   * parent 为空、用 `resolves_task_id` 关联，因此不需要原 say Agent 参与，结算后由 runtime 收尾。
   * 已有活动或尚未收尾的解分歧子任务时直接返回它（幂等）；失败/取消且分支仍在的情况要求用户显式归档后再重派。
   */
  async spawnOrchestratedResolution(branch) {
    const say = this.store.get("SELECT * FROM tasks WHERE branch=? AND task_kind='say' ORDER BY id DESC LIMIT 1", branch);
    check(say, `branch ${branch} has no say Task`);
    const active = this.store.get(`SELECT t.* FROM tasks t JOIN events e ON e.task_id=t.id
      WHERE t.resolves_task_id=? AND e.type='task.divergence_resolution_requested'
        AND t.status NOT IN ('completed','failed','cancelled') ORDER BY t.id DESC LIMIT 1`, say.id);
    if (active) return active;
    const stale = this.store.get(`SELECT t.* FROM tasks t JOIN events e ON e.task_id=t.id
      LEFT JOIN branches b ON b.branch=t.branch
      WHERE t.resolves_task_id=? AND e.type='task.divergence_resolution_requested'
        AND t.status IN ('completed','failed','cancelled')
        AND (t.integration != 'merged' AND b.status='active') ORDER BY t.id DESC LIMIT 1`, say.id);
    check(!stale, `解分歧子 Task #${stale?.id} 已结束但尚未集成；检查现场并显式归档它的分支后再重派`);
    return this.workspaces.exclusive(async () => {
      const live = this.store.task(say.id);
      const reservation = reservationOf(live);
      check(live.task_kind === 'say' && reservation?.kind === 'merge'
        && ['pending', 'requested'].includes(reservation.status), '只有带合并预约的 say 才能解分歧');
      const parent = this.store.task(live.parent_id);
      check(parent && ['main', 'owner', 'say'].includes(parent.task_kind) && !TERMINAL.has(parent.status),
        'say 的直接父 Task 已结束或不可合并');
      const run = this.store.activeBranchMergeRuns().find(({ run: entry }) => entry.mode === 'orchestrate'
        && entry.task_id && (entry.order ?? []).includes(branch));
      const coordinator = run ? this.store.task(run.run.task_id) : null;
      check(coordinator?.task_kind === 'merge' && !TERMINAL.has(coordinator.status), '解分歧需要仍在运行的编排 Task');
      check(!this.running.has(parent.id) && parent.status !== 'running',
        `父 Task #${parent.id} 尚未到安全点；等待本轮调用结束后再解分歧`);
      const state = await this.workspaces.branchState(live.branch);
      check(state.status === 'diverged', `源分支现在是 ${state.status}，不需要解分歧`);
      check(state.child_head === (reservation.commit ?? live.head_commit),
        '解分歧前源分支已越过固定提交；检查现场');
      const blockers = state.blockers.filter(item => item !== `task:#${live.id}`);
      check(blockers.length === 0, `先收拢未集成子分支：${blockers.join('、')}`);
      const goal = `在独立子任务工作区解决 say #${live.id} 与直接父分支 ${parent.branch} 的分歧。\n`
        + `基线是固定源提交 ${state.child_head}。请把固定父提交 ${state.parent_head} 合入本工作区（不要合入会移动的分支名）；`
        + '如有冲突，保留双方意图并解决，运行相关测试，再提交结果。只改自己的子任务分支，'
        + `不可修改 say 分支或父分支。完成后由 runtime 校验产物同时包含两端固定提交，把它快进推进回 say 分支，`
        + '并由合并编排任务自动重新发出固定提交的合并请求。';
      const child = this.store.transaction(() => {
        const liveNow = this.store.task(say.id);
        const current = reservationOf(liveNow);
        check(current?.kind === 'merge' && ['pending', 'requested'].includes(current.status)
          && liveNow.head_commit === state.child_head && liveNow.parent_id === parent.id,
        'say 预约在启动解分歧时发生变化');
        const activeRun = this.store.branchMergeRun(run.target);
        check(activeRun?.mode === 'orchestrate' && activeRun.task_id === coordinator.id
          && !TERMINAL.has(this.store.task(coordinator.id).status), '合并编排已结束，不能再派解分歧 Task');
        check(this.store.activeTasks().length < 1000, 'too many active tasks');
        check(!this.running.has(parent.id) && this.store.task(parent.id).status !== 'running',
          `父 Task #${parent.id} 尚未到安全点；等待本轮调用结束后再解分歧`);
        const created = this.store.create({ parent_id: coordinator.id, input_id: liveNow.input_id, role: 'agent',
          task_kind: 'child', name: `resolve-${liveNow.id}`, goal, resolves_task_id: liveNow.id });
        this.store.update(created.id, { base_commit: state.child_head, target_branch: liveNow.branch });
        this.store.event(created.id, 'task.divergence_resolution_requested', { source_task_id: liveNow.id,
          source_commit: state.child_head, parent_task_id: parent.id, parent_branch: parent.branch,
          parent_commit: state.parent_head, orchestrated: true });
        this.store.update(liveNow.id, { reservation: JSON.stringify({ ...current,
          blocked_reason: `合并编排等待解分歧子 Task #${created.id}`, blocked_code: 'resolving',
          resolution_child_id: created.id }) });
        this.store.event(liveNow.id, 'task.divergence_resolution_started', { child_id: created.id,
          source_commit: state.child_head, parent_commit: state.parent_head, via: 'orchestrate' });
        return created;
      });
      this.kick();
      return child;
    });
  },

  /**
   * 编排解分歧子 Task 结算后由 runtime 收尾：校验它同时含 say 固定源提交与当时固定的父提交，把 say 分支
   * 快进到产物、预约落回 pending，之后 driver 会再固定一次 requested 并 ff-only 落地。幂等：只处理仍处于
   * `resolving` 且 resolution_child_id 匹配的预约；用户路径（非 orchestrated）的解分歧由既有函数处理。
   */
  finalizeOrchestratedDivergence(resolutionId) {
    const resolution = this.store.task(resolutionId);
    if (!resolution || resolution.resolves_task_id === null || resolution.status !== 'completed' || !resolution.head_commit) return null;
    const say = this.store.task(resolution.resolves_task_id);
    if (!say || say.task_kind !== 'say') return null;
    const reservation = reservationOf(say);
    if (reservation?.kind !== 'merge' || reservation.blocked_code !== 'resolving'
      || reservation.resolution_child_id !== resolution.id) return null;
    return this.workspaces.exclusive(async () => {
      const liveResolution = this.store.task(resolutionId);
      const liveSay = this.store.task(say.id);
      const current = reservationOf(liveSay);
      if (liveResolution.status !== 'completed' || !liveResolution.head_commit
        || current?.kind !== 'merge' || current.blocked_code !== 'resolving'
        || current.resolution_child_id !== liveResolution.id) return null;
      const event = this.store.get("SELECT data FROM events WHERE task_id=? AND type='task.divergence_resolution_requested' ORDER BY id DESC LIMIT 1", resolutionId);
      check(event, '编排解分歧子 Task 缺少固定的请求快照');
      const fixed = JSON.parse(event.data);
      check(fixed.source_task_id === liveSay.id, '解分歧子 Task 指向了别的 say');
      check(await this.workspaces.isAncestor(this.config.project, fixed.source_commit, liveResolution.head_commit)
        && await this.workspaces.isAncestor(this.config.project, fixed.parent_commit, liveResolution.head_commit),
        '解分歧产物必须同时包含固定的源提交与父提交');
      const state = await this.workspaces.branchState(liveSay.branch);
      check(state.parent === liveSay.target_branch && state.parent_head === fixed.parent_commit
        && (state.child_head === fixed.source_commit || state.child_head === liveResolution.head_commit),
        '解分歧两端提交在收尾前移动；检查现场');
      if (state.child_head !== liveResolution.head_commit)
        await this.workspaces.fastForwardBranchUnsafe(liveSay.branch, liveResolution.head_commit);
      this.store.transaction(() => {
        const { blocked_reason: _reason, blocked_code: _code, resolution_child_id: _child, ...clean } = current;
        this.store.update(liveSay.id, { head_commit: liveResolution.head_commit, integration: 'pending',
          integration_error: null, reservation: JSON.stringify({ ...clean, status: 'pending' }) });
        this.store.update(liveResolution.id, { integration: 'merged', integration_error: null });
        this.store.event(liveResolution.id, 'resolution.merged', { commit: liveResolution.head_commit,
          source_task_id: liveSay.id, source_commit: fixed.source_commit, parent_commit: fixed.parent_commit,
          via: 'orchestrate' });
        this.store.event(liveSay.id, 'task.divergence_resolved', { resolution: liveResolution.id,
          commit: liveResolution.head_commit, source_commit: fixed.source_commit, parent_commit: fixed.parent_commit,
          via: 'orchestrate' });
      });
      return this.store.task(liveSay.id);
    });
  },

  /** 终态统一收口：清运行（释放冻结）并把编排 Task 结算为 completed / failed / cancelled。 */
  finishOrchestrate(target, status, result, error = null) {
    const run = this.store.branchMergeRun(target);
    if (!run || run.mode !== 'orchestrate') return null;
    const taskId = run.task_id ?? null;
    const done = run.done ?? [];
    const skipped = run.skipped ?? [];
    this.store.transaction(() => {
      this.store.setBranchMergeRun(target, null);
      this.store.event(this.branchHost(target), `merge.orchestrate.${status}`, { target, task_id: taskId, status,
        error: error ?? null, done, skipped });
    });
    if (taskId !== null) {
      const task = this.store.task(taskId);
      if (task && !TERMINAL.has(task.status)) this.finish(taskId, status, result ?? null, error);
    }
    return { target_branch: target, status, task_id: taskId, done, skipped };
  },
};
