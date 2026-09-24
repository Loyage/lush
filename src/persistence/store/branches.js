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

  /** ref 真的被删掉时调用（目前只有 cleanup 的 dropBranch）。只改状态，不删行——子分支的 parent 必须继续有效。
   *  分支被删除时其效果展示预约也不再有意义，同时清掉并留一条 `showcase.unreserved` 事件（挂在原属任务上，没有就 task_id=null）。 */
  markBranchDeleted(branch) {
    const reserved = Boolean(this.get('SELECT showcase_reservation FROM branches WHERE branch=?', branch)?.showcase_reservation);
    this.run("UPDATE branches SET status='deleted', deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), showcase_reservation=NULL WHERE branch=? AND status<>'deleted'", branch);
    if (reserved) {
      // branches.task_id 没有外键、可能指向已被 delete 的任务；拿不到活着的 task 就退回 task_id=null。
      const owner = this.get('SELECT task_id FROM branches WHERE branch=?', branch)?.task_id ?? null;
      this.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)',
        owner !== null && this.get('SELECT id FROM tasks WHERE id=?', owner) ? owner : null,
        'showcase.unreserved', JSON.stringify({ branch, reason: 'branch deleted' }));
    }
  },

  /**
   * 归档：worktree 与本地 ref 都已删掉，但这条分支的工作信息（任务行、消息、事件、pi 会话文件）都留着。
   * 时间戳复用 `deleted_at`——它本来就表示「这条分支什么时候从磁盘上消失」，archived 只是删得更有保留价值；
   * 另加 archived_at 会重复同一含义，还要为老库补一次 schema 演进，所以不这么做。
   */
  markBranchArchived(branch) {
    this.run("UPDATE branches SET status='archived', deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE branch=?", branch);
  },

  /**
   * 一句话摘要：分支图上的标题优先用它，而不是输入 / 目标的原文首行。
   * 归一化：去首尾空白、内部连续空白压成单空格；长度必须 1..120 字，否则拒绝（含清空——摘要要么是
   * 人写的一句话，要么就没有）。只改 summary 这一列，不碰 status / deleted_at：摘要是描述，不是生命周期。
   * 分支必须先登记；返回更新后的行，便于调用方直接读回。
   */
  setBranchSummary(branch, summary) {
    check(typeof branch === 'string' && branch.length > 0, 'branch name must be non-empty text');
    check(this.branch(branch) !== null, 'branch must be registered before it can carry a summary');
    const normalized = String(summary ?? '').replace(/\s+/g, ' ').trim();
    check(normalized.length >= 1 && normalized.length <= 120, 'branch summary must be 1..120 characters');
    this.run('UPDATE branches SET summary=? WHERE branch=?', normalized, branch);
    return this.branch(branch);
  },

  /**
   * 写入（或清除）这条分支的效果展示预约。value 是 versioned JSON 对象，null 表示没有预约。
   * 预约是分支附属元数据，不新增表、不新增业务实体；只改这一列。
   */
  setBranchShowcaseReservation(branch, value) {
    check(typeof branch === 'string' && branch.length > 0, 'branch name must be non-empty text');
    check(this.branch(branch) !== null, 'branch must be registered before it can carry a showcase reservation');
    check(value === null || (typeof value === 'object' && !Array.isArray(value)), 'showcase reservation must be an object or null');
    this.run('UPDATE branches SET showcase_reservation=? WHERE branch=?', value === null ? null : JSON.stringify(value), branch);
    return this.branch(branch);
  },

  /** 全部仍为 `pending` 的预约（已启动的预约在 startShowcase 里清除）。JSON 损坏的行安全跳过。 */
  branchShowcaseReservations() {
    const out = [];
    for (const row of this.all('SELECT branch, showcase_reservation FROM branches WHERE showcase_reservation IS NOT NULL ORDER BY rowid')) {
      let value;
      try { value = JSON.parse(row.showcase_reservation); } catch { continue; }
      if (value && typeof value === 'object' && value.status === 'pending') out.push({ branch: row.branch, ...value });
    }
    return out;
  },

  /**
   * 一键合并运行是分支附属的运行态元数据，不新增表 / 实体：只在目标分支这一列上写 versioned JSON。
   * 传 null 清空（终态 / 取消）。分支必须先登记。
   */
  setBranchMergeRun(branch, value) {
    check(typeof branch === 'string' && branch.length > 0, 'branch name must be non-empty text');
    check(this.branch(branch) !== null, 'branch must be registered before it can carry a merge run');
    check(value === null || (typeof value === 'object' && !Array.isArray(value)), 'merge run must be an object or null');
    this.run('UPDATE branches SET merge_run=? WHERE branch=?', value === null ? null : JSON.stringify(value), branch);
    return this.branch(branch);
  },

  /** 读一条分支的合并运行；JSON 损坏时安全返回 null，不让坏值拦住整条读写路径。 */
  branchMergeRun(branch) {
    const raw = this.get('SELECT merge_run FROM branches WHERE branch=?', branch)?.merge_run;
    if (!raw) return null;
    try { const value = JSON.parse(raw); return value && typeof value === 'object' ? value : null; } catch { return null; }
  },

  /** 全部仍在跑 / 暂停的合并运行；终态记录已被清空，不会出现在这里。 */
  activeBranchMergeRuns() {
    const out = [];
    for (const row of this.all("SELECT branch, merge_run FROM branches WHERE merge_run IS NOT NULL AND status='active' ORDER BY rowid")) {
      let value;
      try { value = JSON.parse(row.merge_run); } catch { continue; }
      if (value && typeof value === 'object' && ['running', 'paused'].includes(value.status)) out.push({ target: row.branch, run: value });
    }
    return out;
  },
};
