import fs from 'node:fs';
import { check } from '../types.js';
import { workerLabel } from '../worker-number.js';

/** 分支回收与安全清理。 */
export const methods = {
  /**
   * 任务分支是恢复点，只有能证明「这次工作已经是目标分支的一部分」时才删。
   * 不做 force：先要求分支顶端仍是审阅过的那次提交，再用 update-ref 的 compare-and-delete
   * 原子删除——检查之后分支被谁动过就拒绝，历史不会丢。
   */
  async dropBranch(task) {
    check(task.role !== 'showcase' && task.task_kind !== 'showcase', 'legacy showcase workers are unsupported; preserve their worktrees for manual inspection');
    const branch = task.branch;
    if (!branch) return { branch: null, status: 'absent', reason: null };
    const project = this.config.project;
    let tip;
    try { tip = await this.git(project, 'rev-parse', `refs/heads/${branch}`); }
    catch { return { branch, status: 'absent', reason: null }; }
    const reviewed = task.head_commit || task.base_commit;
    if (!reviewed) return { branch, status: 'kept', reason: 'no reviewed commit is recorded for this worker' };
    if (!(await this.isAncestor(project, reviewed, tip))) return { branch, status: 'kept', reason: task.head_commit
      ? `branch tip ${tip.slice(0, 12)} no longer contains the reviewed commit ${reviewed.slice(0, 12)}`
      : `branch no longer contains its recorded base ${reviewed.slice(0, 12)}` };
    if (!task.target_branch) return { branch, status: 'kept', reason: 'no target branch is recorded for this worker' };
    if (!(await this.isAncestor(project, tip, `refs/heads/${task.target_branch}`)))
      return { branch, status: 'kept', reason: `${tip.slice(0, 12)} is not in ${task.target_branch} yet` };
    if (await this.checkedOut(branch)) return { branch, status: 'kept', reason: 'branch is checked out in a worktree' };
    await this.git(project, 'update-ref', '-d', `refs/heads/${branch}`, tip);
    // 谱系行留着（只标 deleted）：子分支的 parent 指针必须继续有效，C 当初从 B 创建这条事实不因为 B 没了而消失。
    this.store.markBranchDeleted(branch);
    return { branch, status: 'removed', reason: null };
  },

  /**
   * 归档一子树分支（含子树根）：删掉每一条的 worktree 与本地 ref，但把分支记录留在库里（标 archived）。
   * 与 dropBranch/dropAnchor 不同，它**明知可能未合并也允许删**——保留价值转到库里和 pi 会话文件上，
   * 所以这里是唯一一条「不做祖先检查」的删除路径，调用方（Project#archiveBranch）负责先证明
   * 「这棵子树的活都收尾了」。仍然不做 force：ref 用 compare-and-delete，只会删掉我们看过的那一个 tip。
   *
   * 两遍走：第一遍只读地收集 tip / worktree 并把所有会失败的事检查完（脏 worktree、主检出、locked /
   * prunable / 已初始化 submodule），第二遍才开始删。这样「子树里有脏 worktree」不会留下归档了一半的分支。
   *
   * G-04：第二遍里仍可能撞上未知失败（I/O、外部程序）。这时不能丢掉已经删掉的部分——每条分支一
   * settle 就通过 `onOutcome` 逐条回报（reason 为 null 表示完整归档），并停下来把没处理的分支列进
   * `remaining`。调用方（`Project#archiveBranch`）据此让库与磁盘一致，而不是抛错后留下「库说还在、
   * 磁盘已经没了」的半棵树。
   */
  archiveBranches(branches, { discard_worktree = false, onOutcome = null, guard = null, expectedTips = null } = {}) {
    return this.exclusive(async () => {
      if (guard) guard();
      const project = this.config.project;
      const names = [...new Set(branches.map(branch => String(branch ?? '').trim()))];
      for (const branch of names) check(branch.length > 0 && branch.length <= 512, 'branch name must be non-empty text');
      // Historical detached worktrees are recovery points, never ordinary branch checkouts.
      // Inspect stored metadata only; malformed snapshots with retained directories fail closed.
      const retainedPaths = new Set();
      for (const task of this.store.all("SELECT id,branch,showcase,workspace,baseline_workspace FROM tasks WHERE role='showcase' OR task_kind='showcase'")) {
        const retained = [task.workspace, task.baseline_workspace].filter(dir => dir && fs.existsSync(dir));
        if (!retained.length) continue;
        for (const dir of retained) retainedPaths.add(fs.realpathSync(dir));
        let snapshot;
        try { snapshot = JSON.parse(task.showcase); } catch { /* unknown ownership: preserve */ }
        check(snapshot?.branch && !names.includes(snapshot.branch) && !names.includes(task.branch),
          `legacy showcase ${workerLabel(task)} retains worktrees; preserve and inspect them manually before archive`);
      }
      // NUL records preserve paths/reasons containing whitespace, quotes or newlines.
      // Known Git refusal conditions must reject the entire subtree before any removal,
      // even when discard_worktree allows dirt (it never authorizes bypassing locks).
      const records = (await this.gitOutput(project, 'worktree', 'list', '--porcelain', '-z'))
        .split('\0\0').map(record => record.split('\0'));
      const plan = [];
      for (const branch of names) {
        // 先把 tip 记下来：后面 update-ref -d 用它做 compare-and-delete，检查之后被谁动过就拒绝。
        let tip = null;
        try { tip = await this.git(project, 'rev-parse', `refs/heads/${branch}`); } catch { /* ref 本就不在 */ }
        if (expectedTips) check(tip === expectedTips.get(branch), `automatic archive source moved after acceptance: ${branch}`);
        const metadata = records.find(fields => fields.includes(`branch refs/heads/${branch}`));
        const workspace = metadata?.find(field => field.startsWith('worktree '))?.slice('worktree '.length) ?? null;
        check(!metadata?.some(field => field === 'locked' || field.startsWith('locked ')), `worktree is locked: ${workspace}`);
        check(!metadata?.some(field => field === 'prunable' || field.startsWith('prunable ')), `worktree is prunable; inspect registration before archive: ${workspace}`);
        const present = Boolean(workspace) && fs.existsSync(workspace);
        if (present) {
          check(!retainedPaths.has(fs.realpathSync(workspace)), 'legacy showcase worktrees cannot be archived as ordinary branch checkouts');
          // 主检出是用户现场，不是某条分支的临时工作区；即便调用方漏了「当前分支不可归档」也该在这里挡住。
          check(fs.realpathSync(workspace) !== fs.realpathSync(project), `refusing to archive the project checkout: ${workspace}`);
          const index = await this.gitOutput(workspace, 'ls-files', '--stage');
          if (/^160000 /m.test(index)) {
            const submodules = await this.gitOutput(workspace, 'submodule', 'status');
            check(submodules.split('\n').filter(Boolean).every(line => line.startsWith('-')),
              `worktree contains initialized submodules; inspect before archive: ${workspace}`);
          }
          if (!discard_worktree) {
            try { await this.clean(workspace); }
            catch (error) {
              // 归档允许连脏工作区一起丢，但必须是调用方明确要求；默认保持与 merge/cleanup 一样的「先提交」门槛。
              check(false, `${error.message}\narchive keeps ${workspace} unless its changes may be discarded: retry with discard_worktree=true`);
            }
          }
        }
        plan.push({ branch, tip, workspace, present, worktree: 'absent', ref: tip === null ? 'absent' : 'kept', discarded: false });
      }

      if (guard) guard();
      const outcomes = [];
      const failed = [];
      const remaining = [];
      for (let index = 0; index < plan.length; index += 1) {
        const entry = plan[index];
        try {
          if (expectedTips) check(await this.git(project, 'rev-parse', `refs/heads/${entry.branch}`) === entry.tip,
            `automatic archive source moved during inspection: ${entry.branch}`);
          if (guard) guard();
          if (entry.present) {
            if (discard_worktree) entry.discarded = (await this.porcelain(entry.workspace)) !== '';
            await this.git(project, 'worktree', 'remove', ...(discard_worktree ? ['--force'] : []), entry.workspace);
            entry.worktree = 'removed';
          }
          if (entry.tip !== null) {
            // 走到这里通常已经被上面的 remove 解除了检出；分支被别处检出时不能删，否则那个 HEAD 会失效。
            check(!(await this.checkedOut(entry.branch)), `branch ${entry.branch} is still checked out in a worktree`);
            if (guard) guard();
            await this.git(project, 'update-ref', '-d', `refs/heads/${entry.branch}`, entry.tip);
            entry.ref = 'deleted';
          }
          this.store.markBranchArchived(entry.branch);
          const outcome = { branch: entry.branch, worktree: entry.worktree, ref: entry.ref, tip: entry.tip, discarded: entry.discarded, reason: null };
          if (onOutcome) await onOutcome(outcome);
          outcomes.push(outcome);
        } catch (error) {
          // 未知失败：保留已经 settle 的逐条事实，停止继续删，其余分支如实列为未处理。
          const outcome = { branch: entry.branch, worktree: entry.worktree, ref: entry.ref, tip: entry.tip, discarded: entry.discarded, reason: error.message };
          if (onOutcome) await onOutcome(outcome);
          failed.push(outcome);
          remaining.push(...plan.slice(index + 1).map(row => ({ branch: row.branch, worktree: row.worktree, ref: row.ref, tip: row.tip, discarded: row.discarded })));
          break;
        }
      }
      return { outcomes, failed, remaining };
    });
  },

  /** 归档单条分支：`archiveBranches` 的退化情形（不带子树）。失败时按单条语义抛出原因。 */
  async archiveBranch(branch, options = {}) {
    const { outcomes, failed } = await this.archiveBranches([branch], options);
    if (failed.length) throw new Error(failed[0].reason);
    return outcomes[0];
  },
  /**
   * 回收一个已结束任务的磁盘状态：它自己的 worktree、检验对照检出与任务分支。
   * 任何一步不安全就抛错——cleanup 把它报给用户，clear 记下原因并保留那条任务。
   */
  async release(task, { keepBranch = false } = {}) {
    check(task.role !== 'showcase' && task.task_kind !== 'showcase', 'legacy showcase workers are unsupported; preserve their worktrees for manual inspection');
    // 检验任务没有 branch/integration，只有派生出来的对照检出。
    if (task.verifies_task_id || task.review_candidate_id) {
      if (!task.baseline_workspace) return { id: task.id, worktree: 'absent', branch: 'absent', reason: null };
      const dir = task.baseline_workspace;
      await this.git(this.config.project, 'worktree', 'remove', '--force', dir);
      this.store.update(task.id, { baseline_workspace: null });
      this.store.event(task.id, 'baseline.removed', { workspace: dir });
      return { id: task.id, worktree: 'removed', branch: 'absent', reason: null };
    }
    // 只读分析 Task：没有分支、没有可交付改动，只有调用期的分离检出（通常在 invocation 结束时就已回收）。
    if (task.task_kind === 'analysis') {
      if (task.baseline_workspace && fs.existsSync(task.baseline_workspace)) {
        const dir = task.baseline_workspace;
        await this.git(this.config.project, 'worktree', 'remove', '--force', dir);
        this.store.update(task.id, { baseline_workspace: null });
        this.store.event(task.id, 'baseline.removed', { workspace: dir });
      }
      return { id: task.id, worktree: 'absent', branch: 'absent', reason: null };
    }
    // A squash deliberately does not make the source commit an ancestor of the parent.
    // Verify the exact landed tree and ref instead of applying the old ancestry cleanup rule.
    const booking = task.reservation ? JSON.parse(task.reservation) : null;
    const receiptRow = this.store.get("SELECT data FROM events WHERE task_id=? AND type='task.merge_integrated' ORDER BY id DESC LIMIT 1", task.id);
    const receipt = receiptRow ? JSON.parse(receiptRow.data) : null;
    const deliveredSource = receipt?.source_commit ?? (booking?.version === 2 && booking.status === 'integrated' ? booking.commit : null);
    const deliveredCommit = receipt?.commit ?? booking?.landed_commit;
    const exactReceipt = deliveredSource && task.head_commit === deliveredSource;
    const source = exactReceipt ? deliveredSource : task.integration === 'merged' && task.iteration_base_commit ? task.head_commit : null;
    const landed = exactReceipt ? deliveredCommit : task.iteration_base_commit;
    // New input consumes the previous reservation; immutable receipts retain the Squash proof.
    // A later sync can have a new merge HEAD but the same tree as its fixed parent baseline.
    // archiveSquashedTaskUnsafe verifies both trees, exact ref, target ancestry and cleanliness.
    if (source && landed && task.branch) {
      if (keepBranch) return { id: task.id, worktree: 'kept', branch: 'kept', reason: 'kept by --keep-branch' };
      // 源分支可能已被用户显式归档：archiveBranch 有意保留 tasks.branch 当历史指针，但 ref 与 worktree
      // 早就从磁盘上删掉了。这时没有东西可回收，只把悬空指针同步成「库反映磁盘」；继续走 squash 核对
      // 会去 rev-parse 一个不存在的 ref 而失败，把 cleanup / deleteTask 整条路径卡死。
      const record = this.store.branch(task.branch);
      if (['archived', 'deleted'].includes(record?.status)) {
        let worktree = 'absent';
        if (task.workspace) {
          const dir = task.workspace;
          await this.clean(dir);
          await this.git(this.config.project, 'worktree', 'remove', dir);
          this.store.update(task.id, { workspace: null });
          this.store.event(task.id, 'workspace.removed', { branch: task.branch, workspace: dir });
          worktree = 'removed';
        }
        this.store.update(task.id, { branch: null });
        this.store.event(task.id, 'branch.removed', { branch: task.branch, already_archived: true });
        return { id: task.id, worktree, branch: 'removed', reason: null };
      }
      await this.archiveSquashedTaskUnsafe(task, source, landed);
      return { id: task.id, worktree: 'removed', branch: 'removed', reason: null };
    }
    // merged/none：这条线已经收尾；superseded：这一轮解冲突被下一轮取代，分支留作恢复点，不强留工作区。
    check(['merged','none','superseded'].includes(task.integration), 'unmerged work must be kept');
    let worktree = 'absent';
    if (task.workspace) {
      const dir = task.workspace;
      await this.clean(dir);
      const head = await this.git(dir, 'rev-parse', 'HEAD');
      // Even failed/cancelled tasks may contain valuable committed changes. Branch-first tasks land in their
      // direct parent, which is often an input/task worktree rather than the project checkout's HEAD.
      if (head !== (task.iteration_base_commit ?? task.base_commit)) {
        check(task.target_branch, 'worker has committed work but no target branch');
        await this.git(this.config.project, 'merge-base', '--is-ancestor', head, `refs/heads/${task.target_branch}`);
      }
      await this.git(this.config.project, 'worktree', 'remove', dir);
      worktree = 'removed';
      this.store.update(task.id, { workspace: null });
      this.store.event(task.id, 'workspace.removed', { branch: task.branch, workspace: dir });
    }
    const branch = keepBranch
      ? { branch: task.branch, status: task.branch ? 'kept' : 'absent', reason: task.branch ? 'kept by --keep-branch' : null }
      : await this.dropBranch(task);
    if (branch.status === 'removed') {
      // 库反映磁盘：分支不在了就不该再指着一个不存在的 ref。
      this.store.update(task.id, { branch: null });
      this.store.event(task.id, 'branch.removed', { branch: branch.branch });
    }
    return { id: task.id, worktree, branch: branch.status, reason: branch.reason };
  },
  /** 用户明确回收：worktree（与对照检出）加任务分支，一次做完。 */
  cleanup(taskId, { keepBranch = false } = {}) {
    return this.exclusive(async () => {
      this.busy.add(taskId);
      try {
        const task = this.store.task(taskId);
        check(['completed','failed','cancelled'].includes(task.status), 'worker must have stopped; accept delivered work before cleanup');
        const active = this.store.get(`WITH RECURSIVE descendants(id,worker_number,status) AS (
          SELECT id,worker_number,status FROM tasks WHERE parent_id=?
          UNION ALL SELECT t.id,t.worker_number,t.status FROM tasks t JOIN descendants d ON t.parent_id=d.id
        ) SELECT id,worker_number FROM descendants WHERE status NOT IN ('completed','failed','cancelled') LIMIT 1`, task.id);
        check(!active, `descendant Worker ${workerLabel(active)} must be accepted or ended before cleanup`);
        return { ...this.store.task(task.id), cleanup: await this.release(task, { keepBranch }) };
      } finally { this.busy.delete(taskId); }
    });
  },
  /** clear 用：逐个回收，一个任务被安全门挡住不影响其余的；返回每条任务的去向与原因。 */
  reclaim(tasks) {
    return this.exclusive(async () => {
      const outcomes = [];
      for (const snapshot of tasks) {
        this.busy.add(snapshot.id);
        try { outcomes.push(await this.release(this.store.task(snapshot.id))); }
        catch (error) { outcomes.push({ id: snapshot.id, worktree: 'kept', branch: snapshot.branch ? 'kept' : 'absent', reason: error.message }); }
        finally { this.busy.delete(snapshot.id); }
      }
      return outcomes;
    });
  },
};
