import path from 'node:path';
import fs from 'node:fs';
import { check } from '../types.js';
import { apLabel, inputLabel } from '../naming.js';
import { dirtDetail } from './git.js';

/** worktree / 对照检出 / 输入锚点的创建与回收。 */
export const methods = {
  /**
   * 输入锚点：把「提交这条输入那一刻的代码」固定成一条分支加一个检出。
   * 它属于输入而不是 AP（没有 agent 在这里跑），所以由 Git 边界创建、由调用方落库并负责失败回收。
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
   * 「检出干净 + 分支顶端仍是锚定 commit」时才删；与 AP 分支一样用 compare-and-delete，不用 --force。
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

  async ensure(ap) {
    if (ap.ap_kind === 'main') return this.config.project;
    // 只读分析：分支最新提交的分离检出，**不创建也不占用任何分支**，所以分析师无法推进任何 ref。
    // 与 verifier 的对照检出同一套路：目录是派生的，invocation 结束就回收。
    if (ap.ap_kind === 'analysis') return this.exclusive(async () => {
      ap = this.store.ap(ap.id);
      const project = this.config.project;
      check(ap.target_branch, `analysis #${ap.id} has no branch to analyze`);
      const commit = await this.git(project, 'rev-parse', '--verify', `refs/heads/${ap.target_branch}^{commit}`);
      if (ap.baseline_workspace && fs.existsSync(ap.baseline_workspace)) {
        const root = fs.realpathSync(await this.git(ap.baseline_workspace, 'rev-parse', '--show-toplevel'));
        check(root === ap.baseline_workspace, 'analysis checkout is not a git worktree root');
        return ap.baseline_workspace;
      }
      const dir = path.join(this.config.home, 'worktrees', `${apLabel(ap.id, ap.name)}-analysis`);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      this.store.update(ap.id, { baseline_workspace: dir, base_commit: commit });
      await this.git(project, 'worktree', 'add', '--detach', dir, commit);
      this.store.event(ap.id, 'analysis.checkout', { workspace: dir, commit, branch: ap.target_branch });
      return dir;
    });
    if (ap.ap_kind === 'say') {
      // A say AP owns the input branch itself. Never create a second worker branch for it.
      const anchor = this.inputAnchor(ap);
      check(anchor?.workspace && fs.existsSync(anchor.workspace), `say #${ap.id} has no worktree; inspect before retrying`);
      const root = fs.realpathSync(await this.git(anchor.workspace, 'rev-parse', '--show-toplevel'));
      check(root === anchor.workspace && ap.workspace === anchor.workspace, 'say worktree identity changed');
      check(await this.git(anchor.workspace, 'symbolic-ref', '--short', 'HEAD') === ap.branch, 'say branch changed');
      return anchor.workspace;
    }
    if (ap.role === 'showcase') return this.ensureShowcase(ap);
    // verifier 不修改代码：它站在被检验的 worktree 里演示，另拉一个目标分支的只读对照。
    if (ap.role === 'verifier') return this.exclusive(async () => {
      ap = this.store.ap(ap.id);
      const candidate = ap.review_candidate_id ? this.store.candidate(ap.review_candidate_id) : null;
      const target = candidate ? null : this.store.ap(ap.verifies_ap_id);
      const candidateInput = candidate ? this.store.get('SELECT anchor_workspace FROM inputs WHERE id=?', candidate.input_id) : null;
      const workspace = candidate ? candidateInput?.anchor_workspace : target.workspace;
      check(workspace && fs.existsSync(workspace), candidate
        ? `candidate #${candidate.id} has no integration worktree to compare`
        : `verified AP #${target.id} has no worktree to compare`);
      if (candidate) {
        const actual = await this.git(workspace, 'rev-parse', 'HEAD');
        check(actual === candidate.commit_hash,
          `candidate #${candidate.id} pins ${candidate.commit_hash.slice(0,12)}, but its worktree moved; prepare a new candidate`);
        // G-02: a dirty tree would let the verifier read files that are not in the frozen commit.
        const dirty = await this.porcelain(workspace);
        check(!dirty, `candidate #${candidate.id} worktree has uncommitted changes; verification must read the pinned commit\n${dirty}`);
      }
      if (ap.baseline_workspace && fs.existsSync(ap.baseline_workspace)) return workspace;
      const project = this.config.project;
      // Candidate verification pins both sides; legacy AP verification compares the target branch's current tip.
      const targetBranch = candidate ? candidate.baseline_branch : target.target_branch;
      const commit = candidate ? candidate.baseline_commit : await this.git(project, 'rev-parse', targetBranch);
      const dir = path.join(this.config.home, 'worktrees', `${apLabel(ap.id, ap.name)}-base`);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      this.store.update(ap.id, { baseline_workspace: dir, baseline_commit: commit });
      await this.git(project, 'worktree', 'add', '--detach', dir, commit);
      this.store.event(ap.id, 'baseline.created', { workspace: dir, commit, target_branch: targetBranch,
        review_candidate_id: candidate?.id ?? null });
      return workspace;
    });
    // 根 planner 必须在这条输入自己的分支快照中解析，而不是读取可能已经前进或带有未提交改动的主工作树。
    if (ap.role === 'planner' && ap.input_id) {
      const anchor = this.inputAnchor(ap);
      if (anchor?.workspace && fs.existsSync(anchor.workspace)) return anchor.workspace;
    }
    if (ap.role !== 'worker' && ap.role !== 'merger' && ap.ap_kind !== 'child') return this.config.project;
    return this.exclusive(async () => {
      ap = this.store.ap(ap.id);
      if (ap.workspace && fs.existsSync(ap.workspace)) {
        const root = fs.realpathSync(await this.git(ap.workspace, 'rev-parse', '--show-toplevel'));
        check(root === ap.workspace, 'AP workspace is not a git worktree root');
        check(await this.git(ap.workspace, 'symbolic-ref', '--short', 'HEAD') === ap.branch, 'AP worktree branch changed; restore it before retrying');
        return ap.workspace;
      }
      const project = this.config.project;
      const root = fs.realpathSync(await this.git(project, 'rev-parse', '--show-toplevel'));
      check(root === project, 'coding aps require the project to be a git worktree root');
      // 主工作树脏不再是硬门槛：`git worktree add` 只读已提交的 HEAD、不碰用户现场，所以 Lush
      // 不必为了开工去提交、暂存或藏起已有改动。代价是 worker 看不到未提交改动，这份分歧必须
      // 留痕（dirty_source），否则 review 无从知道 base 与用户当时的现场不同。
      // 有锚点时基线是**提交输入那一刻**的 commit，那份 divergence 记在 `input.anchor` 事件里；
      // 这里的 dirty_source 只说明开工时主树是什么状态。
      const source = await this.porcelain(project);
      // A code dependency stacks this AP on the upstream branch, so the agent sees work that is not merged yet.
      // base_commit is frozen once: a retry must build the same tree as the review did.
      // 解冲突 AP 的基线取目标分支的顶端（不是 HEAD：用户可能已经切到别的分支）：
      // 它的产物必须是「目标分支 + 那次已审阅的提交」的合并提交，批准时才能 --ff-only 原样落地。
      const stacked = ap.base_commit ? null : this.codeBase(ap);
      const resolves = Boolean(ap.resolves_ap_id);
      const branchSync = ap.role === 'merger' && !resolves && Boolean(ap.base_commit && ap.target_branch);
      // 没有 code 依赖、也不是 merger 时，基线来自这条输入的分支起点。输入分支之后可以聚合子分支，
      // 但一个已经派出的并行 AP 仍从输入提交时冻结的 commit 开始，不会随合并时机漂移。
      // 终态 say 的独立解分歧子 AP 也是 ap_kind='child'，但没有父 AP（用 resolves_ap_id 关联）。
      const owner = ap.ap_kind === 'child' && ap.parent_id && !resolves ? this.store.ap(ap.parent_id) : null;
      check(!owner || owner.branch, 'new child AP has no parent branch');
      const anchor = (resolves || branchSync || owner) ? null : this.inputAnchor(ap);
      const base = ap.base_commit || (owner
        ? await this.git(project, 'rev-parse', '--verify', `refs/heads/${owner.branch}^{commit}`)
        : resolves
        ? await this.git(project, 'rev-parse', `refs/heads/${ap.target_branch}`)
        : stacked?.head_commit || anchor?.commit || await this.git(project, 'rev-parse', 'HEAD'));
      // Branch-first：AP 只交付给自己的直接父分支。普通 AP 回到输入分支，code 下游回到上游 AP 分支；
      // 输入分支再由用户从分支图批准合回它的父分支。
      const target = ap.target_branch || owner?.branch || (ap.input_id ? (stacked?.branch || anchor?.branch) : null)
        || await this.git(project, 'symbolic-ref', '--short', 'HEAD');
      const branch = ap.branch || `lush/${this.namespace}/${apLabel(ap.id, ap.name)}`;
      let reuse = false;
      if (!ap.branch) check(!(await this.git(project, 'branch', '--list', branch)), 'AP branch already exists; preserve or rename the old branch before retrying');
      if (ap.branch) {
        try { await this.git(project, 'show-ref', '--verify', `refs/heads/${branch}`); reuse = true; }
        catch { /* a crash may have happened before the initial branch was created */ }
      }
      const workspace = path.join(this.config.home, 'worktrees', apLabel(ap.id, ap.name));
      fs.mkdirSync(path.dirname(workspace), { recursive: true });
      // Save the intended identity before git; a crash never makes the directory invisible.
      this.store.update(ap.id, { workspace, branch, base_commit: base, target_branch: target });
      // 谱系就在分支创建这一刻显式写下：parent 是这次真正分叉出来的那条分支——
      // code 依赖时是上游 AP 的分支（stacked），解冲突 AP 是目标分支，其余是这条输入的锚点分支；
      // created_from_commit 就是拉起 worktree 用的那个 commit，所以 parent 后来往前走也查得到当时的起点。
      // 与上面一样先落库再动 git，且已有记录绝不改写：merge / 重建都不能重写创建时的血缘。
      this.store.recordBranch({
        branch,
        parent: stacked ? stacked.branch : (branchSync || resolves) ? target : anchor?.branch ?? target,
        created_from_commit: stacked ? stacked.head_commit : base,
        ap_id: ap.id, worktree: workspace,
      });
      // 从冻结的 head_commit 拉起，而不是从上游分支名：分支可能已经被回收，
      // 而下游要看的本来就是审阅过的那次提交。
      await this.git(project, 'worktree', 'add', ...(reuse ? [workspace, branch] : ['-b', branch, workspace, stacked ? stacked.head_commit : base]));
      const dirt = dirtDetail(source);
      this.store.event(ap.id, 'workspace.created', { workspace, branch, base, stacked_on: stacked ? stacked.id : null,
        anchored_on: anchor ? { input_id: anchor.id, branch: anchor.branch, commit: anchor.commit } : null,
        dirty_source: dirt.files ? dirt : null });
      return workspace;
    });
  },

  /**
   * 这条输入在提交那一刻锚下来的代码：worker 的基线、目标分支与谱系 parent 都从它来。
   * 返回 null 时（老库里的输入、或没有 input 的 AP）退回「spawn 时取 HEAD」的旧行为。
   */
  inputAnchor(ap) {
    if (!ap.input_id) return null;
    const input = this.store.get('SELECT id, anchor_branch, anchor_commit, anchor_workspace, anchor_target_branch FROM inputs WHERE id=?', ap.input_id);
    if (!input || !input.anchor_commit) return null;
    return { id: input.id, branch: input.anchor_branch, commit: input.anchor_commit, workspace: input.anchor_workspace, target: input.anchor_target_branch };
  },
  async finish(ap) {
    if (ap.role === 'showcase') {
      const snapshot = JSON.parse(ap.showcase);
      for (const [dir, commit] of [[ap.workspace, snapshot.commit], [ap.baseline_workspace, snapshot.baseline_commit]]) {
        await this.assertShowcaseCheckout(dir, commit);
      }
      return;
    }
    if (!ap.workspace) return;
    await this.clean(ap.workspace);
    const branch = await this.git(ap.workspace, 'symbolic-ref', '--short', 'HEAD');
    check(branch === ap.branch, 'agent changed the AP branch; restore it before retrying');
    const head = await this.git(ap.workspace, 'rev-parse', 'HEAD');
    this.store.update(ap.id, { head_commit: head, integration: head === ap.base_commit ? 'none' : 'pending' });
  },
  /** The single code dependency a worker may stack on; it has to be a finished worker with a branch. */
  codeBase(ap) {
    const edges = this.store.deps(ap.id).filter(edge => edge.kind === 'code');
    check(edges.length <= 1, 'an AP cannot stack on more than one code dependency');
    if (!edges.length) return null;
    const upstream = this.store.ap(edges[0].depends_on);
    check(upstream.role === 'worker', `code dependency #${upstream.id} is a ${upstream.role} ap; it has no branch to stack on`);
    check(upstream.status === 'completed', `code dependency #${upstream.id} is ${upstream.status}; only a completed upstream can be a worktree base`);
    check(upstream.head_commit, `code dependency #${upstream.id} produced no commit yet`);
    return upstream;
  },
  /** 对照基线是派生检出，没有用户工作：检验结算后回收，不占用磁盘。 */
  removeBaseline(apId) {
    return this.exclusive(async () => {
      const ap = this.store.ap(apId);
      if (!ap.baseline_workspace) return ap;
      const dir = ap.baseline_workspace;
      try { await this.git(this.config.project, 'worktree', 'remove', '--force', dir); }
      catch (error) {
        // 回收失败时保留指针，用户可以再次 cleanup；不隐藏仍然占着磁盘的目录。
        console.error(`verification ${apId}: baseline cleanup failed: ${error.message}`);
        return this.store.ap(ap.id);
      }
      this.store.update(ap.id, { baseline_workspace: null });
      this.store.event(ap.id, 'baseline.removed', { workspace: dir });
      return this.store.ap(ap.id);
    });
  },
};
