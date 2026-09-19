import { check, id, EXECUTING } from '../../core/types.js';

/** 拆解队列（task_specs）的读写与批次归属。 */
export const specs = {
  /** deps is stored as JSON text; every read model hands callers the parsed array. */
  specDeps(raw) {
    try { const value = JSON.parse(raw ?? '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
  },
  addSpec({ input_id = null, planner_task_id, goal, role = null, name = null, deps = [] }) {
    const seq = this.get('SELECT COALESCE(MAX(seq),0) AS value FROM task_specs WHERE planner_task_id=?', planner_task_id).value + 1;
    const row = this.run('INSERT INTO task_specs(input_id,planner_task_id,seq,goal,role,name,deps) VALUES (?,?,?,?,?,?,?)',
      input_id, planner_task_id, seq, goal, role, name, JSON.stringify(deps));
    return this.spec(Number(row.lastInsertRowid));
  },
  spec(specId) {
    const row = this.get('SELECT * FROM task_specs WHERE id=?', id(specId));
    check(row, `spec ${specId} not found`);
    return { ...row, deps: this.specDeps(row.deps) };
  },
  /** Read model: specs plus the status of the task a planned spec became. */
  specs({ status = null, batch_id = null, planner_task_id = null, limit = 500 } = {}) {
    const where = [], params = [];
    if (status) { where.push('s.status=?'); params.push(status); }
    if (batch_id !== null && batch_id !== undefined) { where.push('s.batch_id=?'); params.push(batch_id); }
    if (planner_task_id !== null && planner_task_id !== undefined) { where.push('s.planner_task_id=?'); params.push(planner_task_id); }
    const rows = this.all(`SELECT s.*, t.status AS task_status, t.role AS task_role, t.name AS task_name
      FROM task_specs s LEFT JOIN tasks t ON t.id=s.task_id${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.id LIMIT ?`, ...params, limit);
    return rows.map(row => ({ ...row, deps: this.specDeps(row.deps) }));
  },
  specStats() {
    const stats = { pending: 0, planned: 0, dropped: 0 };
    for (const row of this.all('SELECT status, count(*) AS count FROM task_specs GROUP BY status')) stats[row.status] = row.count;
    return stats;
  },
  pendingSpecs(limit = 200) { return this.specs({ status: 'pending', limit }); },
  specsForBatch(batchId, limit = 200) { return this.specs({ batch_id: batchId, limit }); },
  specsByPlanner(plannerTaskId, limit = 200) { return this.specs({ planner_task_id: plannerTaskId, limit }); },
  /**
   * 下一条该编排的拆解：最老的、已经停止执行且**不需要等你批准**的 planner 写下的未编排 spec。
   * 批次边界是「谁写的」而不是「哪一刻写的」，所以 planner 还在跑（或还会被再调用）时它写的 spec 一条都不会被取走，
   * 一轮拆解只会形成一批；同一批里没有依赖边的 spec 因此在同一时刻开始并跑。
   * planner 停在 awaiting（等用户答复）也算这一轮结束：它已写好的条目不该被别人的答复卡住。
   * 例外：plan_gate='proposed' 表示 planner 自己觉得这轮拆解需要你先批准，这时一条都不取。
   */
  nextSpecPlanner() {
    const rows = this.all(`SELECT s.planner_task_id, count(*) AS count, min(s.id) AS first_spec_id
      FROM task_specs s JOIN tasks p ON p.id = s.planner_task_id
      WHERE s.status='pending' AND s.batch_id IS NULL AND p.layer='intent'
        AND (p.plan_gate IS NULL OR p.plan_gate='approved')
        AND p.status NOT IN (${[...EXECUTING].map(() => '?').join(',')})
      GROUP BY s.planner_task_id ORDER BY first_spec_id LIMIT 1`, ...EXECUTING);
    return rows[0] ?? null;
  },
  /**
   * Take the oldest unclaimed pending specs for a batch; callers that already hold a transaction use this directly.
   * plannerTaskId 把范围收窄到一个 planner 写的条目（正常路径都用它）；省略时按 id 取最老的，供人工/测试造批。
   */
  assignSpecs(batchId, limit, plannerTaskId = null) {
    const params = [];
    let where = "status='pending' AND batch_id IS NULL";
    if (plannerTaskId !== null && plannerTaskId !== undefined) {
      where += ' AND planner_task_id=?'; params.push(id(plannerTaskId));
    }
    const rows = this.all(`SELECT id FROM task_specs WHERE ${where} ORDER BY id LIMIT ?`, ...params, limit);
    for (const row of rows) this.run("UPDATE task_specs SET batch_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", batchId, row.id);
    return rows.map(row => this.spec(row.id));
  },
  takeSpecs(batchId, limit = 50) { return this.transaction(() => this.assignSpecs(batchId, limit)); },
  plannedSpec(specId, taskId) {
    this.run("UPDATE task_specs SET status='planned', task_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", taskId, id(specId));
    return this.spec(specId);
  },
  dropSpec(specId, note = null) {
    this.run("UPDATE task_specs SET status='dropped', note=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", note, id(specId));
    return this.spec(specId);
  },
  /** A cancelled scheduler gives its untouched specs back to the queue instead of losing them. */
  releaseBatch(batchId, note = null) {
    this.run("UPDATE task_specs SET batch_id=NULL, note=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE batch_id=? AND status='pending'", note, batchId);
    return this.specs({ status: 'pending' }).length;
  },
  /** A finished scheduler must account for every spec it was handed; the rest become dropped with a reason. */
  discardBatch(batchId, note = null) {
    this.run("UPDATE task_specs SET status='dropped', note=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE batch_id=? AND status='pending'", note, batchId);
  },
};
