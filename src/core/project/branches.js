import fs from 'node:fs';
import path from 'node:path';
import { check, TERMINAL } from '../types.js';
import { buildForest, parentOf, childrenOf, ancestorsOf, descendantsOf, chainOf, rootOf, pruneHidden } from '../genealogy.js';
import { slugify } from '../naming.js';
import { sessionFiles } from '../transcript.js';

/** 分支谱系一次最多画这么多节点；超过就截断并在结果里说明（只读视图不该拖垮 daemon）。 */
export const BRANCH_NODE_LIMIT = 500;

/**
 * 只用只读 git 拿三件事实：本地分支顶端、当前检出分支、每个分支检在哪个 worktree。
 * 不 checkout、不 merge、不改 ref、不写 store，所以 `project.stopping === true` 时也能安全跑。
 * 非 git 项目不抛错：store 里的谱系记录本身就是有意义的历史，只是没有「现在还在不在」这一半信息。
 */
async function gitState(workspaces, project) {
  const empty = { git: false, error: null, current_branch: null, refs: new Map(), worktrees: new Map() };
  try {
    await workspaces.git(project, 'rev-parse', '--git-dir');
  } catch (error) {
    return { ...empty, error: `not a git repository: ${error.message}` };
  }
  try {
    let current_branch = null;
    try { current_branch = await workspaces.git(project, 'symbolic-ref', '--short', 'HEAD'); } catch { /* detached HEAD */ }
    // 一次 for-each-ref 拿全部分支顶端，避免每条分支各跑一次 rev-parse。
    const refs = new Map();
    for (const line of (await workspaces.git(project, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads')).split('\n')) {
      const at = line.indexOf(' ');
      if (at > 0) refs.set(line.slice(0, at), line.slice(at + 1).trim());
    }
    // 分支检在哪个目录：`worktree list --porcelain` 是唯一权威来源，不靠路径拼接去猜。
    const worktrees = new Map();
    for (const block of (await workspaces.git(project, 'worktree', 'list', '--porcelain')).split(/\n\n+/)) {
      const path = /^worktree (.*)$/m.exec(block)?.[1] ?? null;
      const branch = /^branch refs\/heads\/(.*)$/m.exec(block)?.[1] ?? null;
      if (path && branch) worktrees.set(branch, path);
    }
    return { git: true, error: null, current_branch, refs, worktrees };
  } catch (error) {
    return { ...empty, git: true, error: error.message };
  }
}

/** 分支谱系：显式记录下来的「branch 从哪条 branch 创建」。不是 commit graph，也不是任务树。 */
export default {
  /** store 里的记录 ∪ 现在真实存在的本地分支，合成一个节点表；再交给纯逻辑拼森林。 */
  branchNodes(state) {
    const rows = this.store.branches();
    // 任务可能已经被 clear 清空：谱系记录留着，任务那一半信息就显示成「已清空」而不是消失。
    const tasks = new Map(rows.filter(row => row.task_id !== null).map(row => [row.task_id,
      this.store.get('SELECT id, role, name, goal FROM tasks WHERE id=?', row.task_id) ?? null]));
    const nodes = [];
    const seen = new Set();
    const push = (row, tracked) => {
      if (seen.has(row.branch)) return;
      seen.add(row.branch);
      const present = state.git ? state.refs.has(row.branch) : null;
      const task = row.task_id === null ? null : tasks.get(row.task_id) ?? null;
      const worktree = row.worktree ?? (state.git ? state.worktrees.get(row.branch) ?? null : null);
      nodes.push({
        branch: row.branch,
        parent: row.parent ?? null,
        parent_relation: row.parent_relation ?? null,
        created_from_commit: row.created_from_commit ?? null,
        task_id: row.task_id ?? null,
        task_role: task?.role ?? null,
        task_name: task?.name ?? null,
        task_goal: task ? String(task.goal).slice(0, 120) : null,
        worktree, worktree_exists: worktree ? fs.existsSync(worktree) : null,
        created_at: row.created_at ?? null,
        tracked, status: row.status ?? null,
        present, head_commit: present === true ? state.refs.get(row.branch) : null,
        current: row.branch === state.current_branch,
        deleted: present === false,
      });
    };
    for (const row of rows) push(row, true);
    if (state.git) for (const name of state.refs.keys()) push({ branch: name }, false);
    // 只被 parent 指针提到、自己既没记录也没 ref 的名字：也补一个节点，子分支不会从树上掉下去。
    // git 事实照旧现算（present=false），不替 git 编一个「还在」。
    for (const name of new Set(nodes.map(node => node.parent).filter(name => name && !seen.has(name)))) push({ branch: name }, false);
    return nodes;
  },

  /** branch.tree：谱系森林 + git 现状。默认把「有 ref 但没有记录」的分支也画出来（标 untracked）。
   *  归档的分支不再占分支树（它们是记录：`branch show` / 事件 / 任务详情里查），但不能连带藏掉它们的后代：
   *  把后代接到最近的非归档祖先上。 */
  async branchTree() {
    const state = await gitState(this.workspaces, this.config.project);
    const nodes = pruneHidden(this.branchNodes(state), node => node.status === 'archived');
    const limited = nodes.slice(0, BRANCH_NODE_LIMIT);
    return {
      generated_at: new Date().toISOString(), git: state.git, error: state.error,
      current_branch: state.current_branch, truncated: nodes.length > limited.length,
      count: nodes.length, roots: buildForest(limited),
    };
  },

  /** 用户从分支图批准 direct child -> parent。唯一允许的落地方式是 fast-forward。 */
  async approveBranchMerge(branch) {
    const name = String(branch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    const record = this.store.branch(name);
    check(record && record.parent && record.parent_relation === 'recorded', `${name} has no recorded direct parent`);
    if (record.task_id !== null) {
      const task = this.store.get('SELECT * FROM tasks WHERE id=?', record.task_id);
      check(!task || task.status === 'completed', `branch task #${record.task_id} is not completed`);
    }
    const outcome = await this.workspaces.mergeBranch(name);
    if (!outcome.merged && !outcome.already_integrated) return outcome;
    const task = record.task_id === null ? null : this.store.get('SELECT * FROM tasks WHERE id=?', record.task_id);
    if (task && ['pending','review','conflict','merging'].includes(task.integration)) {
      this.store.transaction(() => {
        this.store.update(task.id, { integration: 'merged', integration_error: null });
        this.store.event(task.id, 'merged', { commit: outcome.child_head, parent: outcome.parent,
          via: 'branch.graph', already_integrated: outcome.already_integrated === true });
      });
      await this.reconcileIntegrated(outcome.parent, task.id);
    } else {
      const input = this.store.get('SELECT task_id FROM inputs WHERE anchor_branch=?', name);
      if (input?.task_id) this.store.event(input.task_id, 'branch.merged', { branch: name, parent: outcome.parent,
        commit: outcome.child_head, already_integrated: outcome.already_integrated === true });
    }
    return outcome;
  },

  /**
   * 分歧不在父分支上 no-ff：创建一个以 child 顶端为基线的 merger 分支，让 agent 把冻结的 parent commit
   * 合进来并测试。它完成后先 ff 回 child，再由用户把 child ff 到 parent，始终逐层沿直接谱系收敛。
   */
  async syncBranch(branch) {
    const name = String(branch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    const state = await this.workspaces.branchState(name);
    check(state.status === 'diverged', `${name} is ${state.status}; branch sync is only needed after divergence`);
    check(state.blockers.length === 0, `sync ${name} is blocked by unfinished child work: ${state.blockers.join(', ')}`);
    const existing = this.store.get(`SELECT * FROM tasks WHERE role='merger' AND resolves_task_id IS NULL
      AND target_branch=? AND (status NOT IN ('completed','failed','cancelled') OR integration IN ('pending','review')) ORDER BY id DESC LIMIT 1`, name);
    if (existing) return { status: 'existing', task: existing, branch: name, parent: state.parent };
    const owner = this.store.branch(name);
    const ownerTask = owner?.task_id === null ? null : this.store.get('SELECT input_id FROM tasks WHERE id=?', owner.task_id);
    const input = ownerTask?.input_id ?? this.store.get('SELECT id FROM inputs WHERE anchor_branch=?', name)?.id ?? null;
    const goal = `让子分支 ${name} 跟上它的直接父分支 ${state.parent}。\n`
      + `你的 worktree 从子分支提交 ${state.child_head} 创建。请执行 git merge ${state.parent_head}，`
      + `如有冲突，在子分支侧保留双方意图并解决；提交 merge commit，运行相关测试。不要 rebase、不要改父分支。`;
    const task = this.store.transaction(() => {
      const created = this.store.create({ parent_id: null, input_id: input, role: 'merger', goal,
        name: `sync-${slugify(String(state.parent).split('/').at(-1), 28) || 'parent'}` });
      this.store.update(created.id, { base_commit: state.child_head, target_branch: name });
      this.store.event(created.id, 'branch.sync.requested', { child: name, parent: state.parent,
        child_commit: state.child_head, parent_commit: state.parent_head });
      return this.store.task(created.id);
    });
    this.kick();
    return { status: 'queued', task, branch: name, parent: state.parent,
      child_commit: state.child_head, parent_commit: state.parent_head };
  },

  /**
   * 归档一子树分支：删掉子树里每一条的 worktree 与本地 ref，但任务行、分支记录与 pi 会话文件都留着。
   * 传进来的那条是子树根：任务分支是从输入锚点长出来的，只删一半会留下一批「父分支已不在」的后代，
   * 所以归档一条就是归档它整棵子树；已经归档／回收过的后代直接跳过。
   * 所有安全门在动 Git 之前同步跑完，任一不满足就抛错且无副作用；通过后由 Git 边界两遍执行（先检查、再删）。
   */
  async archiveBranch(branch, { discard_worktree = false } = {}) {
    const name = String(branch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    const record = this.store.branch(name);
    check(record, `${name} is not a registered branch; run 'lush branch import' first`);
    check(record.status !== 'archived' && record.status !== 'deleted', `branch ${name} is already ${record.status}`);
    // 已经归档／回收过的分支不再归档一次（记录已是终态），但也不拦着其余的。
    const targets = [name, ...descendantsOf(this.store.branches(), name)]
      .filter(target => this.store.branch(target)?.status === 'active');
    const state = await gitState(this.workspaces, this.config.project);
    check(!targets.includes(state.current_branch), `cannot archive the branch currently checked out: ${state.current_branch}`);
    // 整棵子树上的任务都必须已终态：归档把这条分支的工作收起来，活还没完的状态不该被藏掉。
    const placeholders = targets.map(() => '?').join(',');
    const unfinished = this.store.all(`SELECT id, status FROM tasks WHERE branch IN (${placeholders})
      AND status NOT IN ('completed','failed','cancelled') ORDER BY id`, ...targets);
    check(unfinished.length === 0, `branch ${name} still has unfinished tasks: ${unfinished.map(task => `#${task.id}`).join(', ')}`);
    const outcomes = await this.workspaces.archiveBranches(targets, { discard_worktree });
    const tips = new Map(outcomes.map(outcome => [outcome.branch, outcome.tip]));
    // 目录已经删了，tasks.workspace 不能再指着一个不存在的路径；branch 字段是历史，必须留着。
    const archived = this.store.all(`SELECT id, status, branch FROM tasks WHERE branch IN (${placeholders}) ORDER BY id`, ...targets);
    // pi 会话文件在 <home>/sessions 下，不随 worktree 消失；把位置写进事件，将来 task 行被 clear 掉也能查回。
    const sessions = [];
    const sessionsByBranch = new Map(targets.map(target => [target, []]));
    for (const task of archived) {
      const files = sessionFiles(this.config, task.id).map(file => path.join(this.config.home, 'sessions', file));
      sessions.push(...files);
      sessionsByBranch.get(task.branch)?.push(...files);
    }
    this.store.transaction(() => {
      for (const task of archived) {
        this.store.update(task.id, { workspace: null });
        this.store.event(task.id, 'branch.archived', { branch: task.branch, tip: tips.get(task.branch) ?? null, task_id: task.id });
      }
      // 每条被归档的分支各留一条事件（含会话文件位置）：这条分支的原始记录就算以后被 clear 掉也查得回。
      for (const target of targets) {
        const own = archived.filter(task => task.branch === target);
        const owner = own.some(task => task.id === this.store.branch(target)?.task_id) ? this.store.branch(target).task_id : own[0]?.id ?? null;
        this.store.event(owner, 'branch.archived', { branch: target, tip: tips.get(target) ?? null, sessions: sessionsByBranch.get(target) ?? [] });
      }
    });
    const root = outcomes.find(outcome => outcome.branch === name) ?? outcomes[0] ?? {};
    // 顶层 worktree / ref / tip / discarded 描述的是子树根（调用方问的那条）；整棵子树看 branches。
    return { branch: name, archived: true, count: outcomes.length, branches: outcomes,
      worktree: root.worktree ?? 'absent', ref: root.ref ?? 'absent', tip: root.tip ?? null, discarded: root.discarded === true,
      tasks: archived.map(task => ({ id: task.id, status: task.status })), sessions };
  },

  /**
   * 用户从分支图让子分支跟上父分支（只允许 fast-forward）。它不改任何任务的 integration：
   * 只是把父分支已有的提交带进子分支，让下一次向上交付重新变成可 fast-forward。
   */
  async catchupBranch(branch) {
    const name = String(branch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    const record = this.store.branch(name);
    check(record && record.parent && record.parent_relation === 'recorded', `${name} has no recorded direct parent`);
    const outcome = await this.workspaces.catchupBranch(name);
    // 事件挂在「这条分支属于谁」上：有任务记在任务上，否则记在输入锚点的规划任务上（与 branch.merged 同口径）。
    const owner = record.task_id === null ? null : this.store.get('SELECT id FROM tasks WHERE id=?', record.task_id);
    const host = owner?.id ?? this.store.get('SELECT task_id FROM inputs WHERE anchor_branch=?', name)?.task_id ?? null;
    if (host !== null) this.store.event(host, 'branch.caught_up', { branch: name, parent: outcome.parent,
      from: outcome.from, to: outcome.to, already_integrated: outcome.already_integrated === true });
    return outcome;
  },

  /** branch.show：一条分支的 parent / fork commit / task / worktree，加上祖先链与后代。 */
  async branchShow(name) {
    const state = await gitState(this.workspaces, this.config.project);
    let branch = String(name ?? '').trim();
    check(branch.length > 0 && branch.length <= 512, 'branch name must be non-empty text');
    // 便利：允许用 task id 查——分支名形如 lush/<hash>/<id>-<name>，手打太长。
    if (/^\d+$/.test(branch)) {
      const task = this.store.task(Number(branch));
      check(task.branch, `task #${task.id} has no branch`);
      branch = task.branch;
    }
    const nodes = this.branchNodes(state);
    const node = nodes.find(row => row.branch === branch);
    check(node, `branch ${branch} is neither recorded nor a local branch; 'lush branch import' registers existing branches`);
    return {
      ...node, parent: parentOf(nodes, branch), root: rootOf(nodes, branch),
      ancestors: ancestorsOf(nodes, branch), chain: chainOf(nodes, branch),
      children: childrenOf(nodes, branch), descendants: descendantsOf(nodes, branch),
    };
  },

  /**
   * branch.import：把现有本地分支登记成记录，让旧项目也能在树上看到全貌。
   * 只记两件**事实**——这条分支存在、它现在检在哪个 worktree；parent 一个字都不猜（记为 unknown）。
   */
  async branchImport() {
    const state = await gitState(this.workspaces, this.config.project);
    check(state.git, state.error ?? 'branch import needs a git repository');
    const known = new Set(this.store.branches().map(row => row.branch));
    const added = [];
    this.store.transaction(() => {
      for (const name of [...state.refs.keys()].sort()) {
        if (known.has(name)) continue;
        this.store.recordBranch({ branch: name, worktree: state.worktrees.get(name) ?? null });
        added.push(name);
      }
    });
    return { imported: added.length, branches: added, local: state.refs.size, recorded: known.size };
  },

  /**
   * 一句话摘要：给一条已登记分支写 / 更新人写的简述，分支图上的标题优先用它（没有时才回落派生）。
   * 只动 `branches.summary` 这一列，不碰 status / deleted_at / ref / worktree，也不改任何任务。
   * 摘要内容（长度、空白归一）由 store.setBranchSummary 校验；分支没登记就报错，不自动补建记录。
   * 事件挂在「这条分支属于谁」上：有任务记在任务上，否则记在输入锚点的规划任务上（与 branch.caught_up 同口径）。
   */
  setBranchSummary(branch, summary) {
    const name = String(branch ?? '').trim();
    check(name.length > 0 && name.length <= 512, 'branch name must be non-empty text');
    const record = this.store.branch(name);
    check(record, `${name} is not a registered branch; run 'lush branch import' first`);
    const updated = this.store.setBranchSummary(name, summary);
    const host = record.task_id ?? this.store.get('SELECT task_id FROM inputs WHERE anchor_branch=?', name)?.task_id ?? null;
    this.store.event(host, 'branch.summary', { branch: name, summary: updated.summary });
    return updated;
  },
};
