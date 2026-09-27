/** 检验与解冲突的关联读模型。 */
export const verification = {
  /** 一个 worker 收到过的检验记录，最新的在前。 */
  verifications(taskId) {
    return this.all(`SELECT id,status,result,error,baseline_commit,created_at,updated_at
      FROM tasks WHERE verifies_task_id=? ORDER BY id DESC`, taskId);
  },
  /** 同一任务同时只允许一次检验：还在跑的会占住这个名额。 */
  activeVerification(taskId) {
    return this.get(`SELECT id,status FROM tasks WHERE verifies_task_id=? AND status NOT IN ('completed','failed','cancelled') ORDER BY id DESC`, taskId);
  },
  /** 一次 worker 的合并冲突处理记录，最新在前：与 verifications 同一读模型。 */
  resolutions(taskId) {
    return this.all(`SELECT id,status,result,error,integration,integration_error,branch,head_commit,created_at,updated_at
      FROM tasks WHERE resolves_task_id=? ORDER BY id DESC`, taskId);
  },
  /**
   * 还在跑的解冲突任务：这种情况不允许再开一轮，也不允许重试原任务的合并。
   */
  activeResolver(taskId) {
    return this.get(`SELECT id,status FROM tasks WHERE resolves_task_id=? AND status NOT IN ('completed','failed','cancelled') ORDER BY id DESC`, taskId);
  },
  /**
   * 已经结束但没落地的解冲突任务：它的分支还值得留（恢复点），但已经没法再批准了，
   * 所以下一轮可以直接把它标成 superseded——不强删工作区，只把状态说清楚。
   */
  unlandedResolver(taskId) {
    return this.get(`SELECT id,status,integration FROM tasks WHERE resolves_task_id=?
      AND status='completed' AND integration NOT IN ('merged','superseded') ORDER BY id DESC`, taskId);
  },
  /**
   * 同一目标分支上未解决的合并冲突（只取 id：调用方只需要知道「这条分支被谁冻结」）。
   * 这就是那把合并锁：从状态派生，不另建表，
   * 所以崩溃重启后锁跟着行一起还在，也不会出现「进程死了锁留在内存里」这种残留。
   */
  conflictsOn(targetBranch) {
    if (!targetBranch) return [];
    return this.all("SELECT id FROM tasks WHERE integration='conflict' AND target_branch=? ORDER BY id", targetBranch);
  },
};
