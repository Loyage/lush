import { check } from '../../core/types.js';

/** parent_relation 的取值：谁写下这个 parent，以及它有多可信。 */
export const PARENT_RELATIONS = new Set(['recorded', 'inferred', 'unknown']);

/**
 * 分支谱系（branches 表）的读写。
 *
 * 表是**历史记录**，不是 git 的镜像：某个 ref 现在还在不在、指向哪个 commit，由读模型现算
 * （`Project#branchTree` 只读 git），所以这里不做「后台同步」，也不因为 ref 消失而删行。
 */
export const branches = {
  branch(branch) { return this.get('SELECT * FROM branches WHERE branch=?', branch) ?? null; },
  /** 全部记录，按写入顺序（rowid）：没有 id 列，排序只依赖插入顺序。 */
  branches() { return this.all('SELECT * FROM branches ORDER BY rowid'); },

  /**
   * 只在分支**确实要创建**（或崩溃重试撞见刚创建的分支）时调用。
   * 已经有记录就一个字都不改：谱系表示创建时的血缘，后来的 merge / 分支被重建都不能改写 parent。
   */
  recordBranch({ branch, parent = null, relation = null, created_from_commit = null, task_id = null, worktree = null }) {
    check(typeof branch === 'string' && branch.length > 0 && branch.length <= 512, 'branch name must be non-empty text');
    check(parent === null || (typeof parent === 'string' && parent.length > 0), 'parent branch must be non-empty text');
    check(parent !== branch, 'a branch cannot be its own parent');
    const parentRelation = relation ?? (parent === null ? 'unknown' : 'recorded');
    check(PARENT_RELATIONS.has(parentRelation), 'parent relation must be recorded, inferred or unknown');
    this.run(`INSERT INTO branches(branch,parent,parent_relation,created_from_commit,task_id,worktree)
      VALUES (?,?,?,?,?,?) ON CONFLICT(branch) DO NOTHING`,
    branch, parent, parentRelation, created_from_commit, task_id, worktree);
    return this.branch(branch);
  },

  /** ref 真的被删掉时调用（目前只有 cleanup 的 dropBranch）。只改状态，不删行——子分支的 parent 必须继续有效。 */
  markBranchDeleted(branch) {
    this.run("UPDATE branches SET status='deleted', deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE branch=? AND status<>'deleted'", branch);
  },

  /**
   * 归档：worktree 与本地 ref 都已删掉，但这条分支的工作信息（任务行、消息、事件、pi 会话文件）都留着。
   * 时间戳复用 `deleted_at`——它本来就表示「这条分支什么时候从磁盘上消失」，archived 只是删得更有保留价值；
   * 另加 archived_at 会重复同一含义，还要为老库补一次 schema 演进，所以不这么做。
   */
  markBranchArchived(branch) {
    this.run("UPDATE branches SET status='archived', deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE branch=?", branch);
  },
};
