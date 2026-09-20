import fs from 'node:fs';
import { check } from '../types.js';
import { buildForest, parentOf, childrenOf, ancestorsOf, descendantsOf, chainOf, rootOf } from '../genealogy.js';

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

  /** branch.tree：谱系森林 + git 现状。默认把「有 ref 但没有记录」的分支也画出来（标 untracked）。 */
  async branchTree() {
    const state = await gitState(this.workspaces, this.config.project);
    const nodes = this.branchNodes(state);
    const limited = nodes.slice(0, BRANCH_NODE_LIMIT);
    return {
      generated_at: new Date().toISOString(), git: state.git, error: state.error,
      current_branch: state.current_branch, truncated: nodes.length > limited.length,
      count: nodes.length, roots: buildForest(limited),
    };
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
};
