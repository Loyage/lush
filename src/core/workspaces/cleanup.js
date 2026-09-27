import fs from 'node:fs';
import { check } from '../types.js';

/** 分支回收与安全清理。 */
export const methods = {
  /**
   * 任务分支是恢复点，只有能证明「这次工作已经是目标分支的一部分」时才删。
   * 不做 force：先要求分支顶端仍是审阅过的那次提交，再用 update-ref 的 compare-and-delete
   * 原子删除——检查之后分支被谁动过就拒绝，历史不会丢。
   */
  async dropBranch(task) {
    const branch = task.branch;
    if (!branch) return { branch: null, status: 'absent', reason: null };
    const project = this.config.project;
    let tip;
    try { tip = await this.git(project, 'rev-parse', `refs/heads/${branch}`); }
    catch { return { branch, status: 'absent', reason: null }; }
    const reviewed = task.head_commit || task.base_commit;
    if (!reviewed) return { branch, status: 'kept', reason: 'no reviewed commit is recorded for this task' };
    if (!(await this.isAncestor(project, reviewed, tip))) return { branch, status: 'kept', reason: task.head_commit
      ? `branch tip ${tip.slice(0, 12)} no longer contains the reviewed commit ${reviewed.slice(0, 12)}`
      : `branch no longer contains its recorded base ${reviewed.slice(0, 12)}` };
    if (!task.target_branch) return { branch, status: 'kept', reason: 'no target branch is recorded for this task' };
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
   * 两遍走：第一遍只读地收集 tip / worktree 并把所有会失败的事检查完（脏 worktree、主检出），
   * 第二遍才开始删。这样「子树里有脏 worktree」不会留下归档了一半的分支。
   */
  archiveBranches(branches, { discard_worktree = false, showcases = [] } = {}) {
    return this.exclusive(async () => {
      const project = this.config.project;
      const names = [...new Set(branches.map(branch => String(branch ?? '').trim()))];
      for (const branch of names) check(branch.length > 0 && branch.length <= 512, 'branch name must be non-empty text');
      const plan = [];
      for (const branch of names) {
        // 先把 tip 记下来：后面 update-ref -d 用它做 compare-and-delete，检查之后被谁动过就拒绝。
        let tip = null;
        try { tip = await this.git(project, 'rev-parse', `refs/heads/${branch}`); } catch { /* ref 本就不在 */ }
        const workspace = await this.workspaceForBranch(branch);
        const present = Boolean(workspace) && fs.existsSync(workspace);
        if (present) {
          // 主检出是用户现场，不是某条分支的临时工作区；即便调用方漏了「当前分支不可归档」也该在这里挡住。
          check(fs.realpathSync(workspace) !== fs.realpathSync(project), `refusing to archive the project checkout: ${workspace}`);
          if (!discard_worktree) {
            try { await this.clean(workspace); }
            catch (error) {
              // 归档允许连脏工作区一起丢，但必须是调用方明确要求；默认保持与 merge/cleanup 一样的「先提交」门槛。
              check(false, `${error.message}\narchive keeps ${workspace} unless its changes may be discarded: retry with discard_worktree=true`);
            }
          }
        }
        plan.push({ branch, tip, workspace, present, worktree: 'absent', ref: 'absent', discarded: false });
      }

      // 展示任务不拥有源分支，但会留下两个 detached worktree（展示提交与对照提交）。归档源分支时
      // 一并回收；先把所有目录的身份、固定提交与干净状态检查完，再停预览、开始任何删除。
      const detached = [];
      for (const task of showcases) {
        check(task.role === 'showcase' && ['completed','failed','cancelled'].includes(task.status),
          `showcase #${task.id} must be stopped before its branch can be archived`);
        const snapshot = JSON.parse(task.showcase);
        check(names.includes(snapshot.branch), `showcase #${task.id} does not belong to an archived branch`);
        for (const [field, commit] of [['workspace', snapshot.commit], ['baseline_workspace', snapshot.baseline_commit]]) {
          const dir = task[field];
          if (!dir) continue;
          const present = fs.existsSync(dir);
          if (present) await this.assertShowcaseCheckout(dir, commit, { allowDirty: discard_worktree });
          detached.push({ task_id: task.id, branch: snapshot.branch, field, commit, dir, present });
        }
      }
      for (const task of showcases) {
        if (!this.previewActive?.(task.id)) continue;
        check(typeof this.stopPreview === 'function', `showcase #${task.id} preview must be stopped before archive`);
        await this.stopPreview(task.id);
        check(!this.previewActive?.(task.id), `showcase #${task.id} preview is still stopping`);
      }
      for (const entry of detached) {
        let removed = false, discarded = false;
        if (entry.present && fs.existsSync(entry.dir)) {
          // A preview may have written files after the first preflight. Recheck after it has stopped.
          await this.assertShowcaseCheckout(entry.dir, entry.commit, { allowDirty: discard_worktree });
          if (discard_worktree) discarded = (await this.porcelain(entry.dir)) !== '';
          await this.git(project, 'worktree', 'remove', ...(discard_worktree ? ['--force'] : []), entry.dir);
          removed = true;
        }
        this.store.update(entry.task_id, { [entry.field]: null });
        this.store.event(entry.task_id, 'showcase.worktree_archived', {
          branch: entry.branch, workspace: entry.dir, kind: entry.field === 'workspace' ? 'showcase' : 'baseline', removed, discarded,
        });
      }

      const outcomes = [];
      for (const entry of plan) {
        if (entry.present) {
          if (discard_worktree) entry.discarded = (await this.porcelain(entry.workspace)) !== '';
          await this.git(project, 'worktree', 'remove', ...(discard_worktree ? ['--force'] : []), entry.workspace);
          entry.worktree = 'removed';
        }
        if (entry.tip !== null) {
          // 走到这里通常已经被上面的 remove 解除了检出；分支被别处检出时不能删，否则那个 HEAD 会失效。
          check(!(await this.checkedOut(entry.branch)), `branch ${entry.branch} is still checked out in a worktree`);
          await this.git(project, 'update-ref', '-d', `refs/heads/${entry.branch}`, entry.tip);
          entry.ref = 'deleted';
        }
        this.store.markBranchArchived(entry.branch);
        outcomes.push({ branch: entry.branch, worktree: entry.worktree, ref: entry.ref, tip: entry.tip, discarded: entry.discarded, reason: null });
      }
      return outcomes;
    });
  },

  /** 归档单条分支：`archiveBranches` 的退化情形（不带子树）。 */
  archiveBranch(branch, options = {}) {
    return this.archiveBranches([branch], options).then(outcomes => outcomes[0]);
  },
  /**
   * 回收一个已结束任务的磁盘状态：它自己的 worktree、检验对照检出与任务分支。
   * 任何一步不安全就抛错——cleanup 把它报给用户，clear 记下原因并保留那条任务。
   */
  async release(task, { keepBranch = false } = {}) {
    if (task.role === 'showcase') {
      check(!this.previewActive?.(task.id), 'stop the showcase preview before cleanup');
      const snapshot = JSON.parse(task.showcase);
      let removed = false;
      for (const [field, commit] of [['workspace', snapshot.commit], ['baseline_workspace', snapshot.baseline_commit]]) {
        const dir = task[field];
        if (!dir) continue;
        if (fs.existsSync(dir)) {
          await this.assertShowcaseCheckout(dir, commit);
          await this.git(this.config.project, 'worktree', 'remove', dir);
          removed = true;
        }
        this.store.update(task.id, { [field]: null });
      }
      return { id: task.id, worktree: removed ? 'removed' : 'absent', branch: 'absent', reason: null };
    }
    // 检验任务没有 branch/integration，只有派生出来的对照检出。
    if (task.verifies_task_id) {
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
    // merged/none：这条线已经收尾；superseded：这一轮解冲突被下一轮取代，分支留作恢复点，不强留工作区。
    check(['merged','none','superseded'].includes(task.integration), 'unmerged work must be kept');
    let worktree = 'absent';
    if (task.workspace) {
      const dir = task.workspace;
      await this.clean(dir);
      const head = await this.git(dir, 'rev-parse', 'HEAD');
      // Even failed/cancelled tasks may contain valuable committed changes. Branch-first tasks land in their
      // direct parent, which is often an input/task worktree rather than the project checkout's HEAD.
      if (head !== task.base_commit) {
        check(task.target_branch, 'task has committed work but no target branch');
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
        check(['completed','failed','cancelled'].includes(task.status), 'task must have stopped');
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
