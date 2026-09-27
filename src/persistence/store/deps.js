/** 依赖边（ap_deps）的读写与结构遍历。 */
export const deps = {
  addDep(apId, dependsOn, kind) {
    this.run('INSERT INTO ap_deps(ap_id,depends_on,kind) VALUES (?,?,?)', apId, dependsOn, kind);
  },
  deps(apId) { return this.all('SELECT depends_on, kind FROM ap_deps WHERE ap_id=? ORDER BY depends_on', apId); },
  dependents(apId) { return this.all('SELECT ap_id, kind FROM ap_deps WHERE depends_on=? ORDER BY ap_id', apId); },
  depsDetail(apId) {
    return this.all(`SELECT d.depends_on AS id, d.kind, t.role, t.status, t.integration, substr(t.goal,1,200) AS goal
      FROM ap_deps d JOIN aps t ON t.id=d.depends_on WHERE d.ap_id=? ORDER BY d.depends_on`, apId);
  },
  dependentsDetail(apId) {
    return this.all(`SELECT d.ap_id AS id, d.kind, t.role, t.status, substr(t.goal,1,200) AS goal
      FROM ap_deps d JOIN aps t ON t.id=d.ap_id WHERE d.depends_on=? ORDER BY d.ap_id`, apId);
  },
  /** 这些 AP 的依赖边：时间轴画执行等待，交付队列只把其中的 code 边当合并约束。 */
  edgesOf(apIds) {
    if (!apIds.length) return [];
    const holes = apIds.map(() => '?').join(',');
    return this.all(`SELECT ap_id, depends_on, kind FROM ap_deps WHERE ap_id IN (${holes}) ORDER BY ap_id, depends_on`, ...apIds);
  },
  /** One query for a read model: AP id -> edges carrying the upstream status. */
  depMap(apIds = null) {
    if (Array.isArray(apIds) && !apIds.length) return new Map();
    const where = Array.isArray(apIds) ? ` WHERE d.ap_id IN (${apIds.map(() => '?').join(',')})` : '';
    const map = new Map();
    for (const row of this.all(`SELECT d.ap_id, d.depends_on AS id, d.kind, t.status
      FROM ap_deps d JOIN aps t ON t.id=d.depends_on${where} ORDER BY d.ap_id, d.depends_on`, ...(apIds || []))) {
      if (!map.has(row.ap_id)) map.set(row.ap_id, []);
      map.get(row.ap_id).push({ id: row.id, kind: row.kind, status: row.status });
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
