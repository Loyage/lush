import fs from 'node:fs';

/** 分支图的规模上限：只读视图不该为了画全图把 daemon 拖垮，超限截断并在结果里说明。 */
export const GRAPH_NODE_LIMIT = 200;
export const GRAPH_EDGE_LIMIT = 2000;

/** 只有会产出 worktree / 分支的角色进图；planner / scheduler / coordinator 是意图层，不在这里。 */
const GRAPH_ROLES = ['worker', 'merger', 'verifier'];
const TASK_ROLE_SQL = GRAPH_ROLES.map(role => `'${role}'`).join(',');

/**
 * 分支图读模型：任务 -> 分支 / worktree / 目标分支的关系网，以及任务的堆叠（code）/顺序（order）/
 * 解冲突（resolve）/检验（verify）/目标分支（target）边。
 *
 * 全部只用只读 git（rev-parse / symbolic-ref / for-each-ref / rev-list）与文件系统探测：
 * 不 checkout、不 merge、不改 index、不删 worktree、不写 store（无 update / event），
 * 所以 `project.stopping === true` 时也能安全跑。非 git 项目或 git 命令失败返回空图并带
 * `git:false` / `error`，不抛错——图是给人看的辅助视图，不该把 daemon 的轮询打断。
 */
export default {
  async graph() {
    const generated_at = new Date().toISOString();
    const empty = { generated_at, current_branch: null, truncated: false, git: false, error: null, nodes: [], edges: [] };
    const project = this.config.project;
    try {
      await this.workspaces.git(project, 'rev-parse', '--git-dir');
    } catch (error) {
      return { ...empty, error: `not a git repository: ${error.message}` };
    }
    let currentBranch = null;
    try { currentBranch = await this.workspaces.git(project, 'symbolic-ref', '--short', 'HEAD'); } catch { /* detached HEAD：没有当前分支 */ }

    try {
      // 一次 for-each-ref 拿到所有本地分支的顶端，避免每个节点各跑一次 rev-parse。
      const refs = new Map();
      const refList = await this.workspaces.git(project, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads');
      for (const line of refList.split('\n')) {
        const at = line.indexOf(' ');
        if (at > 0) refs.set(line.slice(0, at), line.slice(at + 1).trim());
      }

      const rows = this.store.all(`SELECT id, role, name, goal, status, integration, branch, workspace,
        base_commit, head_commit, target_branch, baseline_workspace, resolves_task_id, verifies_task_id
        FROM tasks WHERE role IN (${TASK_ROLE_SQL}) ORDER BY id DESC`);
      // 没有分支也没有 worktree（含已完整回收）的任务不进图：它没有任何可画的关系。
      const candidates = rows.filter(row => row.branch || row.workspace || row.baseline_workspace);

      // 先收集分支节点名（每个出现过的 target_branch + 当前检出分支），给它们预留节点额度。
      const branchNames = new Set();
      for (const row of candidates) if (row.target_branch) branchNames.add(row.target_branch);
      if (currentBranch) branchNames.add(currentBranch);
      const taskCapacity = Math.max(0, GRAPH_NODE_LIMIT - branchNames.size);
      let truncated = candidates.length > taskCapacity;
      const taskRows = candidates.slice(0, taskCapacity);

      const nodes = [];
      for (const row of taskRows) {
        const workspacePath = row.workspace || row.baseline_workspace || null;
        const workspace_state = workspacePath ? (fs.existsSync(workspacePath) ? 'present' : 'missing') : 'none';
        const knownRef = row.branch ? refs.get(row.branch) ?? null : null;
        const branch_state = row.branch && knownRef ? 'present' : 'missing';
        const headCommit = row.head_commit || knownRef;
        const targetHead = row.target_branch ? refs.get(row.target_branch) ?? null : null;
        let ahead = null, behind = null, merged = null;
        if (headCommit && row.target_branch && targetHead) {
          try {
            // 左边 = 只有目标分支有的（behind），右边 = 只有本分支有的（ahead）。
            const output = await this.workspaces.git(project, 'rev-list', '--left-right', '--count',
              `refs/heads/${row.target_branch}...${headCommit}`);
            const [left, right] = output.split(/\s+/).map(Number);
            if (Number.isFinite(left) && Number.isFinite(right)) { behind = left; ahead = right; }
          } catch { /* 任一侧取不到就保持 null */ }
          merged = headCommit === targetHead ? true : await this.containsCommit(headCommit, targetHead);
        }
        const node = {
          kind: 'task', id: row.id, role: row.role, name: row.name ?? null,
          goal: String(row.goal ?? '').slice(0, 120),
          status: row.status, integration: row.integration,
          branch: row.branch ?? null, workspace: workspacePath, workspace_state, branch_state,
          base_commit: row.base_commit ?? null, head_commit: row.head_commit ?? null,
          target_branch: row.target_branch ?? null, ahead, behind, merged,
          current: Boolean(row.branch) && row.branch === currentBranch,
        };
        nodes.push(node);
      }

      for (const name of [...branchNames].sort()) {
        nodes.push({ kind: 'branch', id: `branch:${name}`, name, head_commit: refs.get(name) ?? null, current: name === currentBranch });
      }
      if (nodes.length > GRAPH_NODE_LIMIT) { truncated = true; nodes.length = GRAPH_NODE_LIMIT; }
      const nodeIds = new Set(nodes.map(node => node.id));

      const edges = [];
      for (const dep of this.store.all('SELECT task_id, depends_on, kind FROM task_deps ORDER BY task_id, depends_on')) {
        if (!nodeIds.has(dep.task_id) || !nodeIds.has(dep.depends_on)) continue;
        edges.push({ kind: dep.kind, from: dep.depends_on, to: dep.task_id });
      }
      for (const row of taskRows) {
        if (row.resolves_task_id && nodeIds.has(row.resolves_task_id)) edges.push({ kind: 'resolve', from: row.id, to: row.resolves_task_id });
        if (row.verifies_task_id && nodeIds.has(row.verifies_task_id)) edges.push({ kind: 'verify', from: row.id, to: row.verifies_task_id });
        if (row.target_branch && nodeIds.has(`branch:${row.target_branch}`)) edges.push({ kind: 'target', from: row.id, to: `branch:${row.target_branch}` });
      }
      let trimmedEdges = edges;
      if (trimmedEdges.length > GRAPH_EDGE_LIMIT) { truncated = true; trimmedEdges = trimmedEdges.slice(0, GRAPH_EDGE_LIMIT); }

      return { generated_at, current_branch: currentBranch, truncated, git: true, error: null, nodes, edges: trimmedEdges };
    } catch (error) {
      return { ...empty, git: true, error: error.message };
    }
  },
};
