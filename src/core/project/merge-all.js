import { check, TERMINAL } from '../types.js';
import { descendantsOf, parentOf } from '../genealogy.js';
import { branchFreeze, frozenFor, branchFreezeList } from '../branch-freeze.js';

/**
 * 一键合并：对一条分支（例如 main）的所有后代分支，从叶子向根自动收拢。
 *
 * 采纳的语义（用户确认）：
 * - 原子快进编排，不新增聚合分支：runtime 按分支谱系自底向上，对每条子分支复用现有
 *   `branch.merge`（ff-only）与 `branch.sync`（分歧时在子侧建 merger）路径；目标分支永不 no-ff。
 * - 一次汇总确认后全自动：`mergeAllPlan` 给出顺序与阻塞原因供确认，`mergeAll` 开始执行后不再逐条确认。
 * - 运行期间冻结目标分支及其全部后代（见 branchFreeze）；冲突时冻结冲突分支的父分支。
 * - 遇到分歧自动创建子侧 merger 子任务，然后暂停运行等待它；用户处理完（或它完成）后自动继续。
 *   已成功的合并保留不回滚。
 *
 * 运行是分支附属的 versioned JSON（`branches.merge_run`），不是新实体；终态即清空，冻结随之解除。
 */
export default {
  /** 分支当前是否被冻结；只读投影供 status / graph 读面使用。 */
  branchFreeze(branch = null) {
    return branch === null ? branchFreezeList(this.store) : frozenFor(this.store, branch);
  },

  /** 写操作前的统一守卫：冻结中的分支不接受会扰动合并的写（新建 intent、合并、归档、重试等）。 */
  assertBranchWritable(branch, action = 'modify') {
    const info = frozenFor(this.store, branch);
    check(!info, `branch ${branch} is frozen: ${info?.reason ?? 'an active merge is in progress'}; cannot ${action}`);
    return true;
  },

  /** 事件挂在「这条分支属于谁」上：有创建它的任务记在任务上，输入锚点记在 planner 上，否则项目级。 */
  branchHost(branch) {
    const record = this.store.branch(branch);
    if (record?.task_id !== null && record?.task_id !== undefined) return record.task_id;
    return this.store.get('SELECT task_id FROM inputs WHERE anchor_branch=?', branch)?.task_id ?? null;
  },

  /** 目标分支不一定被登记过：main 这类根分支常常只有 ref。按 `branch import` 同一口径补一条记录（parent 留空，不猜）。 */
  async ensureMergeTarget(name) {
    const record = this.store.branch(name);
    if (record) return record;
    let commit = null;
    try { commit = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${name}^{commit}`); }
    catch { /* missing local branch */ }
    check(commit, `merge target branch does not exist locally: ${name}`);
    return this.store.recordBranch({ branch: name });
  },

  /**
   * 只读的一键合并计划：目标分支的整棵后代子树，按「叶子在前」排序，逐条给出当前状态、
   * 将要执行的动作（merge / sync / skip）与阻塞原因。`order` 只包含此刻 ready、会被执行的项。
   * 确认对话框与 CLI 都消费这份读面；真正执行时还会逐条重算，不信任计划快照。
   */
  async mergeAllPlan(targetBranch) {
    const name = String(targetBranch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    const rows = this.store.branches().filter(row => row.status === 'active');
    const byBranch = new Map(rows.map(row => [row.branch, row]));
    const descendants = descendantsOf(rows, name);
    const depth = branch => { let d = 0; for (let cur = branch; cur && cur !== name; cur = parentOf(rows, cur)) { d++; if (d > 1000) break; } return d; };
    const sorted = descendants.slice().sort((a, b) => depth(b) - depth(a)
      || String(byBranch.get(a)?.created_at ?? '').localeCompare(String(byBranch.get(b)?.created_at ?? ''))
      || a.localeCompare(b));
    const items = [];
    for (const branch of sorted) {
      let state;
      try { state = await this.workspaces.branchState(branch); }
      catch (error) { items.push({ branch, parent: byBranch.get(branch)?.parent ?? null, depth: depth(branch),
        status: 'unknown', ahead: null, behind: null, action: 'skip', ready: false, blockers: [error.message] }); continue; }
      const owner = byBranch.get(branch);
      const ownerTask = owner?.task_id ? this.store.get('SELECT id,status FROM tasks WHERE id=?', owner.task_id) : null;
      const active = this.store.all("SELECT id,status FROM tasks WHERE branch=? AND status NOT IN ('completed','failed','cancelled') ORDER BY id", branch);
      const blockers = [...state.blockers];
      if (ownerTask && !TERMINAL.has(ownerTask.status)) blockers.push(`task:#${ownerTask.id}`);
      for (const task of active) blockers.push(`task:#${task.id}`);
      const action = state.status === 'fast_forward' ? 'merge' : state.status === 'diverged' ? 'sync' : 'skip';
      const ready = action !== 'skip' && blockers.length === 0;
      items.push({ branch, parent: state.parent, depth: depth(branch), status: state.status,
        ahead: state.ahead, behind: state.behind, action, ready, blockers: [...new Set(blockers)] });
    }
    const ready = items.filter(item => item.ready);
    const active = this.store.branchMergeRun(name);
    // order 要包含「有工作要交付」的全部后代（含此刻被未收拢子分支阻塞的父级）：
    // 叶子先合后，它们的阻塞会自动消失，所以不能只把开始时 ready 的项定序。
    return { target_branch: name, items, order: items.filter(item => item.action !== 'skip').map(item => item.branch),
      ready: ready.length, total: items.length,
      frozen: Boolean(frozenFor(this.store, name)),
      active_run: active && ['running', 'paused'].includes(active.status) ? active : null };
  },

  /** 汇总确认后启动一键合并：compute plan → 落 run → 异步逐条执行。目标已有运行在跑时拒绝。 */
  async mergeAll(targetBranch) {
    const name = String(targetBranch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    const descendants = descendantsOf(this.store.branches(), name);
    const branches = [name, ...descendants];
    const placeholders = branches.map(() => '?').join(',');
    check(!this.store.get(`SELECT id FROM tasks WHERE branch IN (${placeholders})
      AND (task_kind IN ('owner','say','child') OR (task_kind='main' AND branch<>?)) LIMIT 1`, ...branches, name),
      'new Task branches cannot use legacy branch.merge_all; merge old branches individually');
    const existing = this.store.branchMergeRun(name);
    check(!existing || !['running', 'paused'].includes(existing.status),
      `${name} already has a one-click merge in progress`);
    const plan = await this.mergeAllPlan(name);
    if (!plan.order.length) return { target_branch: name, status: 'empty', plan };
    await this.ensureMergeTarget(name);
    const now = new Date().toISOString();
    const run = { version: 1, status: 'running', order: plan.order, index: 0, done: [], skipped: [],
      waiting_task_id: null, started_at: now, updated_at: now };
    this.store.transaction(() => {
      this.store.setBranchMergeRun(name, run);
      this.store.event(this.branchHost(name), 'merge.run.started', { target: name, order: plan.order });
    });
    this.scheduleMergeRun(name);
    return { target_branch: name, status: 'running', plan, run };
  },

  /** 取消一键合并：先清运行（释放冻结），再取消正在等待的子任务；已成功的合并保留不回滚。 */
  cancelMergeAll(targetBranch) {
    const name = String(targetBranch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    const run = this.store.branchMergeRun(name);
    check(run && ['running', 'paused'].includes(run.status), `${name} has no active one-click merge to cancel`);
    check(run.mode !== 'orchestrate', `${name} has an active merge orchestration; cancel it with branch.orchestrate_cancel`);
    this.store.transaction(() => {
      this.store.setBranchMergeRun(name, null);
      this.store.event(this.branchHost(name), 'merge.run.cancelled', { target: name, done: run.done ?? [],
        pending: (run.order ?? []).filter(branch => !(run.done ?? []).includes(branch)) });
    });
    const waiting = run.waiting_task_id ? this.store.task(run.waiting_task_id) : null;
    if (waiting && !TERMINAL.has(waiting.status)) this.cancel(waiting.id, 'one-click merge cancelled');
    return { target_branch: name, status: 'cancelled', done: run.done ?? [] };
  },

  /** 单飞的异步驱动入口：同一目标同时只有一个驱动在跑。按运行 mode 分派旧一键合并或合并编排。 */
  scheduleMergeRun(target) {
    if (this.stopping) return;
    if (this.mergeRunsDriving.has(target)) return;
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
   * 逐条推进：每轮重新读运行与每条分支的实时状态，只处理 ready 项。遇到分歧就建子侧 merger、
   * 把运行置为 paused 并停在这里；merger 结算时由 lifecycle 调 resumeMergeRun 再次驱动。
   */
  async driveMergeRun(target) {
    if (this.mergeRunsDriving.has(target)) return;
    this.mergeRunsDriving.add(target);
    try {
      for (let pass = 0; pass <= (this.store.branchMergeRun(target)?.order?.length ?? 0) + 2; pass++) {
        const run = this.store.branchMergeRun(target);
        if (!run || !['running', 'paused'].includes(run.status)) return;
        if (run.mode === 'orchestrate') return; // 合并编排有自己的 driver
        // 暂停中：等待子任务。完成则先把 merger 落回它的直接父分支，取消 / 失败则整场失败。
        if (run.waiting_task_id) {
          const waited = this.store.task(run.waiting_task_id);
          if (!TERMINAL.has(waited.status)) return;
          if (waited.status === 'completed') {
            try { await this.approveBranchMerge(waited.branch, waited.head_commit, { internal: true }); }
            catch (error) { this.finishMergeRun(target, 'failed', `landing merger #${waited.id}: ${error.message}`); return; }
          } else {
            this.finishMergeRun(target, 'failed', `merge child task #${waited.id} ${waited.status}`);
            return;
          }
          run.waiting_task_id = null;
          run.status = 'running';
          run.index = (run.index ?? 0) + 1;
          run.updated_at = new Date().toISOString();
          this.store.setBranchMergeRun(target, run);
          continue;
        }
        const done = new Set(run.done ?? []);
        const skipped = new Map((run.skipped ?? []).map(row => [row.branch, row.reason]));
        let mergedThisPass = false;
        let paused = false;
        for (const branch of run.order ?? []) {
          if (done.has(branch)) continue;
          let state;
          try { state = await this.workspaces.branchState(branch); }
          catch (error) { skipped.set(branch, error.message); continue; }
          if (state.status === 'integrated') { done.add(branch); mergedThisPass = true; continue; }
          if (state.status === 'missing') { skipped.set(branch, 'branch ref is missing'); continue; }
          if (state.blockers.length) { skipped.set(branch, `blocked by ${state.blockers.join(', ')}`); continue; }
          if (state.status === 'fast_forward') {
            try { await this.approveBranchMerge(branch, null, { internal: true }); }
            catch (error) { this.finishMergeRun(target, 'failed', `merging ${branch}: ${error.message}`); return; }
            done.add(branch); skipped.delete(branch); mergedThisPass = true; continue;
          }
          if (state.status === 'diverged') {
            const sync = await this.syncBranch(branch, { internal: true });
            run.waiting_task_id = sync.task?.id ?? null;
            if (!run.waiting_task_id) { skipped.set(branch, 'diverged; no merger task could be created'); continue; }
            run.status = 'paused';
            run.done = [...done];
            run.skipped = [...skipped].map(([name, reason]) => ({ branch: name, reason }));
            run.updated_at = new Date().toISOString();
            this.store.transaction(() => {
              this.store.setBranchMergeRun(target, run);
              this.store.event(this.branchHost(target), 'merge.run.paused', { target, branch, merger: run.waiting_task_id });
            });
            paused = true;
            break;
          }
          skipped.set(branch, `unexpected state ${state.status}`);
        }
        if (paused) return;
        run.done = [...done];
        run.skipped = [...skipped].map(([name, reason]) => ({ branch: name, reason }));
        run.updated_at = new Date().toISOString();
        this.store.setBranchMergeRun(target, run);
        if (!mergedThisPass) { this.finishMergeRun(target, 'completed', null); return; }
      }
      this.finishMergeRun(target, 'failed', 'one-click merge did not converge');
    } finally {
      this.mergeRunsDriving.delete(target);
    }
  },

  /** 子 merger 结算后由 lifecycle 调用：若某个运行正等它，就再次驱动。 */
  resumeMergeRun(waitedTaskId) {
    for (const { target, run } of this.store.activeBranchMergeRuns()) {
      if (run.waiting_task_id === waitedTaskId) { this.scheduleMergeRun(target); return; }
    }
  },

  /** 终态统一收口：清运行（释放冻结）并留一条可追溯事件。 */
  finishMergeRun(target, status, error) {
    const run = this.store.branchMergeRun(target);
    if (!run) return;
    this.store.transaction(() => {
      this.store.setBranchMergeRun(target, null);
      this.store.event(this.branchHost(target), `merge.run.${status}`, { target, status, error: error ?? null,
        done: run.done ?? [], skipped: run.skipped ?? [] });
    });
  },
};
