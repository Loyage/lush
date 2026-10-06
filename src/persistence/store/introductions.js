/** 「快速介绍」记录：直连模型 API 的只读结果，不是任务。 */
export const introductions = {
  intro(rowId) { return this.get('SELECT * FROM introductions WHERE id=?', rowId); },

  quickExplanationCreate({ quote, location, model, source, prompt }) {
    const id = Number(this.run(`INSERT INTO introductions(task_id,quote,location,status,base_url,model,source_snapshot)
      VALUES (?,?,?,'running',?,?,?)`, location.task_id ?? null, quote, JSON.stringify(location), source.endpoint, model,
    JSON.stringify({ version: 1, source, prompt })).lastInsertRowid);
    return this.intro(id);
  },

  quickExplanationList(before = null, limit = 31) {
    return this.all(`SELECT id,status,substr(quote,1,180) AS quote,model,location,created_at,updated_at,
      (SELECT COUNT(*) FROM explanation_followups f WHERE f.introduction_id=introductions.id) AS followup_count
      FROM introductions ${before === null ? '' : 'WHERE id<?'} ORDER BY id DESC LIMIT ?`,
    ...(before === null ? [limit] : [before, limit]));
  },

  /** 创建一条追问（running）：问题与是否截断了更早上下文一起落库，回答稍后回写。 */
  followupCreate({ introductionId, question, truncated = false }) {
    const id = Number(this.run(`INSERT INTO explanation_followups(introduction_id,question,status,context_truncated)
      VALUES (?,?,'running',?)`, introductionId, question, truncated ? 1 : 0).lastInsertRowid);
    return this.followup(id);
  },

  followup(rowId) { return this.get('SELECT * FROM explanation_followups WHERE id=?', rowId); },

  /** 某条解释下的追问轮次，按发生顺序（id 升序）返回。 */
  followupList(introductionId) {
    return this.all('SELECT * FROM explanation_followups WHERE introduction_id=? ORDER BY id', introductionId);
  },

  followupFinish(rowId, { status, answer = null, error = null }) {
    this.run(`UPDATE explanation_followups SET status=?,answer=?,error=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=?`, status, answer, error, rowId);
    return this.followup(rowId);
  },

  /** 删除一条解释时连同其追问一起移除；调用方负责确认没有在途轮次。 */
  deleteFollowups(introductionId) {
    return this.run('DELETE FROM explanation_followups WHERE introduction_id=?', introductionId).changes;
  },

  /** 进程中断后把遗留的 running 追问如实标成失败，不重放、不丢问题。 */
  followupFailRunning(reason) {
    return this.run(`UPDATE explanation_followups SET status='failed',error=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE status='running'`, reason).changes;
  },

  quickExplanationFailRunning(reason) {
    return this.run(`UPDATE introductions SET status='failed',error=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE status='running' AND source_snapshot IS NOT NULL`, reason).changes;
  },

  introCreate({ taskId = null, quote, location, baseUrl = '', model = '' }) {
    const id = Number(this.run(`INSERT INTO introductions(task_id,quote,location,status,base_url,model)
      VALUES (?,?,?,'running',?,?)`, taskId, quote, JSON.stringify(location), baseUrl, model).lastInsertRowid);
    return this.intro(id);
  },

  /** Hard-delete one explanation history row; the caller decides whether the record is removable. */
  deleteIntroduction(rowId) {
    return this.run('DELETE FROM introductions WHERE id=?', rowId).changes;
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
