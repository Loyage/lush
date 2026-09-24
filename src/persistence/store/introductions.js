/** 「快速介绍」记录：直连模型 API 的只读结果，不是任务。 */
export const introductions = {
  intro(rowId) { return this.get('SELECT * FROM introductions WHERE id=?', rowId); },

  introCreate({ taskId = null, quote, location, baseUrl = '', model = '' }) {
    const id = Number(this.run(`INSERT INTO introductions(task_id,quote,location,status,base_url,model)
      VALUES (?,?,?,'running',?,?)`, taskId, quote, JSON.stringify(location), baseUrl, model).lastInsertRowid);
    return this.intro(id);
  },

  introFinish(rowId, { status, result = null, error = null }) {
    this.run(`UPDATE introductions SET status=?,result=?,error=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=?`, status, result, error, rowId);
    return this.intro(rowId);
  },

  /** 进程中断后没有 invocation 会再回来收尾，启动恢复时把遗留的 running 如实标成失败。 */
  introFailRunning(reason) {
    return this.run(`UPDATE introductions SET status='failed',error=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE status='running'`, reason).changes;
  },

  /** 某个任务详情页上的快速介绍历史，最新在前；`before` 是上一页最后一条的 id。 */
  introList(taskId, before = null, limit = 51) {
    return this.all(`SELECT * FROM introductions WHERE task_id=?${before === null ? '' : ' AND id<?'}
      ORDER BY id DESC LIMIT ?`, ...(before === null ? [taskId, limit] : [taskId, before, limit]));
  },
};
