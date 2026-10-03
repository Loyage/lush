import * as types from '../types.js';
const { check, LushError } = types;
// The additive lifecycle mixin can land independently of this Git module.
const isSettled = task => types.isSettled?.(task) ?? (['completed', 'failed', 'cancelled'].includes(task.status)
  || (task.status === 'awaiting_acceptance' && task.integration === 'merged'));

const oid = value => typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value);

function taskSquashReceipt(receipt) {
  check(receipt && oid(receipt.commit) && oid(receipt.source) && oid(receipt.baseline) && oid(receipt.tree)
    && typeof receipt.child === 'string' && receipt.child && typeof receipt.parent === 'string' && receipt.parent
    && receipt.child !== receipt.parent && (receipt.workspace === null || (typeof receipt.workspace === 'string' && receipt.workspace)),
  'invalid worker squash receipt');
  // A caller cannot change the persisted credentials while asynchronous Git checks are in flight.
  return Object.freeze({ ...receipt });
}

function taskSquashGuard(guard) {
  const result = guard();
  if (result && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw new LushError('worker squash guard must be synchronous');
  }
  check(result !== false, 'worker squash cancelled before write');
}

/** Lock both fixed refs before touching the index, then CAS the parent only after the checkout is ready. */
async function applyTaskSquashTransaction(workspaces, receipt, guard, action) {
  const proc = Bun.spawn(['git', '-C', workspaces.config.project, '-c', 'core.hooksPath=/dev/null',
    'update-ref', '-m', 'Lush task squash', '--stdin'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...workspaces.config.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const errorText = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  let output = '', committed = false;
  const response = async expected => {
    while (!output.includes(expected)) {
      const chunk = await reader.read();
      if (chunk.done) throw new LushError(`worker squash refs moved or locked: ${await errorText}`);
      output += new TextDecoder().decode(chunk.value);
    }
  };
  try {
    proc.stdin.write(`start\nverify refs/heads/${receipt.child} ${receipt.source}\nupdate refs/heads/${receipt.parent} ${receipt.commit} ${receipt.baseline}\nprepare\n`);
    await proc.stdin.flush();
    await response('prepare: ok\n');
    await action();
    taskSquashGuard(guard); // No await between runtime cancellation/new-input guard and this write.
    proc.stdin.write('commit\n');
    await proc.stdin.flush();
    await response('commit: ok\n');
    committed = true;
  } finally {
    try { if (!committed) proc.stdin.write('abort\n'); proc.stdin.end(); } catch { /* Git rejected the transaction. */ }
    while (!(await reader.read()).done) { /* Drain the protocol before releasing the Git queue. */ }
    await proc.exited;
    await errorText;
  }
}

/** Check only immutable objects; recovery must never mistake an equivalent new commit for this receipt. */
async function checkTaskSquashObjects(workspaces, receipt) {
  const project = workspaces.config.project;
  const identity = await workspaces.git(project, 'show', '--no-patch', '--format=%H %T %P', receipt.commit);
  check(identity === `${receipt.commit} ${receipt.tree} ${receipt.baseline}`,
    'worker squash receipt must match the exact single-parent commit and tree');
  check(await workspaces.commitTree(receipt.source) === receipt.tree, 'worker squash tree differs from fixed source');
  check(await workspaces.isAncestor(project, receipt.baseline, receipt.source),
    'diverged source must be repaired before worker squash');
}

/** External Git is outside our queue: never report success for a different checkout/ref.
 * This detects drift, but cannot undo or prevent another process touching the worktree.
 * Leave all evidence in place rather than reset a user's checkout on failure.
 */
async function verifyFastForward(workspaces, branch, commit, workspace) {
  const message = `fast-forward target ${branch} changed during landing; inspect refs and worktree before retrying`;
  check(await workspaces.git(workspaces.config.project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`) === commit, message);
  if (workspace) {
    check(await workspaces.git(workspace, 'symbolic-ref', '--quiet', 'HEAD') === `refs/heads/${branch}`
      && await workspaces.git(workspace, 'rev-parse', 'HEAD') === commit, message);
    await workspaces.clean(workspace);
  }
  check(await workspaces.git(workspaces.config.project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`) === commit, message);
}

/** 分支关系、批准合并的预检与落地。 */
export const methods = {
  /** 尚未落成/完成分支、但未来可能改变 child 的任务，也必须阻止 child 提前向上交付。 */
  branchTaskBlockers(child) {
    const record = this.store.branch(child);
    const blockers = [];
    if (record?.task_id !== null && record?.task_id !== undefined) {
      const owner = this.store.get('SELECT id,status,integration FROM tasks WHERE id=?', record.task_id);
      if (owner && !isSettled(owner)) blockers.push(`task:#${owner.id}`);
      for (const row of this.store.all(`SELECT tasks.id,tasks.status,tasks.integration,tasks.branch FROM task_deps
        JOIN tasks ON tasks.id=task_deps.task_id WHERE task_deps.depends_on=? AND task_deps.kind='code'`, record.task_id)) {
        if (!isSettled(row) && !row.branch) blockers.push(`task:#${row.id}`);
      }
    } else {
      const input = this.store.get('SELECT id FROM inputs WHERE anchor_branch=?', child);
      if (input) for (const row of this.store.all("SELECT id,status,integration FROM tasks WHERE input_id=? AND status NOT IN ('completed','failed','cancelled')", input.id)) {
        if (!isSettled(row)) blockers.push(`task:#${row.id}`);
      }
    }
    return [...new Set(blockers)];
  },

  /**
   * version 2 Squash 在父分支上落成一个等价树的新提交，Git 祖先关系因此看不出这条子分支已经进了父分支。
   * 在用户显式归档前，只要 ref 仍停在集成时固定的源提交、且记录的落地提交确实是 `onto` 的祖先，
   * 就如实把它当作已收拢；ref 一旦漂移就不再命中，按未收拢显示。供 branchState / 图读模型共用。
   */
  async squashedLanded(branch, onto) {
    if (!branch || !onto) return false;
    const record = this.store.branch(branch);
    if (!record || record.status !== 'active' || record.task_id === null || record.task_id === undefined) return false;
    // Receipts survive reopening and replacement of the current delivery reservation.
    const receipt = this.store.get("SELECT data FROM events WHERE task_id=? AND type='task.merge_integrated' ORDER BY id DESC LIMIT 1", record.task_id);
    let source, landed;
    try {
      if (receipt) {
        const data = JSON.parse(receipt.data);
        const parent = this.store.get('SELECT branch FROM tasks WHERE id=?', data.parent_id);
        if (parent?.branch !== record.parent) return false;
        source = data.source_commit; landed = data.commit;
      } else {
        const task = this.store.get('SELECT reservation FROM tasks WHERE id=?', record.task_id);
        const booking = task?.reservation ? JSON.parse(task.reservation) : null;
        if (booking?.version !== 2 || booking.status !== 'integrated') return false;
        source = booking.commit; landed = booking.landed_commit;
      }
    } catch { return false; }
    if (!source || !landed) return false;
    const project = this.config.project;
    let tip = null;
    try { tip = await this.git(project, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`); } catch { return false; }
    if (tip !== source) return false;
    return this.isAncestor(project, landed, onto);
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
      if (await this.isAncestor(project, head, childHead)) continue;
      // Squash 落地的子分支祖先关系看不到，但成果已在 childHead 里；ref 未漂移就不算 blocker。
      if (await this.squashedLanded(descendant.branch, childHead)) continue;
      blockers.push(descendant.branch);
    }
    // 自己就是已 Squash 落地、尚未归档的分支：按 integrated 报告，不谎报分歧；Squash 后没有要再收拢的独有提交。
    if (status !== 'integrated' && await this.squashedLanded(child, parentHead)) {
      status = 'integrated';
      return { child, parent: record.parent, child_head: childHead, parent_head: parentHead,
        status, ahead: 0, behind: 0, blockers };
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
    await verifyFastForward(this, state.parent, landed, parentWorkspace);
    return { ...state, status: 'integrated', merged: true, new_head: landed, landed };
  },

  mergeBranch(child, expected = null) { return this.exclusive(() => this.mergeBranchUnsafe(child, expected)); },

  /**
   * Pre-create the exact object, without changing a ref, index or worktree. Caller holds the Git queue
   * and must persist this receipt before apply. Even an equal tree has an exact single-parent object;
   * runtime decides whether a no-change delivery needs a commit before calling this boundary.
   */
  async prepareTaskSquashUnsafe(child, source, baseline, message) {
    check(oid(source) && oid(baseline), 'worker squash requires fixed commits');
    check(typeof message === 'string' && message.trim(), 'worker squash requires a commit message');
    const state = await this.branchState(child);
    check(state.child_head === source && state.parent_head === baseline, 'source/target moved before worker squash preparation');
    check(state.blockers.every(blocker => blocker === `task:#${this.store.branch(child)?.task_id}`),
      'unintegrated descendant branches block worker squash');
    await this.assertCleanBranches([child, state.parent]);
    const workspace = await this.workspaceForBranch(state.parent);
    if (workspace) {
      await this.clean(workspace);
      check(await this.git(workspace, 'symbolic-ref', '--quiet', 'HEAD') === `refs/heads/${state.parent}`
        && await this.git(workspace, 'rev-parse', 'HEAD') === baseline, 'parent checkout moved before worker squash preparation');
    }
    check(await this.isAncestor(this.config.project, baseline, source), 'diverged source must be repaired before worker squash');
    const tree = await this.commitTree(source);
    const commit = await this.git(this.config.project, '-c', 'user.name=Lush', '-c', 'user.email=lush@localhost',
      'commit-tree', tree, '-p', baseline, '-m', message);
    return Object.freeze({ child, commit, source, baseline, tree, parent: state.parent, workspace });
  },

  /**
   * Apply once, never replay unknown side effects. The ref transaction holds source AND parent while
   * read-tree's two-tree merge synchronizes the checkout without reset/clean or commit hooks. If a
   * write fails (including cancellation after read-tree), abort only the ref transaction: leave all
   * index/worktree evidence in place. Runtime must block the target until it is inspected/reconciled.
   */
  async applyTaskSquashUnsafe(credentials, guard) {
    const receipt = taskSquashReceipt(credentials);
    check(typeof guard === 'function', 'worker squash requires a synchronous write guard');
    const project = this.config.project;
    await this.git(project, 'check-ref-format', `refs/heads/${receipt.child}`);
    await this.git(project, 'check-ref-format', `refs/heads/${receipt.parent}`);
    await checkTaskSquashObjects(this, receipt);
    const checkRefs = async () => {
      const state = await this.branchState(receipt.child);
      check(state.parent === receipt.parent && state.child_head === receipt.source && state.parent_head === receipt.baseline,
        'source/target moved before worker squash apply');
      check(state.blockers.every(blocker => blocker === `task:#${this.store.branch(receipt.child)?.task_id}`),
        'unintegrated descendant branches block worker squash');
      check(await this.workspaceForBranch(receipt.parent) === receipt.workspace, 'parent worktree changed before worker squash apply');
      await this.assertCleanBranches([receipt.child, receipt.parent]);
      if (receipt.workspace) {
        await this.clean(receipt.workspace);
        check(await this.git(receipt.workspace, 'symbolic-ref', '--quiet', 'HEAD') === `refs/heads/${receipt.parent}`
          && await this.git(receipt.workspace, 'rev-parse', 'HEAD') === receipt.baseline, 'parent checkout moved before worker squash apply');
      }
    };
    await checkRefs();
    await applyTaskSquashTransaction(this, receipt, guard, async () => {
      // Ref locks also close drift during the asynchronous cleanliness/ancestry checks.
      await checkRefs();
      taskSquashGuard(guard);
      if (receipt.workspace) {
        await this.git(receipt.workspace, 'read-tree', '-m', '-u', receipt.baseline, receipt.commit);
        check(await this.git(receipt.workspace, 'write-tree') === receipt.tree, 'worker squash checkout staged a different tree');
        await this.git(receipt.workspace, 'diff-files', '--quiet', '--ignore-submodules=none');
        check(!await this.git(receipt.workspace, 'ls-files', '--others', '--exclude-standard', '--', '.', ':(exclude).lush'),
          'parent worktree became dirty during worker squash apply');
        check(await this.git(receipt.workspace, 'symbolic-ref', '--quiet', 'HEAD') === `refs/heads/${receipt.parent}`,
          'parent checkout moved during worker squash apply');
      }
      await this.assertCleanBranches([receipt.child]);
    });
    check(await this.verifyTaskSquashUnsafe(receipt), 'worker squash landed but exact receipt/worktree verification failed; inspect before continuing');
    return receipt;
  },

  /** Read-only exact recovery proof. False means inspect/block, never invoke apply to guess/replay. */
  async verifyTaskSquashUnsafe(credentials) {
    try {
      const receipt = taskSquashReceipt(credentials);
      await checkTaskSquashObjects(this, receipt);
      const project = this.config.project;
      const head = await this.git(project, 'rev-parse', '--verify', `refs/heads/${receipt.parent}^{commit}`);
      check(await this.isAncestor(project, receipt.commit, head), 'exact worker squash commit is not on target');
      check(await this.workspaceForBranch(receipt.parent) === receipt.workspace, 'worker squash target worktree changed');
      await this.assertCleanBranches([receipt.parent]);
      if (receipt.workspace) {
        await this.clean(receipt.workspace);
        check(await this.git(receipt.workspace, 'symbolic-ref', '--quiet', 'HEAD') === `refs/heads/${receipt.parent}`
          && await this.git(receipt.workspace, 'rev-parse', 'HEAD') === head, 'worker squash target checkout changed');
      }
      check(await this.git(project, 'rev-parse', '--verify', `refs/heads/${receipt.parent}^{commit}`) === head,
        'worker squash target moved during verification');
      return true;
    } catch { return false; }
  },

  /** Historical compatibility: squash a verified child tip into one parent commit. Caller holds the Git queue. */
  async squashBranchUnsafe(child, source, parentHead, message) {
    const project = this.config.project;
    const state = await this.branchState(child);
    check(state.parent_head === parentHead && state.child_head === source, 'source/target moved before squash');
    check(state.blockers.every(blocker => blocker === `task:#${this.store.branch(child)?.task_id}`),
      'unintegrated descendant branches block squash');
    const childWorkspace = await this.workspaceForBranch(child);
    if (childWorkspace) await this.clean(childWorkspace);
    const parentWorkspace = await this.workspaceForBranch(state.parent);
    if (parentWorkspace) {
      await this.clean(parentWorkspace);
      check(await this.git(parentWorkspace, 'symbolic-ref', '--short', 'HEAD') === state.parent
        && await this.git(parentWorkspace, 'rev-parse', 'HEAD') === parentHead,
      'parent checkout moved before squash');
    }
    if (await this.isAncestor(project, source, parentHead))
      return { commit: parentHead, already_integrated: true };
    check(await this.isAncestor(project, parentHead, source), 'diverged source must be repaired before squash');
    const parentTree = await this.git(project, 'rev-parse', `${parentHead}^{tree}`);
    const sourceTree = await this.git(project, 'rev-parse', `${source}^{tree}`);
    if (parentTree === sourceTree) return { commit: parentHead, already_integrated: true };
    if (parentWorkspace) {
      // --squash stages the exact source tree for a fast-forwardable child, then writes one commit.
      await this.git(parentWorkspace, 'merge', '--squash', source);
      try {
        const staged = await this.git(parentWorkspace, 'write-tree');
        check(staged === sourceTree, 'squash staged a different tree than the reviewed child');
        await this.git(parentWorkspace, '-c', 'user.name=Lush', '-c', 'user.email=lush@localhost',
          'commit', '-m', message);
      } catch (error) {
        // Do not reset/clean user state if commit fails: preserve the staged result for inspection.
        throw error;
      }
      const commit = await this.git(parentWorkspace, 'rev-parse', 'HEAD');
      check(await this.git(parentWorkspace, 'rev-parse', 'HEAD^') === parentHead,
        'squash must create exactly one parent commit');
      return { commit, already_integrated: false };
    }
    const commit = await this.git(project, '-c', 'user.name=Lush', '-c', 'user.email=lush@localhost',
      'commit-tree', sourceTree, '-p', parentHead, '-m', message);
    await this.git(project, 'update-ref', `refs/heads/${state.parent}`, commit, parentHead);
    return { commit, already_integrated: false };
  },

  /** Delete the source ref after squash only when its reviewed tree survives in the target. */
  async archiveSquashedTaskUnsafe(task, source, landed) {
    check(task.integration === 'merged' && task.branch && task.target_branch, 'only integrated workers can be archived');
    const project = this.config.project;
    const tip = await this.git(project, 'rev-parse', `refs/heads/${task.branch}`);
    check(tip === source, 'source branch moved; keep it for inspection');
    check(await this.git(project, 'rev-parse', `${source}^{tree}`) === await this.git(project, 'rev-parse', `${landed}^{tree}`),
      'squash tree differs from source; keep the source branch');
    check(await this.isAncestor(project, landed, `refs/heads/${task.target_branch}`),
      'the squash commit is no longer on the target branch');
    if (task.workspace) {
      await this.clean(task.workspace);
      check(await this.git(task.workspace, 'rev-parse', 'HEAD') === source, 'source worktree moved');
      await this.git(project, 'worktree', 'remove', task.workspace);
      this.store.update(task.id, { workspace: null });
      this.store.event(task.id, 'workspace.removed', { workspace: task.workspace });
    }
    check(!await this.checkedOut(task.branch), 'source branch is still checked out');
    await this.git(project, 'update-ref', '-d', `refs/heads/${task.branch}`, source);
    this.store.markBranchArchived(task.branch);
    this.store.update(task.id, { branch: null });
    this.store.event(task.id, 'task.archived', { branch: task.branch, source_commit: source, landed_commit: landed });
  },

  /**
   * 把一条分支快进到一个已经包含它当前顶端的提交（例如独立解分歧子任务的产物）。
   * 有检出的 worktree 就在里面 `git merge --ff-only`，否则 compare-and-swap ref；不产生 merge commit，
   * 也不接受非快进的移动。终态 order 吸收解分歧固定提交后重新发合并请求时用到。
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
    await verifyFastForward(this, branch, to, workspace);
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
    await verifyFastForward(this, state.child, state.parent_head, childWorkspace);
    return { ...state, caught_up: true, ahead: 0, behind: 0, from: state.child_head, to: state.parent_head,
      child_head: state.parent_head, new_head: state.parent_head, merged: false };
  },

  catchupBranch(child) { return this.exclusive(() => this.catchupBranchUnsafe(child)); },

  fastForwardBranch(branch, to) { return this.exclusive(() => this.fastForwardBranchUnsafe(branch, to)); },

  /** 迁移兼容：旧任务没有 input branch/direct-parent target，继续按旧目标分支语义落地。新任务不走这里。 */
  async legacyMergeUnsafe(task) {
    const project = this.config.project;
    await this.clean(project);
    await this.clean(task.workspace);
    check(await this.git(project, 'symbolic-ref', '--short', 'HEAD') === task.target_branch, `switch to ${task.target_branch} before merging`);
    check(await this.git(task.workspace, 'rev-parse', 'HEAD') === task.head_commit, 'worker branch changed after review');
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
      check(Array.isArray(tasks) && tasks.length > 0, 'merge preflight needs workers');
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
          check(await this.git(task.workspace, 'rev-parse', 'HEAD') === task.head_commit, `worker #${task.id} branch changed after review`);
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
        check(state.parent === task.target_branch, `worker #${task.id} no longer targets its direct parent`);
        check(task.head_commit && state.child_head && await this.isAncestor(project, task.head_commit, state.child_head),
          `worker #${task.id} branch no longer contains its reviewed commit`);
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
      check(task.status === 'completed' && ['pending','review','conflict'].includes(task.integration), 'only completed workers with pending/review/conflict changes can be merged');
      check(task.branch, `worker #${task.id} has no branch`);
      const record = this.store.branch(task.branch);
      if (!task.input_id || record?.parent !== task.target_branch) return this.legacyMergeUnsafe(task);
      const project = this.config.project;
      const state = await this.branchState(task.branch);
      check(state.parent === task.target_branch, `worker #${task.id} targets ${task.target_branch}, but its recorded parent is ${state.parent}`);
      // task.head_commit 是 agent 交付时审阅过的提交；分支之后可以聚合直接子分支，但不能把原成果丢掉。
      check(task.head_commit && state.child_head && await this.isAncestor(project, task.head_commit, state.child_head),
        `worker #${task.id} branch no longer contains its reviewed commit`);
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
        // ff-only/CAS does not create a content-conflict merge state. External checkout/ref
        // drift can still leave a different branch advanced: preserve that evidence, never reset.
        this.store.update(task.id, { integration: 'pending', integration_error: error.message });
        this.store.event(task.id, 'merge.failed', { error: error.message, files: [] });
        throw error;
      }
    });
  },
};
