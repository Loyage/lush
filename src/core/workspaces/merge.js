import { check, LushError } from '../types.js';

/** 分支关系、批准合并的预检与落地。 */
export const methods = {
  /** 尚未落成/完成分支、但未来可能改变 child 的任务，也必须阻止 child 提前向上交付。 */
  branchTaskBlockers(child) {
    const record = this.store.branch(child);
    const blockers = [];
    if (record?.task_id !== null && record?.task_id !== undefined) {
      const owner = this.store.get('SELECT id,status FROM tasks WHERE id=?', record.task_id);
      if (owner && !['completed','failed','cancelled'].includes(owner.status)) blockers.push(`task:#${owner.id}`);
      for (const row of this.store.all(`SELECT tasks.id,tasks.status,tasks.branch FROM task_deps
        JOIN tasks ON tasks.id=task_deps.task_id WHERE task_deps.depends_on=? AND task_deps.kind='code'`, record.task_id)) {
        if (!['completed','failed','cancelled'].includes(row.status) && !row.branch) blockers.push(`task:#${row.id}`);
      }
    } else {
      const input = this.store.get('SELECT id FROM inputs WHERE anchor_branch=?', child);
      if (input) for (const row of this.store.all("SELECT id FROM tasks WHERE input_id=? AND status NOT IN ('completed','failed','cancelled')", input.id)) {
        blockers.push(`task:#${row.id}`);
      }
    }
    return [...new Set(blockers)];
  },

  /** 一条已登记的 child -> direct parent 边当前在 commit 图上的状态。 */
  async branchState(child) {
    const record = this.store.branch(child);
    check(record && record.parent && record.parent_relation === 'recorded', `${child} has no recorded direct parent`);
    const project = this.config.project;
    let childHead = null, parentHead = null;
    try { childHead = await this.git(project, 'rev-parse', '--verify', `refs/heads/${child}^{commit}`); } catch { /* missing */ }
    try { parentHead = await this.git(project, 'rev-parse', '--verify', `refs/heads/${record.parent}^{commit}`); } catch { /* missing */ }
    if (!childHead || !parentHead) return { child, parent: record.parent, child_head: childHead, parent_head: parentHead,
      status: 'missing', ahead: null, behind: null, blockers: [] };
    const counts = await this.git(project, 'rev-list', '--left-right', '--count', `${parentHead}...${childHead}`);
    const [behind, ahead] = counts.split(/\s+/).map(Number);
    let status;
    if (childHead === parentHead || await this.isAncestor(project, childHead, parentHead)) status = 'integrated';
    else if (await this.isAncestor(project, parentHead, childHead)) status = 'fast_forward';
    else status = 'diverged';
    const blockers = this.branchTaskBlockers(child);
    // 归档的分支没有本地 ref，不再是任何分支的 blocker；这里显式排除，别名不依赖 rev-parse 失败。
    for (const descendant of this.store.branches().filter(row => row.parent === child && !['deleted', 'archived'].includes(row.status))) {
      let head = null;
      try { head = await this.git(project, 'rev-parse', '--verify', `refs/heads/${descendant.branch}^{commit}`); } catch { continue; }
      if (!await this.isAncestor(project, head, childHead)) blockers.push(descendant.branch);
    }
    return { child, parent: record.parent, child_head: childHead, parent_head: parentHead,
      status, ahead: Number.isFinite(ahead) ? ahead : null, behind: Number.isFinite(behind) ? behind : null, blockers };
  },

  /** 在已经持有 Git 串行锁时，将 direct child 快进到 parent；发生分歧时绝不在 parent 上制造 merge commit。
   *  expectedCommit 用于 Candidate：校验与落地都在同一个串行区间内，并且 Git 命令只使用固定提交。 */
  async mergeBranchUnsafe(child, expectedCommit = null) {
    const state = await this.branchState(child);
    let deliveryHead = state.child_head;
    if (expectedCommit) {
      deliveryHead = await this.git(this.config.project, 'rev-parse', '--verify', `${expectedCommit}^{commit}`);
      // 分支后来漂移也不能把额外提交带进交付；固定提交已经在父分支里时则幂等成功。
      if (state.parent_head && await this.isAncestor(this.config.project, deliveryHead, state.parent_head)) {
        return { ...state, branch_head: state.child_head, child_head: deliveryHead,
          status: 'integrated', merged: false, already_integrated: true };
      }
      check(state.child_head === deliveryHead,
        `branch ${child} moved from pinned commit ${deliveryHead.slice(0,12)} to ${String(state.child_head ?? 'missing').slice(0,12)}`);
    }
    check(state.status !== 'missing', `cannot merge ${child}: child or parent branch is missing`);
    check(state.blockers.length === 0, `merge ${state.child} into ${state.parent} is blocked by unintegrated child branches: ${state.blockers.join(', ')}`);
    if (state.status === 'integrated') return { ...state, child_head: deliveryHead, merged: false, already_integrated: true };
    if (state.status === 'diverged') return { ...state, child_head: deliveryHead, merged: false, needs_sync: true };
    const childWorkspace = await this.workspaceForBranch(state.child);
    if (childWorkspace) await this.clean(childWorkspace);
    const parentWorkspace = await this.workspaceForBranch(state.parent);
    if (parentWorkspace) {
      await this.clean(parentWorkspace);
      check(await this.git(parentWorkspace, 'symbolic-ref', '--short', 'HEAD') === state.parent,
        `worktree ${parentWorkspace} is no longer on ${state.parent}`);
      await this.git(parentWorkspace, 'merge', '--ff-only', deliveryHead);
    } else {
      // 未检出的父分支没有 index/worktree 要同步；compare-and-swap 更新 ref，外部进程抢先推进就安全失败。
      await this.git(this.config.project, 'update-ref', `refs/heads/${state.parent}`, deliveryHead, state.parent_head);
    }
    return { ...state, child_head: deliveryHead, status: 'integrated', merged: true, new_head: deliveryHead };
  },

  mergeBranch(child, expectedCommit = null) { return this.exclusive(() => this.mergeBranchUnsafe(child, expectedCommit)); },

  /**
   * 反方向：把父分支快进进子分支（子分支跟上父分支）。只在子分支没有任何独有提交时才成立——
   * 这就是 branchState 的 integrated + behind>0；快进不会有 merge commit，也不会有冲突。
   * 子分支领先走 mergeBranch，父子分歧走 branch.sync（父分支上绝不 no-ff，子分支也不 rebase）。
   */
  async catchupBranchUnsafe(child) {
    const state = await this.branchState(child);
    check(state.status !== 'missing', `cannot catch up ${child}: child or parent branch is missing`);
    check(state.blockers.length === 0, `catch up ${state.child} is blocked by unintegrated child branches: ${state.blockers.join(', ')}`);
    check(state.status === 'integrated', `cannot catch up ${state.child}: it is ${state.status}; catch up only applies when the parent is already ahead`);
    // 顶端已经一样：没有要快进的东西，当成幂等的成功，不白改一次 ref。
    if (!(state.behind > 0)) return { ...state, caught_up: false, already_integrated: true, from: state.child_head, to: state.parent_head };
    const childWorkspace = await this.workspaceForBranch(state.child);
    if (childWorkspace) {
      await this.clean(childWorkspace);
      check(await this.git(childWorkspace, 'symbolic-ref', '--short', 'HEAD') === state.child,
        `worktree ${childWorkspace} is no longer on ${state.child}`);
      await this.git(childWorkspace, 'merge', '--ff-only', state.parent_head);
    } else {
      // 未检出的子分支没有 index/worktree 要同步；compare-and-swap 保证外部进程抢先推进时安全失败。
      await this.git(this.config.project, 'update-ref', `refs/heads/${state.child}`, state.parent_head, state.child_head);
    }
    return { ...state, caught_up: true, ahead: 0, behind: 0, from: state.child_head, to: state.parent_head,
      child_head: state.parent_head, new_head: state.parent_head, merged: false };
  },

  catchupBranch(child) { return this.exclusive(() => this.catchupBranchUnsafe(child)); },

  /** 迁移兼容：旧任务没有 input branch/direct-parent target，继续按旧目标分支语义落地。新任务不走这里。 */
  async legacyMergeUnsafe(task) {
    const project = this.config.project;
    await this.clean(project);
    await this.clean(task.workspace);
    check(await this.git(project, 'symbolic-ref', '--short', 'HEAD') === task.target_branch, `switch to ${task.target_branch} before merging`);
    check(await this.git(task.workspace, 'rev-parse', 'HEAD') === task.head_commit, 'task branch changed after review');
    const resolved = task.resolves_task_id ? this.store.task(task.resolves_task_id) : null;
    if (resolved) {
      check(resolved.head_commit && await this.isAncestor(project, resolved.head_commit, task.head_commit),
        `resolution #${task.id} does not contain the reviewed commit of #${resolved.id}; land a branch that keeps that work`);
    }
    for (const edge of this.store.deps(task.id).filter(edge => edge.kind === 'code')) {
      const upstream = this.store.task(edge.depends_on);
      check(upstream.head_commit && await this.isAncestor(project, upstream.head_commit, 'HEAD'),
        `code dependency #${upstream.id} is not merged into ${task.target_branch} yet; merge #${upstream.id} first so this branch does not carry it along`);
    }
    const fastForward = resolved ? true : await this.isAncestor(project, 'HEAD', task.head_commit);
    this.store.update(task.id, { integration: 'merging', integration_error: null });
    this.store.event(task.id, 'merge.approved', { commit: task.head_commit, fast_forward: fastForward, legacy: true });
    try {
      if (fastForward) await this.git(project, 'merge', '--ff-only', task.head_commit);
      else await this.git(project, 'merge', '--no-ff', '--no-edit', task.head_commit);
      this.store.update(task.id, { integration: 'merged' });
      this.store.event(task.id, 'merged', { commit: task.head_commit, legacy: true });
      return { task: this.store.task(task.id), conflict: null };
    } catch (error) {
      const files = await this.unmerged(project).catch(() => []);
      let abortError = null;
      if (await this.merging(project)) {
        try { await this.git(project, 'merge', '--abort'); } catch (err) { abortError = err.message; }
      }
      const detail = `${error.message}${abortError ? `\nCheck repository state: ${abortError}` : ''}`;
      this.store.update(task.id, { integration: 'pending', integration_error: detail });
      this.store.event(task.id, 'merge.failed', { error: error.message, files });
      if (abortError) throw new LushError(detail);
      if (files.length) return { task: this.store.task(task.id), conflict: { files, output: error.message } };
      throw error;
    }
  },

  /** 批量交付的只读预检：在第一项改写主树前把共同分支、脏树、审阅提交漂移与 resolver 完整性一次查完。 */
  preflightMerge(tasks) {
    return this.exclusive(async () => {
      check(Array.isArray(tasks) && tasks.length > 0, 'merge preflight needs tasks');
      const project = this.config.project;
      const targets = [...new Set(tasks.map(task => task.target_branch))];
      check(targets.length === 1 && targets[0], 'merge preflight requires one target branch');
      const legacy = tasks.every(task => !this.store.task(task.id).input_id);
      if (legacy) {
        await this.clean(project);
        check(await this.git(project, 'symbolic-ref', '--short', 'HEAD') === targets[0], `switch to ${targets[0]} before merging`);
        for (const raw of tasks) {
          const task = this.store.task(raw.id);
          check(task.status === 'completed' && ['pending','review','conflict'].includes(task.integration), `#${task.id} is not a completed merge candidate`);
          await this.clean(task.workspace);
          check(await this.git(task.workspace, 'rev-parse', 'HEAD') === task.head_commit, `task #${task.id} branch changed after review`);
          if (task.resolves_task_id) {
            const resolved = this.store.task(task.resolves_task_id);
            check(resolved.head_commit && await this.isAncestor(project, resolved.head_commit, task.head_commit),
              `resolution #${task.id} does not contain the reviewed commit of #${resolved.id}; land a branch that keeps that work`);
          }
        }
        return { target_branch: targets[0], tasks: tasks.map(task => task.id) };
      }
      const targetWorkspace = await this.workspaceForBranch(targets[0]);
      if (targetWorkspace) await this.clean(targetWorkspace);
      for (const raw of tasks) {
        const task = this.store.task(raw.id);
        check(task.status === 'completed' && ['pending','review','conflict'].includes(task.integration), `#${task.id} is not a completed merge candidate`);
        if (task.workspace) await this.clean(task.workspace);
        const state = await this.branchState(task.branch);
        check(state.parent === task.target_branch, `task #${task.id} no longer targets its direct parent`);
        check(task.head_commit && state.child_head && await this.isAncestor(project, task.head_commit, state.child_head),
          `task #${task.id} branch no longer contains its reviewed commit`);
        if (task.resolves_task_id) {
          const resolved = this.store.task(task.resolves_task_id);
          check(resolved.head_commit && await this.isAncestor(project, resolved.head_commit, state.child_head),
            `resolution #${task.id} does not contain the reviewed commit of #${resolved.id}; land a branch that keeps that work`);
        }
      }
      return { target_branch: targets[0], tasks: tasks.map(task => task.id) };
    });
  },
  /**
   * 批准一次合并。三种结局：
   *   {task, conflict: null}          合并成功，integration=merged
   *   {task, conflict: {files, output}} 内容冲突：main 已 abort 回合并前的干净状态，等用户决定下一步
   *   throw                            前置门槛不通过（脏树、分支不对、审阅后又被改、上游未合），或 abort 没成功
   * 「冲突」是正常结局，不是异常：它必须能被上层转成一个待决决定，而不是一句报错。
   */
  merge(taskId) {
    return this.exclusive(async () => {
      const task = this.store.task(taskId);
      check(task.status === 'completed' && ['pending','review','conflict'].includes(task.integration), 'only completed tasks with pending/review/conflict changes can be merged');
      check(task.branch, `task #${task.id} has no branch`);
      const record = this.store.branch(task.branch);
      if (!task.input_id || record?.parent !== task.target_branch) return this.legacyMergeUnsafe(task);
      const project = this.config.project;
      const state = await this.branchState(task.branch);
      check(state.parent === task.target_branch, `task #${task.id} targets ${task.target_branch}, but its recorded parent is ${state.parent}`);
      // task.head_commit 是 agent 交付时审阅过的提交；分支之后可以聚合直接子分支，但不能把原成果丢掉。
      check(task.head_commit && state.child_head && await this.isAncestor(project, task.head_commit, state.child_head),
        `task #${task.id} branch no longer contains its reviewed commit`);
      const resolved = task.resolves_task_id ? this.store.task(task.resolves_task_id) : null;
      if (resolved) {
        check(resolved.head_commit, `#${task.id} resolves #${resolved.id}, which has no reviewed commit`);
        check(await this.isAncestor(project, resolved.head_commit, state.child_head),
          `resolution #${task.id} does not contain the reviewed commit of #${resolved.id}`);
      }
      this.store.update(task.id, { integration: 'merging', integration_error: null });
      this.store.event(task.id, 'merge.approved', { commit: state.child_head, parent: state.parent,
        fast_forward: state.status === 'fast_forward' });
      try {
        const outcome = await this.mergeBranchUnsafe(task.branch);
        if (outcome.needs_sync) {
          this.store.update(task.id, { integration: 'pending', integration_error: `branch diverged from ${state.parent}` });
          this.store.event(task.id, 'merge.diverged', outcome);
          return { task: this.store.task(task.id), conflict: null, diverged: outcome };
        }
        this.store.update(task.id, { integration: 'merged', integration_error: null });
        this.store.event(task.id, 'merged', { commit: outcome.child_head, parent: outcome.parent,
          already_integrated: outcome.already_integrated === true });
        return { task: this.store.task(task.id), conflict: null, branch: outcome };
      } catch (error) {
        // 新路径只有 ff-only / compare-and-swap，不会留下需要人工检查的 merge 中间态。
        this.store.update(task.id, { integration: 'pending', integration_error: error.message });
        this.store.event(task.id, 'merge.failed', { error: error.message, files: [] });
        throw error;
      }
    });
  },
};
