import { check, LushError } from '../types.js';

/** 分支关系、批准合并的预检与落地。 */
export const methods = {
  /** 尚未落成/完成分支、但未来可能改变 child 的 AP，也必须阻止 child 提前向上交付。 */
  branchAPBlockers(child) {
    const record = this.store.branch(child);
    const blockers = [];
    if (record?.ap_id !== null && record?.ap_id !== undefined) {
      const owner = this.store.get('SELECT id,status FROM aps WHERE id=?', record.ap_id);
      if (owner && !['completed','failed','cancelled'].includes(owner.status)) blockers.push(`ap:#${owner.id}`);
      for (const row of this.store.all(`SELECT aps.id,aps.status,aps.branch FROM ap_deps
        JOIN aps ON aps.id=ap_deps.ap_id WHERE ap_deps.depends_on=? AND ap_deps.kind='code'`, record.ap_id)) {
        if (!['completed','failed','cancelled'].includes(row.status) && !row.branch) blockers.push(`ap:#${row.id}`);
      }
    } else {
      const input = this.store.get('SELECT id FROM inputs WHERE anchor_branch=?', child);
      if (input) for (const row of this.store.all("SELECT id FROM aps WHERE input_id=? AND status NOT IN ('completed','failed','cancelled')", input.id)) {
        blockers.push(`ap:#${row.id}`);
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
    const blockers = this.branchAPBlockers(child);
    // 归档的分支没有本地 ref，不再是任何分支的 blocker；这里显式排除，别名不依赖 rev-parse 失败。
    for (const descendant of this.store.branches().filter(row => row.parent === child && !['deleted', 'archived'].includes(row.status))) {
      let head = null;
      try { head = await this.git(project, 'rev-parse', '--verify', `refs/heads/${descendant.branch}^{commit}`); } catch { continue; }
      if (!await this.isAncestor(project, head, childHead)) blockers.push(descendant.branch);
    }
    return { child, parent: record.parent, child_head: childHead, parent_head: parentHead,
      status, ahead: Number.isFinite(ahead) ? ahead : null, behind: Number.isFinite(behind) ? behind : null, blockers };
  },

  /**
   * 在已经持有 Git 串行锁时，将 direct child 快进到 parent；发生分歧时绝不在 parent 上制造 merge commit。
   * 传了 expected 就交付这个固定 commit，而不是可变的 child tip：Candidate 审阅过的提交与
   * 落地的提交是同一个对象，两次读取之间分支前进既不扩大交付范围，也不会悄悄换成别的树。
   * 校验与落地都在这个串行区间内完成；expected 已经进入 parent 时是幂等成功。
   */
  async mergeBranchUnsafe(child, expected = null, expectedParent = null) {
    const state = await this.branchState(child);
    if (expectedParent) check(state.parent_head === expectedParent,
      `parent ${state.parent} moved since its fixed baseline; inspect before approving`);
    check(state.status !== 'missing', `cannot merge ${child}: child or parent branch is missing`);
    check(state.blockers.length === 0, `merge ${state.child} into ${state.parent} is blocked by unintegrated child branches: ${state.blockers.join(', ')}`);
    const project = this.config.project;
    if (expected) {
      // 固定提交只有两种合法结局：已经在父分支里（幂等），或者能从父分支 fast-forward 过去。
      if (await this.isAncestor(project, expected, state.parent_head))
        return { ...state, merged: false, already_integrated: true, landed: expected };
      check(await this.isAncestor(project, state.parent_head, expected),
        `cannot land ${expected.slice(0, 12)} into ${state.parent}: ${state.child} moved and that commit is no longer a fast-forward from ${state.parent_head.slice(0, 12)}; re-review the frozen commit before landing`);
    } else {
      if (state.status === 'integrated') return { ...state, merged: false, already_integrated: true };
      if (state.status === 'diverged') return { ...state, merged: false, needs_sync: true };
    }
    const landed = expected ?? state.child_head;
    const childWorkspace = await this.workspaceForBranch(state.child);
    if (childWorkspace) await this.clean(childWorkspace);
    const parentWorkspace = await this.workspaceForBranch(state.parent);
    if (parentWorkspace) {
      await this.clean(parentWorkspace);
      check(await this.git(parentWorkspace, 'symbolic-ref', '--short', 'HEAD') === state.parent,
        `worktree ${parentWorkspace} is no longer on ${state.parent}`);
      if (expectedParent) check(await this.git(parentWorkspace, 'rev-parse', 'HEAD') === expectedParent,
        `parent ${state.parent} moved during approval; inspect before approving`);
      await this.git(parentWorkspace, 'merge', '--ff-only', landed);
    } else {
      // 未检出的父分支没有 index/worktree 要同步；compare-and-swap 更新 ref，外部进程抢先推进就安全失败。
      await this.git(this.config.project, 'update-ref', `refs/heads/${state.parent}`, landed, expectedParent ?? state.parent_head);
    }
    return { ...state, status: 'integrated', merged: true, new_head: landed, landed };
  },

  mergeBranch(child, expected = null) { return this.exclusive(() => this.mergeBranchUnsafe(child, expected)); },

  /**
   * 把一条分支快进到一个已经包含它当前顶端的提交（例如独立解分歧子 AP 的产物）。
   * 有检出的 worktree 就在里面 `git merge --ff-only`，否则 compare-and-swap ref；不产生 merge commit，
   * 也不接受非快进的移动。终态 say 吸收解分歧固定提交后重新发合并请求时用到。
   */
  async fastForwardBranchUnsafe(branch, to) {
    const project = this.config.project;
    check(typeof to === 'string' && /^[0-9a-f]{40,64}$/.test(to), 'fast-forward target must be a commit');
    const head = await this.git(project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
      .catch(() => { throw new Error(`local branch ${branch} does not exist`); });
    check(await this.isAncestor(project, head, to),
      `cannot fast-forward ${branch}: ${String(to).slice(0, 12)} does not contain ${String(head).slice(0, 12)}`);
    if (head === to) return { branch, from: head, to, already_at: true };
    const workspace = await this.workspaceForBranch(branch);
    if (workspace) {
      await this.clean(workspace);
      check(await this.git(workspace, 'symbolic-ref', '--short', 'HEAD') === branch,
        `worktree ${workspace} is no longer on ${branch}`);
      await this.git(workspace, 'merge', '--ff-only', to);
    } else {
      await this.git(project, 'update-ref', `refs/heads/${branch}`, to, head);
    }
    return { branch, from: head, to, already_at: false };
  },


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

  fastForwardBranch(branch, to) { return this.exclusive(() => this.fastForwardBranchUnsafe(branch, to)); },

  /** 迁移兼容：旧 AP 没有 input branch/direct-parent target，继续按旧目标分支语义落地。新 AP 不走这里。 */
  async legacyMergeUnsafe(ap) {
    const project = this.config.project;
    await this.clean(project);
    await this.clean(ap.workspace);
    check(await this.git(project, 'symbolic-ref', '--short', 'HEAD') === ap.target_branch, `switch to ${ap.target_branch} before merging`);
    check(await this.git(ap.workspace, 'rev-parse', 'HEAD') === ap.head_commit, 'AP branch changed after review');
    const resolved = ap.resolves_ap_id ? this.store.ap(ap.resolves_ap_id) : null;
    if (resolved) {
      check(resolved.head_commit && await this.isAncestor(project, resolved.head_commit, ap.head_commit),
        `resolution #${ap.id} does not contain the reviewed commit of #${resolved.id}; land a branch that keeps that work`);
    }
    for (const edge of this.store.deps(ap.id).filter(edge => edge.kind === 'code')) {
      const upstream = this.store.ap(edge.depends_on);
      check(upstream.head_commit && await this.isAncestor(project, upstream.head_commit, 'HEAD'),
        `code dependency #${upstream.id} is not merged into ${ap.target_branch} yet; merge #${upstream.id} first so this branch does not carry it along`);
    }
    const fastForward = resolved ? true : await this.isAncestor(project, 'HEAD', ap.head_commit);
    this.store.update(ap.id, { integration: 'merging', integration_error: null });
    this.store.event(ap.id, 'merge.approved', { commit: ap.head_commit, fast_forward: fastForward, legacy: true });
    try {
      if (fastForward) await this.git(project, 'merge', '--ff-only', ap.head_commit);
      else await this.git(project, 'merge', '--no-ff', '--no-edit', ap.head_commit);
      this.store.update(ap.id, { integration: 'merged' });
      this.store.event(ap.id, 'merged', { commit: ap.head_commit, legacy: true });
      return { ap: this.store.ap(ap.id), conflict: null };
    } catch (error) {
      const files = await this.unmerged(project).catch(() => []);
      let abortError = null;
      if (await this.merging(project)) {
        try { await this.git(project, 'merge', '--abort'); } catch (err) { abortError = err.message; }
      }
      const detail = `${error.message}${abortError ? `\nCheck repository state: ${abortError}` : ''}`;
      this.store.update(ap.id, { integration: 'pending', integration_error: detail });
      this.store.event(ap.id, 'merge.failed', { error: error.message, files });
      if (abortError) throw new LushError(detail);
      if (files.length) return { ap: this.store.ap(ap.id), conflict: { files, output: error.message } };
      throw error;
    }
  },

  /** 批量交付的只读预检：在第一项改写主树前把共同分支、脏树、审阅提交漂移与 resolver 完整性一次查完。 */
  preflightMerge(aps) {
    return this.exclusive(async () => {
      check(Array.isArray(aps) && aps.length > 0, 'merge preflight needs aps');
      const project = this.config.project;
      const targets = [...new Set(aps.map(ap => ap.target_branch))];
      check(targets.length === 1 && targets[0], 'merge preflight requires one target branch');
      const legacy = aps.every(ap => !this.store.ap(ap.id).input_id);
      if (legacy) {
        await this.clean(project);
        check(await this.git(project, 'symbolic-ref', '--short', 'HEAD') === targets[0], `switch to ${targets[0]} before merging`);
        for (const raw of aps) {
          const ap = this.store.ap(raw.id);
          check(ap.status === 'completed' && ['pending','review','conflict'].includes(ap.integration), `#${ap.id} is not a completed merge candidate`);
          await this.clean(ap.workspace);
          check(await this.git(ap.workspace, 'rev-parse', 'HEAD') === ap.head_commit, `AP #${ap.id} branch changed after review`);
          if (ap.resolves_ap_id) {
            const resolved = this.store.ap(ap.resolves_ap_id);
            check(resolved.head_commit && await this.isAncestor(project, resolved.head_commit, ap.head_commit),
              `resolution #${ap.id} does not contain the reviewed commit of #${resolved.id}; land a branch that keeps that work`);
          }
        }
        return { target_branch: targets[0], aps: aps.map(ap => ap.id) };
      }
      const targetWorkspace = await this.workspaceForBranch(targets[0]);
      if (targetWorkspace) await this.clean(targetWorkspace);
      for (const raw of aps) {
        const ap = this.store.ap(raw.id);
        check(ap.status === 'completed' && ['pending','review','conflict'].includes(ap.integration), `#${ap.id} is not a completed merge candidate`);
        if (ap.workspace) await this.clean(ap.workspace);
        const state = await this.branchState(ap.branch);
        check(state.parent === ap.target_branch, `AP #${ap.id} no longer targets its direct parent`);
        check(ap.head_commit && state.child_head && await this.isAncestor(project, ap.head_commit, state.child_head),
          `AP #${ap.id} branch no longer contains its reviewed commit`);
        if (ap.resolves_ap_id) {
          const resolved = this.store.ap(ap.resolves_ap_id);
          check(resolved.head_commit && await this.isAncestor(project, resolved.head_commit, state.child_head),
            `resolution #${ap.id} does not contain the reviewed commit of #${resolved.id}; land a branch that keeps that work`);
        }
      }
      return { target_branch: targets[0], aps: aps.map(ap => ap.id) };
    });
  },
  /**
   * 批准一次合并。三种结局：
   *   {ap, conflict: null}          合并成功，integration=merged
   *   {ap, conflict: {files, output}} 内容冲突：main 已 abort 回合并前的干净状态，等用户决定下一步
   *   throw                            前置门槛不通过（脏树、分支不对、审阅后又被改、上游未合），或 abort 没成功
   * 「冲突」是正常结局，不是异常：它必须能被上层转成一个待决决定，而不是一句报错。
   */
  merge(apId) {
    return this.exclusive(async () => {
      const ap = this.store.ap(apId);
      check(ap.status === 'completed' && ['pending','review','conflict'].includes(ap.integration), 'only completed aps with pending/review/conflict changes can be merged');
      check(ap.branch, `AP #${ap.id} has no branch`);
      const record = this.store.branch(ap.branch);
      if (!ap.input_id || record?.parent !== ap.target_branch) return this.legacyMergeUnsafe(ap);
      const project = this.config.project;
      const state = await this.branchState(ap.branch);
      check(state.parent === ap.target_branch, `AP #${ap.id} targets ${ap.target_branch}, but its recorded parent is ${state.parent}`);
      // ap.head_commit 是 agent 交付时审阅过的提交；分支之后可以聚合直接子分支，但不能把原成果丢掉。
      check(ap.head_commit && state.child_head && await this.isAncestor(project, ap.head_commit, state.child_head),
        `AP #${ap.id} branch no longer contains its reviewed commit`);
      const resolved = ap.resolves_ap_id ? this.store.ap(ap.resolves_ap_id) : null;
      if (resolved) {
        check(resolved.head_commit, `#${ap.id} resolves #${resolved.id}, which has no reviewed commit`);
        check(await this.isAncestor(project, resolved.head_commit, state.child_head),
          `resolution #${ap.id} does not contain the reviewed commit of #${resolved.id}`);
      }
      this.store.update(ap.id, { integration: 'merging', integration_error: null });
      this.store.event(ap.id, 'merge.approved', { commit: state.child_head, parent: state.parent,
        fast_forward: state.status === 'fast_forward' });
      try {
        const outcome = await this.mergeBranchUnsafe(ap.branch);
        if (outcome.needs_sync) {
          this.store.update(ap.id, { integration: 'pending', integration_error: `branch diverged from ${state.parent}` });
          this.store.event(ap.id, 'merge.diverged', outcome);
          return { ap: this.store.ap(ap.id), conflict: null, diverged: outcome };
        }
        this.store.update(ap.id, { integration: 'merged', integration_error: null });
        this.store.event(ap.id, 'merged', { commit: outcome.child_head, parent: outcome.parent,
          already_integrated: outcome.already_integrated === true });
        return { ap: this.store.ap(ap.id), conflict: null, branch: outcome };
      } catch (error) {
        // 新路径只有 ff-only / compare-and-swap，不会留下需要人工检查的 merge 中间态。
        this.store.update(ap.id, { integration: 'pending', integration_error: error.message });
        this.store.event(ap.id, 'merge.failed', { error: error.message, files: [] });
        throw error;
      }
    });
  },
};
