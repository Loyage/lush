import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { check, LushError } from './types.js';
import { taskLabel } from './naming.js';

/** porcelain 明细可能很长（含未跟踪文件）：报错和事件里都要有界，但不能省掉「哪些文件」。 */
function dirtDetail(status, limit = 20) {
  const lines = status.split('\n').filter(Boolean);
  return { files: lines.length, sample: lines.slice(0, limit), more: Math.max(0, lines.length - limit) };
}

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
    return (await this.gitOutput(cwd, ...args)).trim();
  }
  /** 需要保留行内空白时用它：porcelain 的首行状态位就是一个前导空格（" M path"）。 */
  async gitOutput(cwd, ...args) {
    const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...this.config.env, GIT_TERMINAL_PROMPT: '0' } });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new LushError(`git ${args[0]}: ${err.trim() || out.trim()}`);
    return out;
  }
  /** porcelain 明细（含未跟踪文件，排除 .lush）；空字符串表示干净。 */
  async porcelain(cwd) {
    const out = await this.gitOutput(cwd, 'status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).lush');
    return out.replace(/\n+$/, '');
  }
  /** 硬门槛：worker 自己的 worktree（必须提交）与 merge 时的主树。错误必须点出是哪些文件。 */
  async clean(cwd) {
    const status = await this.porcelain(cwd);
    const { sample, more } = dirtDetail(status);
    check(!status, `working tree is dirty: ${cwd}; commit or stash changes first\n${sample.join('\n')}${more ? `\n… ${more} more` : ''}`);
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
  /** main 上是否正卡着一次合并：只有这时才需要（也才能）abort。快进失败不会留下中间态。 */
  async merging(cwd) {
    try { await this.git(cwd, 'rev-parse', '--quiet', '--verify', 'MERGE_HEAD'); return true; } catch { return false; }
  }
  /** 未解决冲突的文件路径；空数组表示不是内容冲突，而是别的 git 失败。 */
  async unmerged(cwd) {
    const out = await this.gitOutput(cwd, 'diff', '--name-only', '--diff-filter=U');
    return out.split('\n').map(line => line.trim()).filter(Boolean);
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
      // 从冻结的 head_commit 拉起，而不是从上游分支名：分支可能已经被回收，
      // 而下游要看的本来就是审阅过的那次提交。
      await this.git(project, 'worktree', 'add', ...(reuse ? [workspace, branch] : ['-b', branch, workspace, stacked ? stacked.head_commit : base]));
      const dirt = dirtDetail(source);
      this.store.event(task.id, 'workspace.created', { workspace, branch, base, stacked_on: stacked ? stacked.id : null,
        dirty_source: dirt.files ? dirt : null });
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
    // 主树允许有未提交改动，spawn 之后目标分支还可能继续前进：base 落后多少提交必须看得见，
    // 否则「相对 base」的审阅会被误读成相对当前代码。stacked 任务的 base 是上游分支，
    // 所以这个数同时含上游尚未合并的差异，合并顺序的约束见 merge。
    const behind = range
      ? this.git(this.config.project, 'rev-list', '--count', `${task.base_commit}..${task.target_branch}`).catch(() => '')
      : '';
    const [status, numstat, commits, pendingNumstat, baseBehind] = await Promise.all([
      this.git(workspace, 'status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).lush'),
      range ? this.git(workspace, 'diff', '--numstat', range) : '',
      range ? this.git(workspace, 'log', '--oneline', '--no-decorate', range) : '',
      this.git(workspace, 'diff', '--numstat', 'HEAD'),
      behind,
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
      base_behind: baseBehind === '' ? null : Number(baseBehind),
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
      // conflict 也在允许之列：那是「合并冲突过、现在重试」——冲突中不解决就永远走不出去。
      check(task.status === 'completed' && ['pending','review','conflict'].includes(task.integration), 'only completed tasks with pending/review/conflict changes can be merged');
      const project = this.config.project;
      await this.clean(project);
      await this.clean(task.workspace);
      check(await this.git(project, 'symbolic-ref', '--short', 'HEAD') === task.target_branch, `switch to ${task.target_branch} before merging`);
      check(await this.git(task.workspace, 'rev-parse', 'HEAD') === task.head_commit, 'task branch changed after review');
      // 解冲突任务不是普通分支：它必须真的含被并进来的那次审阅过的提交（防止「解冲突」把对方改动整个丢掉），
      // 而且只能用 --ff-only 落地——成功即证明 main 没被推走，落地的树就是 agent 测过的那棵树。
      const resolved = task.resolves_task_id ? this.store.task(task.resolves_task_id) : null;
      if (resolved) {
        check(resolved.head_commit, `#${task.id} resolves #${resolved.id}, which has no reviewed commit`);
        check(await this.isAncestor(project, resolved.head_commit, task.head_commit),
          `resolution #${task.id} does not contain the reviewed commit of #${resolved.id}; land a branch that keeps that work`);
      }
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
      this.store.event(task.id, 'merge.approved', { commit: task.head_commit, fast_forward: Boolean(resolved) });
      try {
        if (resolved) await this.git(project, 'merge', '--ff-only', task.head_commit);
        else await this.git(project, 'merge', '--no-ff', '--no-edit', task.head_commit);
        this.store.update(task.id, { integration: 'merged' });
        this.store.event(task.id, 'merged', { commit: task.head_commit });
      } catch (error) {
        // 先取冲突明细，再决定这是「内容冲突」还是「硬失败」，最后一定把主树恢复原状。
        const files = await this.unmerged(project).catch(() => []);
        let abortError = null;
        if (await this.merging(project)) {
          try { await this.git(project, 'merge', '--abort'); } catch (err) { abortError = err.message; }
        }
        const detail = `${error.message}${abortError ? `\nCheck repository state: ${abortError}` : ''}`;
        this.store.update(task.id, { integration: 'pending', integration_error: detail });
        this.store.event(task.id, 'merge.failed', { error: error.message, files });
        // abort 没成功表示主树还卡在合并里：不能把这种现场交给解冲突 agent。
        if (abortError) throw new LushError(detail);
        if (files.length) return { task: this.store.task(task.id), conflict: { files, output: error.message } };
        throw error;
      }
      return { task: this.store.task(task.id), conflict: null };
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
    // merged/none：这条线已经收尾；superseded：这一轮解冲突被下一轮取代，分支留作恢复点，不强留工作区。
    check(['merged','none','superseded'].includes(task.integration), 'unmerged work must be kept');
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
