/** 依赖边（task_deps）的读写与结构遍历。 */
export const deps = {
  addDep(taskId, dependsOn, kind) {
    this.run('INSERT INTO task_deps(task_id,depends_on,kind) VALUES (?,?,?)', taskId, dependsOn, kind);
  },
  deps(taskId) { return this.all('SELECT depends_on, kind FROM task_deps WHERE task_id=? ORDER BY depends_on', taskId); },
  dependents(taskId) { return this.all('SELECT task_id, kind FROM task_deps WHERE depends_on=? ORDER BY task_id', taskId); },
  depsDetail(taskId) {
    return this.all(`SELECT d.depends_on AS id, d.kind, t.role, t.status, t.integration, substr(t.goal,1,200) AS goal
      FROM task_deps d JOIN tasks t ON t.id=d.depends_on WHERE d.task_id=? ORDER BY d.depends_on`, taskId);
  },
  dependentsDetail(taskId) {
    return this.all(`SELECT d.task_id AS id, d.kind, t.role, t.status, substr(t.goal,1,200) AS goal
      FROM task_deps d JOIN tasks t ON t.id=d.task_id WHERE d.depends_on=? ORDER BY d.task_id`, taskId);
  },
  /** 这些任务的依赖边：时间轴与合并阶梯都要画"在等谁"。 */
  edgesOf(taskIds) {
    if (!taskIds.length) return [];
    const holes = taskIds.map(() => '?').join(',');
    return this.all(`SELECT task_id, depends_on, kind FROM task_deps WHERE task_id IN (${holes}) ORDER BY task_id, depends_on`, ...taskIds);
  },
  /** One query for the whole read model: task id -> edges carrying the upstream status. */
  depMap() {
    const map = new Map();
    for (const row of this.all(`SELECT d.task_id, d.depends_on AS id, d.kind, t.status
      FROM task_deps d JOIN tasks t ON t.id=d.depends_on ORDER BY d.task_id, d.depends_on`)) {
      if (!map.has(row.task_id)) map.set(row.task_id, []);
      map.get(row.task_id).push({ id: row.id, kind: row.kind, status: row.status });
    }
    return map;
  },
  /** Does `from` depend transitively on `target`? Walks depends_on edges. */
  reaches(from, target) {
    const seen = new Set(); const queue = [from];
    while (queue.length) {
      const current = queue.shift();
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const edge of this.deps(current)) queue.push(edge.depends_on);
    }
    return false;
  },
};
