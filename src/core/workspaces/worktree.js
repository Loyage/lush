import path from 'node:path';
import fs from 'node:fs';
import { check } from '../types.js';
import { taskLabel, inputLabel } from '../naming.js';
import { dirtDetail } from './git.js';

/** worktree / 对照检出 / 输入锚点的创建与回收。 */
export const methods = {
  /**
   * 输入锚点：把「提交这条输入那一刻的代码」固定成一条分支加一个检出。
   * 它属于输入而不是任务（没有 agent 在这里跑），所以由 Git 边界创建、由调用方落库并负责失败回收。
   * 先落库再动 git：谱系表示「这条分支确实被创建了」，崩溃重试不会重写它。
   * 失败一律抛错——锚不住就不接受输入。
   */
  anchor(inputId, requestedBranch = null) {
    return this.exclusive(async () => {
      const project = this.config.project;
      // 不是仓库时 `rev-parse` 自己会抛错，但报错要说清「提交输入需要什么」，不甩一行 git 原始输出。
      let root = null;
      try { root = fs.realpathSync(await this.git(project, 'rev-parse', '--show-toplevel')); } catch { /* not a repository */ }
      check(root === project, 'submitting an input requires the project to be a git worktree root');
      let current = null;
      try { current = await this.git(project, 'symbolic-ref', '--short', 'HEAD'); } catch { /* detached HEAD */ }
      const target = requestedBranch || current;
      check(target !== null, 'cannot choose an input parent on a detached HEAD; pass --branch or check out a branch');
      check(typeof target === 'string' && target.length > 0 && target.length <= 512, 'input branch must be non-empty text');
      // 只接受精确的本地 branch ref，不让 tag、SHA 或 rev 表达式偷偷变成父分支。
      let commit = null;
      try {
        await this.git(project, 'show-ref', '--verify', `refs/heads/${target}`);
        commit = await this.git(project, 'rev-parse', '--verify', `refs/heads/${target}^{commit}`);
      } catch { /* missing local branch */ }
      check(commit, `input parent branch does not exist locally: ${target}`);
      const name = inputLabel(inputId);
      const branch = `lush/${this.namespace}/${name}`;
      const workspace = path.join(this.config.home, 'worktrees', name);
      check(!(await this.git(project, 'branch', '--list', branch)),
        `${branch} already exists; rename or remove it before submitting`);
      // 未提交改动不进入新分支；若父分支正被检出，把那份差异明确记下来。
      const targetWorkspace = await this.workspaceForBranch(target);
      const source = targetWorkspace ? await this.porcelain(targetWorkspace) : '';
      this.store.recordBranch({ branch, parent: target, created_from_commit: commit, worktree: workspace });
      fs.mkdirSync(path.dirname(workspace), { recursive: true });
      await this.git(project, 'worktree', 'add', '-b', branch, workspace, commit);
      const dirt = dirtDetail(source);
      return { branch, commit, workspace, target, dirty_source: dirt.files ? { ...dirt, workspace: targetWorkspace } : null };
    });
  },

  /**
   * 回收一条输入锚点。它是提交那一刻的只读快照，没有任何 agent 往里提交，所以只在
   * 「检出干净 + 分支顶端仍是锚定 commit」时才删；与任务分支一样用 compare-and-delete，不用 --force。
   * 任何一条不满足就保留并在 reason 里说明原因。
   */
  async dropAnchor(anchor) {
    const project = this.config.project;
    const branch = anchor.branch;
    const present = Boolean(anchor.workspace) && fs.existsSync(anchor.workspace);
    // 先把「这条检出还是不是当初那个快照」问清楚：不干净就整份（目录+分支）保留，
    // 不先删目录、再发现分支不能删。
    if (present) {
      try { await this.clean(anchor.workspace); }
      catch (error) { return { branch, status: 'kept', reason: `anchor checkout ${anchor.workspace}: ${error.message}` }; }
    }
    let tip = null;
    try { tip = await this.git(project, 'rev-parse', `refs/heads/${branch}`); } catch { /* ref 已经不在 */ }
    if (tip !== null && tip !== anchor.commit) {
      const parent = this.store.branch(branch)?.parent ?? anchor.target;
      let integrated = false;
      if (parent) integrated = await this.isAncestor(project, tip, `refs/heads/${parent}`);
      if (!integrated) return { branch, status: 'kept',
        reason: `input branch tip ${tip.slice(0, 12)} has not been merged into ${parent ?? 'its parent'}` };
    }
    if (present) await this.git(project, 'worktree', 'remove', anchor.workspace);
    if (tip === null) return { branch, status: 'absent', reason: null };
    if (await this.checkedOut(branch)) return { branch, status: 'kept', reason: 'branch is checked out in a worktree' };
    await this.git(project, 'update-ref', '-d', `refs/heads/${branch}`, tip);
    this.store.markBranchDeleted(branch);
    return { branch, status: 'removed', reason: null };
  },

  /** 单独回收一条（提交失败回滚时用）：自己进串行队列。 */
  releaseAnchor(anchor) { return this.exclusive(() => this.dropAnchor(anchor)); },

  /** clear 用：在**同一个** exclusive 块里逐条回收，一条被安全门挡住不影响其余的。 */
  reclaimAnchors(anchors) {
    return this.exclusive(async () => {
      const outcomes = [];
      for (const anchor of anchors) {
        try { outcomes.push({ id: anchor.id, ...await this.dropAnchor(anchor) }); }
        catch (error) { outcomes.push({ id: anchor.id, branch: anchor.branch, status: 'kept', reason: error.message }); }
      }
      return outcomes;
    });
  },

  async ensure(task) {
    if (task.task_kind === 'main') return this.config.project;
    // 只读分析：分支最新提交的分离检出，**不创建也不占用任何分支**，所以分析师无法推进任何 ref。
    // 与 verifier 的对照检出同一套路：目录是派生的，invocation 结束就回收。
    if (task.task_kind === 'analysis') return this.exclusive(async () => {
      task = this.store.task(task.id);
      const project = this.config.project;
      check(task.target_branch, `analysis #${task.id} has no branch to analyze`);
      const commit = await this.git(project, 'rev-parse', '--verify', `refs/heads/${task.target_branch}^{commit}`);
      if (task.baseline_workspace && fs.existsSync(task.baseline_workspace)) {
        const root = fs.realpathSync(await this.git(task.baseline_workspace, 'rev-parse', '--show-toplevel'));
        check(root === task.baseline_workspace, 'analysis checkout is not a git worktree root');
        return task.baseline_workspace;
      }
      const dir = path.join(this.config.home, 'worktrees', `${taskLabel(task.id, task.name)}-analysis`);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      this.store.update(task.id, { baseline_workspace: dir, base_commit: commit });
      await this.git(project, 'worktree', 'add', '--detach', dir, commit);
      this.store.event(task.id, 'analysis.checkout', { workspace: dir, commit, branch: task.target_branch });
      return dir;
    });
    if (task.task_kind === 'say') {
      // A say Task owns the input branch itself. Never create a second worker branch for it.
      const anchor = this.inputAnchor(task);
      check(anchor?.workspace && fs.existsSync(anchor.workspace), `say #${task.id} has no worktree; inspect before retrying`);
      const root = fs.realpathSync(await this.git(anchor.workspace, 'rev-parse', '--show-toplevel'));
      check(root === anchor.workspace && task.workspace === anchor.workspace, 'say worktree identity changed');
      check(await this.git(anchor.workspace, 'symbolic-ref', '--short', 'HEAD') === task.branch, 'say branch changed');
      return anchor.workspace;
    }
    if (task.role === 'showcase') return this.ensureShowcase(task);
    // verifier 不修改代码：它站在被检验的 worktree 里演示，另拉一个目标分支的只读对照。
    if (task.role === 'verifier') return this.exclusive(async () => {
      task = this.store.task(task.id);
      const candidate = task.review_candidate_id ? this.store.candidate(task.review_candidate_id) : null;
      const target = candidate ? null : this.store.task(task.verifies_task_id);
      const candidateInput = candidate ? this.store.get('SELECT anchor_workspace FROM inputs WHERE id=?', candidate.input_id) : null;
      const workspace = candidate ? candidateInput?.anchor_workspace : target.workspace;
      check(workspace && fs.existsSync(workspace), candidate
        ? `candidate #${candidate.id} has no integration worktree to compare`
        : `verified task #${target.id} has no worktree to compare`);
      if (candidate) {
        const actual = await this.git(workspace, 'rev-parse', 'HEAD');
        check(actual === candidate.commit_hash,
          `candidate #${candidate.id} pins ${candidate.commit_hash.slice(0,12)}, but its worktree moved; prepare a new candidate`);
        // G-02: a dirty tree would let the verifier read files that are not in the frozen commit.
        const dirty = await this.porcelain(workspace);
        check(!dirty, `candidate #${candidate.id} worktree has uncommitted changes; verification must read the pinned commit\n${dirty}`);
      }
      if (task.baseline_workspace && fs.existsSync(task.baseline_workspace)) return workspace;
      const project = this.config.project;
      // Candidate verification pins both sides; legacy task verification compares the target branch's current tip.
      const targetBranch = candidate ? candidate.baseline_branch : target.target_branch;
      const commit = candidate ? candidate.baseline_commit : await this.git(project, 'rev-parse', targetBranch);
      const dir = path.join(this.config.home, 'worktrees', `${taskLabel(task.id, task.name)}-base`);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      this.store.update(task.id, { baseline_workspace: dir, baseline_commit: commit });
      await this.git(project, 'worktree', 'add', '--detach', dir, commit);
      this.store.event(task.id, 'baseline.created', { workspace: dir, commit, target_branch: targetBranch,
        review_candidate_id: candidate?.id ?? null });
      return workspace;
    });
    // 根 planner 必须在这条输入自己的分支快照中解析，而不是读取可能已经前进或带有未提交改动的主工作树。
    if (task.role === 'planner' && task.input_id) {
      const anchor = this.inputAnchor(task);
      if (anchor?.workspace && fs.existsSync(anchor.workspace)) return anchor.workspace;
    }
    if (task.role !== 'worker' && task.role !== 'merger' && task.task_kind !== 'child') return this.config.project;
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
      // 有锚点时基线是**提交输入那一刻**的 commit，那份 divergence 记在 `input.anchor` 事件里；
      // 这里的 dirty_source 只说明开工时主树是什么状态。
      const source = await this.porcelain(project);
      // A code dependency stacks this task on the upstream branch, so the agent sees work that is not merged yet.
      // base_commit is frozen once: a retry must build the same tree as the review did.
      // 解冲突任务的基线取目标分支的顶端（不是 HEAD：用户可能已经切到别的分支）：
      // 它的产物必须是「目标分支 + 那次已审阅的提交」的合并提交，批准时才能 --ff-only 原样落地。
      const stacked = task.base_commit ? null : this.codeBase(task);
      const resolves = Boolean(task.resolves_task_id);
      const branchSync = task.role === 'merger' && !resolves && Boolean(task.base_commit && task.target_branch);
      // 没有 code 依赖、也不是 merger 时，基线来自这条输入的分支起点。输入分支之后可以聚合子分支，
      // 但一个已经派出的并行任务仍从输入提交时冻结的 commit 开始，不会随合并时机漂移。
      // 终态 say 的独立解分歧子 Task 也是 task_kind='child'，但没有父任务（用 resolves_task_id 关联）。
      const owner = task.task_kind === 'child' && task.parent_id && !resolves ? this.store.task(task.parent_id) : null;
      check(!owner || owner.branch, 'new child Task has no parent branch');
      const anchor = (resolves || branchSync || owner) ? null : this.inputAnchor(task);
      const base = task.base_commit || (owner
        ? await this.git(project, 'rev-parse', '--verify', `refs/heads/${owner.branch}^{commit}`)
        : resolves
        ? await this.git(project, 'rev-parse', `refs/heads/${task.target_branch}`)
        : stacked?.head_commit || anchor?.commit || await this.git(project, 'rev-parse', 'HEAD'));
      // Branch-first：任务只交付给自己的直接父分支。普通任务回到输入分支，code 下游回到上游任务分支；
      // 输入分支再由用户从分支图批准合回它的父分支。
      const target = task.target_branch || owner?.branch || (task.input_id ? (stacked?.branch || anchor?.branch) : null)
        || await this.git(project, 'symbolic-ref', '--short', 'HEAD');
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
      // code 依赖时是上游任务的分支（stacked），解冲突任务是目标分支，其余是这条输入的锚点分支；
      // created_from_commit 就是拉起 worktree 用的那个 commit，所以 parent 后来往前走也查得到当时的起点。
      // 与上面一样先落库再动 git，且已有记录绝不改写：merge / 重建都不能重写创建时的血缘。
      this.store.recordBranch({
        branch,
        parent: stacked ? stacked.branch : (branchSync || resolves) ? target : anchor?.branch ?? target,
        created_from_commit: stacked ? stacked.head_commit : base,
        task_id: task.id, worktree: workspace,
      });
      // 从冻结的 head_commit 拉起，而不是从上游分支名：分支可能已经被回收，
      // 而下游要看的本来就是审阅过的那次提交。
      await this.git(project, 'worktree', 'add', ...(reuse ? [workspace, branch] : ['-b', branch, workspace, stacked ? stacked.head_commit : base]));
      const dirt = dirtDetail(source);
      this.store.event(task.id, 'workspace.created', { workspace, branch, base, stacked_on: stacked ? stacked.id : null,
        anchored_on: anchor ? { input_id: anchor.id, branch: anchor.branch, commit: anchor.commit } : null,
        dirty_source: dirt.files ? dirt : null });
      return workspace;
    });
  },

  /**
   * 这条输入在提交那一刻锚下来的代码：worker 的基线、目标分支与谱系 parent 都从它来。
   * 返回 null 时（老库里的输入、或没有 input 的 task）退回「spawn 时取 HEAD」的旧行为。
   */
  inputAnchor(task) {
    if (!task.input_id) return null;
    const input = this.store.get('SELECT id, anchor_branch, anchor_commit, anchor_workspace, anchor_target_branch FROM inputs WHERE id=?', task.input_id);
    if (!input || !input.anchor_commit) return null;
    return { id: input.id, branch: input.anchor_branch, commit: input.anchor_commit, workspace: input.anchor_workspace, target: input.anchor_target_branch };
  },
  async finish(task) {
    if (task.role === 'showcase') {
      const snapshot = JSON.parse(task.showcase);
      for (const [dir, commit] of [[task.workspace, snapshot.commit], [task.baseline_workspace, snapshot.baseline_commit]]) {
        await this.assertShowcaseCheckout(dir, commit);
      }
      return;
    }
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
