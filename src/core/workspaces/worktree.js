import path from 'node:path';
import fs from 'node:fs';
import { check } from '../types.js';
import { taskLabel } from '../naming.js';
import { dirtDetail } from './git.js';

/** worktree / 对照检出的创建与回收。 */
export const methods = {
  async ensure(task) {
    // verifier 不修改代码：它站在被检验的 worktree 里演示，另拉一个目标分支的只读对照。
    if (task.role === 'verifier') return this.exclusive(async () => {
      task = this.store.task(task.id);
      const target = this.store.task(task.verifies_task_id);
      check(target.workspace && fs.existsSync(target.workspace), `verified task #${target.id} has no worktree to compare`);
      if (task.baseline_workspace && fs.existsSync(task.baseline_workspace)) return target.workspace;
      const project = this.config.project;
      // 对照取目标分支「当前」的顶端：合并时校验的也是同一个分支，所以对比的是它现在会得到什么。
      const commit = await this.git(project, 'rev-parse', target.target_branch);
      const dir = path.join(this.config.home, 'worktrees', `${taskLabel(task.id, task.name)}-base`);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      // 先落库再动 git：崩溃后重试看得到自己曾经指向哪个目录。
      this.store.update(task.id, { baseline_workspace: dir, baseline_commit: commit });
      await this.git(project, 'worktree', 'add', '--detach', dir, commit);
      this.store.event(task.id, 'baseline.created', { workspace: dir, commit, target_branch: target.target_branch });
      return target.workspace;
    });
    if (task.role !== 'worker' && task.role !== 'merger') return this.config.project;
    return this.exclusive(async () => {
      task = this.store.task(task.id);
      if (task.workspace && fs.existsSync(task.workspace)) {
        const root = fs.realpathSync(await this.git(task.workspace, 'rev-parse', '--show-toplevel'));
        check(root === task.workspace, 'task workspace is not a git worktree root');
        check(await this.git(task.workspace, 'symbolic-ref', '--short', 'HEAD') === task.branch, 'task worktree branch changed; restore it before retrying');
        return task.workspace;
      }
      const project = this.config.project;
      const root = fs.realpathSync(await this.git(project, 'rev-parse', '--show-toplevel'));
      check(root === project, 'coding tasks require the project to be a git worktree root');
      // 主工作树脏不再是硬门槛：`git worktree add` 只读已提交的 HEAD、不碰用户现场，所以 Lush
      // 不必为了开工去提交、暂存或藏起已有改动。代价是 worker 看不到未提交改动，这份分歧必须
      // 留痕（dirty_source），否则 review 无从知道 base 与用户当时的现场不同。
      const source = await this.porcelain(project);
      // A code dependency stacks this task on the upstream branch, so the agent sees work that is not merged yet.
      // base_commit is frozen once: a retry must build the same tree as the review did.
      // 解冲突任务的基线取目标分支的顶端（不是 HEAD：用户可能已经切到别的分支）：
      // 它的产物必须是「目标分支 + 那次已审阅的提交」的合并提交，批准时才能 --ff-only 原样落地。
      const stacked = task.base_commit ? null : this.codeBase(task);
      const base = task.base_commit || (task.resolves_task_id
        ? await this.git(project, 'rev-parse', `refs/heads/${task.target_branch}`)
        : stacked?.head_commit || await this.git(project, 'rev-parse', 'HEAD'));
      const target = task.target_branch || await this.git(project, 'symbolic-ref', '--short', 'HEAD');
      const branch = task.branch || `lush/${this.namespace}/${taskLabel(task.id, task.name)}`;
      let reuse = false;
      if (!task.branch) check(!(await this.git(project, 'branch', '--list', branch)), 'task branch already exists; preserve or rename the old branch before retrying');
      if (task.branch) {
        try { await this.git(project, 'show-ref', '--verify', `refs/heads/${branch}`); reuse = true; }
        catch { /* a crash may have happened before the initial branch was created */ }
      }
      const workspace = path.join(this.config.home, 'worktrees', taskLabel(task.id, task.name));
      fs.mkdirSync(path.dirname(workspace), { recursive: true });
      // Save the intended identity before git; a crash never makes the directory invisible.
      this.store.update(task.id, { workspace, branch, base_commit: base, target_branch: target });
      // 谱系就在分支创建这一刻显式写下：parent 是这次真正分叉出来的那条分支——
      // code 依赖时是上游任务的分支（stacked），否则是当前检出（解冲突任务是目标分支）；
      // created_from_commit 就是拉起 worktree 用的那个 commit，所以 parent 后来往前走也查得到当时的起点。
      // 与上面一样先落库再动 git，且已有记录绝不改写：merge / 重建都不能重写创建时的血缘。
      this.store.recordBranch({
        branch,
        parent: stacked ? stacked.branch : target,
        created_from_commit: stacked ? stacked.head_commit : base,
        task_id: task.id, worktree: workspace,
      });
      // 从冻结的 head_commit 拉起，而不是从上游分支名：分支可能已经被回收，
      // 而下游要看的本来就是审阅过的那次提交。
      await this.git(project, 'worktree', 'add', ...(reuse ? [workspace, branch] : ['-b', branch, workspace, stacked ? stacked.head_commit : base]));
      const dirt = dirtDetail(source);
      this.store.event(task.id, 'workspace.created', { workspace, branch, base, stacked_on: stacked ? stacked.id : null,
        dirty_source: dirt.files ? dirt : null });
      return workspace;
    });
  },
  async finish(task) {
    if (!task.workspace) return;
    await this.clean(task.workspace);
    const branch = await this.git(task.workspace, 'symbolic-ref', '--short', 'HEAD');
    check(branch === task.branch, 'agent changed the task branch; restore it before retrying');
    const head = await this.git(task.workspace, 'rev-parse', 'HEAD');
    this.store.update(task.id, { head_commit: head, integration: head === task.base_commit ? 'none' : 'pending' });
  },
  /** The single code dependency a worker may stack on; it has to be a finished worker with a branch. */
  codeBase(task) {
    const edges = this.store.deps(task.id).filter(edge => edge.kind === 'code');
    check(edges.length <= 1, 'a task cannot stack on more than one code dependency');
    if (!edges.length) return null;
    const upstream = this.store.task(edges[0].depends_on);
    check(upstream.role === 'worker', `code dependency #${upstream.id} is a ${upstream.role} task; it has no branch to stack on`);
    check(upstream.status === 'completed', `code dependency #${upstream.id} is ${upstream.status}; only a completed upstream can be a worktree base`);
    check(upstream.head_commit, `code dependency #${upstream.id} produced no commit yet`);
    return upstream;
  },
  /** 对照基线是派生检出，没有用户工作：检验结算后回收，不占用磁盘。 */
  removeBaseline(taskId) {
    return this.exclusive(async () => {
      const task = this.store.task(taskId);
      if (!task.baseline_workspace) return task;
      const dir = task.baseline_workspace;
      try { await this.git(this.config.project, 'worktree', 'remove', '--force', dir); }
      catch (error) {
        // 回收失败时保留指针，用户可以再次 cleanup；不隐藏仍然占着磁盘的目录。
        console.error(`verification ${taskId}: baseline cleanup failed: ${error.message}`);
        return this.store.task(task.id);
      }
      this.store.update(task.id, { baseline_workspace: null });
      this.store.event(task.id, 'baseline.removed', { workspace: dir });
      return this.store.task(task.id);
    });
  },
};
