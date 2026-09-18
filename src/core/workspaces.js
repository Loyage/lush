import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { check, LushError } from './types.js';
import { taskLabel } from './naming.js';

/** All Lush git mutations are serialized. No shell interpolation, no forced cleanup. */
export class Workspaces {
  constructor(config, store) {
    this.config = config; this.store = store; this.queue = Promise.resolve(); this.busy = new Set();
    this.namespace = createHash('sha256').update(config.project).digest('hex').slice(0, 10);
  }
  exclusive(fn) {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  async git(cwd, ...args) {
    const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...this.config.env, GIT_TERMINAL_PROMPT: '0' } });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new LushError(`git ${args[0]}: ${err.trim() || out.trim()}`);
    return out.trim();
  }
  async clean(cwd) {
    const status = await this.git(cwd, 'status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).lush');
    check(!status, `working tree is dirty: ${cwd}; commit or stash changes first`);
  }
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
  }
  async isAncestor(cwd, commit, ref) {
    try { await this.git(cwd, 'merge-base', '--is-ancestor', commit, ref); return true; } catch { return false; }
  }
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
    if (task.role !== 'worker') return this.config.project;
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
      await this.clean(project);
      // A code dependency stacks this task on the upstream branch, so the agent sees work that is not merged yet.
      // base_commit is frozen once: a retry must build the same tree as the review did.
      const stacked = task.base_commit ? null : this.codeBase(task);
      const base = task.base_commit || stacked?.head_commit || await this.git(project, 'rev-parse', 'HEAD');
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
      // 从冻结的 head_commit 拉起，而不是从上游分支名：分支可能已经被回收，
      // 而下游要看的本来就是审阅过的那次提交。
      await this.git(project, 'worktree', 'add', ...(reuse ? [workspace, branch] : ['-b', branch, workspace, stacked ? stacked.head_commit : base]));
      this.store.event(task.id, 'workspace.created', { workspace, branch, base, stacked_on: stacked ? stacked.id : null });
      return workspace;
    });
  }
  async finish(task) {
    if (!task.workspace) return;
    await this.clean(task.workspace);
    const branch = await this.git(task.workspace, 'symbolic-ref', '--short', 'HEAD');
    check(branch === task.branch, 'agent changed the task branch; restore it before retrying');
    const head = await this.git(task.workspace, 'rev-parse', 'HEAD');
    this.store.update(task.id, { head_commit: head, integration: head === task.base_commit ? 'none' : 'pending' });
  }
  /** Read-only overview for review: never mutates, so it stays outside the mutation queue. */
  async diff(task) {
    const workspace = task.workspace;
    if (!workspace || !fs.existsSync(workspace)) return null;
    const lines = value => value.split('\n').filter(Boolean);
    const range = task.base_commit && task.head_commit ? `${task.base_commit}..${task.head_commit}` : null;
    const [status, numstat, commits, pendingNumstat] = await Promise.all([
      this.git(workspace, 'status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).lush'),
      range ? this.git(workspace, 'diff', '--numstat', range) : '',
      range ? this.git(workspace, 'log', '--oneline', '--no-decorate', range) : '',
      this.git(workspace, 'diff', '--numstat', 'HEAD'),
    ]);
    const parse = value => value.split('\n').filter(Boolean).map(line => {
      const [added, deleted, ...rest] = line.split('\t');
      return { path: rest.join('\t') || '(unknown)', added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) };
    });
    const files = parse(numstat);
    const numbers = new Map(parse(pendingNumstat).map(file => [file.path, file]));
    const pending = lines(status).map(line => {
      const match = /^(\S{1,2})\s+(.*)$/.exec(line);
      if (!match) return null;
      const path = match[2].includes(' -> ') ? match[2].split(' -> ').pop() : match[2];
      const counted = numbers.get(path) || { added: null, deleted: null };
      return { path, code: match[1].trim(), added: counted.added, deleted: counted.deleted };
    }).filter(Boolean);
    return {
      branch: task.branch, target_branch: task.target_branch,
      base_commit: task.base_commit, head_commit: task.head_commit, committed: Boolean(range),
      files: files.slice(0, 500), files_total: files.length,
      pending: pending.slice(0, 500), pending_total: pending.length,
      commits: lines(commits).slice(0, 100),
    };
  }
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
  }
  merge(taskId) {
    return this.exclusive(async () => {
      const task = this.store.task(taskId);
      check(task.status === 'completed' && ['pending','review'].includes(task.integration), 'only completed tasks with pending/review changes can be merged');
      const project = this.config.project;
      await this.clean(project);
      await this.clean(task.workspace);
      check(await this.git(project, 'symbolic-ref', '--short', 'HEAD') === task.target_branch, `switch to ${task.target_branch} before merging`);
      check(await this.git(task.workspace, 'rev-parse', 'HEAD') === task.head_commit, 'task branch changed after review');
      // A stacked branch carries its upstream's commits. Merging a downstream task first would drag
      // unmerged work into the target branch, so the upstream has to be an ancestor of the target already.
      for (const edge of this.store.deps(task.id).filter(edge => edge.kind === 'code')) {
        const upstream = this.store.task(edge.depends_on);
        check(upstream.head_commit, `code dependency #${upstream.id} has no commit; inspect it before merging`);
        check(await this.isAncestor(project, upstream.head_commit, 'HEAD'),
          `code dependency #${upstream.id} is not merged into ${task.target_branch} yet; merge #${upstream.id} first so this branch does not carry it along`);
      }
      // Persist approval before touching the main tree. On crash, never replay a merge.
      this.store.update(task.id, { integration: 'merging', integration_error: null });
      this.store.event(task.id, 'merge.approved', { commit: task.head_commit });
      try {
        await this.git(project, 'merge', '--no-ff', '--no-edit', task.head_commit);
        this.store.update(task.id, { integration: 'merged' });
        this.store.event(task.id, 'merged', { commit: task.head_commit });
      } catch (error) {
        let abortError = null;
        try { await this.git(project, 'merge', '--abort'); } catch (err) { abortError = err.message; }
        this.store.update(task.id, { integration: 'pending', integration_error: `${error.message}${abortError ? `\nCheck repository state: ${abortError}` : ''}` });
        this.store.event(task.id, 'merge.failed', { error: error.message });
        throw error;
      }
      return this.store.task(task.id);
    });
  }
  /** 分支是否正被某个 worktree 检出：删掉它会让那个检出的 HEAD 失效，所以先问清楚。 */
  async checkedOut(branch) {
    const list = await this.git(this.config.project, 'worktree', 'list', '--porcelain');
    return list.split('\n').some(line => line === `branch refs/heads/${branch}`);
  }
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
    if (tip !== reviewed) return { branch, status: 'kept', reason: task.head_commit
      ? `branch tip ${tip.slice(0, 12)} is not the reviewed commit ${reviewed.slice(0, 12)}`
      : `branch carries commits the task never recorded (tip ${tip.slice(0, 12)}, base ${reviewed.slice(0, 12)})` };
    if (!task.target_branch) return { branch, status: 'kept', reason: 'no target branch is recorded for this task' };
    if (!(await this.isAncestor(project, tip, `refs/heads/${task.target_branch}`)))
      return { branch, status: 'kept', reason: `${tip.slice(0, 12)} is not in ${task.target_branch} yet` };
    if (await this.checkedOut(branch)) return { branch, status: 'kept', reason: 'branch is checked out in a worktree' };
    await this.git(project, 'update-ref', '-d', `refs/heads/${branch}`, tip);
    return { branch, status: 'removed', reason: null };
  }
  /**
   * 回收一个已结束任务的磁盘状态：它自己的 worktree、检验对照检出与任务分支。
   * 任何一步不安全就抛错——cleanup 把它报给用户，clear 记下原因并保留那条任务。
   */
  async release(task, { keepBranch = false } = {}) {
    // 检验任务没有 branch/integration，只有派生出来的对照检出。
    if (task.verifies_task_id) {
      if (!task.baseline_workspace) return { id: task.id, worktree: 'absent', branch: 'absent', reason: null };
      const dir = task.baseline_workspace;
      await this.git(this.config.project, 'worktree', 'remove', '--force', dir);
      this.store.update(task.id, { baseline_workspace: null });
      this.store.event(task.id, 'baseline.removed', { workspace: dir });
      return { id: task.id, worktree: 'removed', branch: 'absent', reason: null };
    }
    check(task.integration === 'merged' || task.integration === 'none', 'unmerged work must be kept');
    let worktree = 'absent';
    if (task.workspace) {
      const dir = task.workspace;
      await this.clean(dir);
      const head = await this.git(dir, 'rev-parse', 'HEAD');
      // Even failed/cancelled tasks may contain valuable committed changes.
      if (head !== task.base_commit) await this.git(this.config.project, 'merge-base', '--is-ancestor', head, 'HEAD');
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
  }
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
  }
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
  }
}
