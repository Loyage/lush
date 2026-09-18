import { Database } from 'bun:sqlite';
import { check, id, bounded } from '../core/types.js';

export class Store {
  constructor(file, project) {
    this.db = new Database(file, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- flow: 'develop'=要改代码, 'explain'=只了解；NULL 表示 planner 还没判定，按 develop 处理。
      CREATE TABLE IF NOT EXISTS inputs (
        id INTEGER PRIMARY KEY, content TEXT NOT NULL, task_id INTEGER, flow TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      -- 用户输入先落成草稿；input_id IS NULL 表示还没提交。提交时整批拼成一条 inputs。
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY, content TEXT NOT NULL, input_id INTEGER REFERENCES inputs(id),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS drafts_open ON drafts(input_id);
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES tasks(id), input_id INTEGER REFERENCES inputs(id),
        role TEXT NOT NULL, goal TEXT NOT NULL, name TEXT, status TEXT NOT NULL DEFAULT 'queued',
        result TEXT, error TEXT, calls INTEGER NOT NULL DEFAULT 0,
        agent_wakes INTEGER NOT NULL DEFAULT 0, agent_token_hash TEXT, agent_last_seen_at TEXT,
        workspace TEXT, branch TEXT, base_commit TEXT, head_commit TEXT,
        integration TEXT NOT NULL DEFAULT 'none', target_branch TEXT, integration_error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
      -- 依赖边只在 spawn 时写入，之后不可变。kind: code=从上游分支继续, order=只等它结束。
      CREATE TABLE IF NOT EXISTS task_deps (
        task_id INTEGER NOT NULL REFERENCES tasks(id), depends_on INTEGER NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL CHECK (kind IN ('code','order')), PRIMARY KEY (task_id, depends_on));
      CREATE INDEX IF NOT EXISTS task_deps_reverse ON task_deps(depends_on);
      -- 拆解队列：planner 只往这里写条目，scheduler 串行批量编排后才产生真实任务。
      CREATE TABLE IF NOT EXISTS task_specs (
        id INTEGER PRIMARY KEY, input_id INTEGER REFERENCES inputs(id),
        planner_task_id INTEGER NOT NULL REFERENCES tasks(id), batch_id INTEGER,
        seq INTEGER NOT NULL, goal TEXT NOT NULL, role TEXT, name TEXT,
        deps TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending',
        task_id INTEGER, note TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS task_specs_status ON task_specs(status);
      CREATE INDEX IF NOT EXISTS task_specs_batch ON task_specs(batch_id);
      CREATE INDEX IF NOT EXISTS task_specs_planner ON task_specs(planner_task_id);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), sender_id INTEGER REFERENCES tasks(id),
        body TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE IF NOT EXISTS notices (
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), title TEXT NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', answer TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, task_id INTEGER REFERENCES tasks(id), type TEXT NOT NULL, data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, consumed);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);`);
    // Agent identity columns arrived after the first release; an existing project.db predates them.
    // The index over agent_token_hash must wait for the columns it references.
    const columns = new Set(this.all('PRAGMA table_info(tasks)').map(row => row.name));
    for (const [name, type] of [['name', 'TEXT'], ['agent_wakes', 'INTEGER NOT NULL DEFAULT 0'], ['agent_token_hash', 'TEXT'], ['agent_last_seen_at', 'TEXT']]) {
      if (!columns.has(name)) this.run(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    }
    this.run('CREATE INDEX IF NOT EXISTS tasks_agent_token ON tasks(agent_token_hash)');
    // 两类输入的判定列晚于首个 release；既有库需要补列。
    const inputColumns = new Set(this.all('PRAGMA table_info(inputs)').map(row => row.name));
    if (!inputColumns.has('flow')) this.run('ALTER TABLE inputs ADD COLUMN flow TEXT');
    const binding = this.get('SELECT value FROM meta WHERE key=?', 'project');
    if (binding && binding.value !== project) { this.close(); throw new Error('database belongs to another project'); }
    this.run('INSERT OR IGNORE INTO meta VALUES (?,?)', 'project', project);
  }
  run(sql, ...params) { return this.db.query(sql).run(...params); }
  get(sql, ...params) { return this.db.query(sql).get(...params); }
  all(sql, ...params) { return this.db.query(sql).all(...params); }
  transaction(fn) { return this.db.transaction(fn)(); }
  close() { this.db.close(); }
  /** Highest task id ever handed out, kept in meta so a cleared project never reuses an id. */
  taskIdHigh() { return Number(this.get("SELECT value FROM meta WHERE key='task_id_high'")?.value ?? 0); }
  setTaskIdHigh(value) {
    this.run("INSERT INTO meta(key,value) VALUES ('task_id_high',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(value));
  }
  /** Ids are never recycled: worktree directories, branches and pi sessions outlive the rows that named them. */
  nextTaskId() {
    const next = Math.max(this.taskIdHigh(), this.get('SELECT COALESCE(MAX(id),0) AS value FROM tasks').value) + 1;
    this.setTaskIdHigh(next);
    return next;
  }
  task(taskId) {
    const task = this.get('SELECT * FROM tasks WHERE id=?', id(taskId));
    check(task, `task ${taskId} not found`);
    return task;
  }
  tasks() { return this.all('SELECT * FROM tasks ORDER BY id'); }
  /** deps is stored as JSON text; every read model hands callers the parsed array. */
  specDeps(raw) {
    try { const value = JSON.parse(raw ?? '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
  }
  addSpec({ input_id = null, planner_task_id, goal, role = null, name = null, deps = [] }) {
    const seq = this.get('SELECT COALESCE(MAX(seq),0) AS value FROM task_specs WHERE planner_task_id=?', planner_task_id).value + 1;
    const row = this.run('INSERT INTO task_specs(input_id,planner_task_id,seq,goal,role,name,deps) VALUES (?,?,?,?,?,?,?)',
      input_id, planner_task_id, seq, goal, role, name, JSON.stringify(deps));
    return this.spec(Number(row.lastInsertRowid));
  }
  spec(specId) {
    const row = this.get('SELECT * FROM task_specs WHERE id=?', id(specId));
    check(row, `spec ${specId} not found`);
    return { ...row, deps: this.specDeps(row.deps) };
  }
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
  }
  specStats() {
    const stats = { pending: 0, planned: 0, dropped: 0 };
    for (const row of this.all('SELECT status, count(*) AS count FROM task_specs GROUP BY status')) stats[row.status] = row.count;
    return stats;
  }
  pendingSpecs(limit = 200) { return this.specs({ status: 'pending', limit }); }
  specsForBatch(batchId, limit = 200) { return this.specs({ batch_id: batchId, limit }); }
  specsByPlanner(plannerTaskId, limit = 200) { return this.specs({ planner_task_id: plannerTaskId, limit }); }
  /** Take the oldest pending specs for a batch; callers that already hold a transaction use this directly. */
  assignSpecs(batchId, limit) {
    const rows = this.all("SELECT id FROM task_specs WHERE status='pending' ORDER BY id LIMIT ?", limit);
    for (const row of rows) this.run("UPDATE task_specs SET batch_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", batchId, row.id);
    return rows.map(row => this.spec(row.id));
  }
  takeSpecs(batchId, limit = 50) { return this.transaction(() => this.assignSpecs(batchId, limit)); }
  plannedSpec(specId, taskId) {
    this.run("UPDATE task_specs SET status='planned', task_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", taskId, id(specId));
    return this.spec(specId);
  }
  dropSpec(specId, note = null) {
    this.run("UPDATE task_specs SET status='dropped', note=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", note, id(specId));
    return this.spec(specId);
  }
  /** A cancelled scheduler gives its untouched specs back to the queue instead of losing them. */
  releaseBatch(batchId, note = null) {
    this.run("UPDATE task_specs SET batch_id=NULL, note=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE batch_id=? AND status='pending'", note, batchId);
    return this.specs({ status: 'pending' }).length;
  }
  /** A finished scheduler must account for every spec it was handed; the rest become dropped with a reason. */
  discardBatch(batchId, note = null) {
    this.run("UPDATE task_specs SET status='dropped', note=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE batch_id=? AND status='pending'", note, batchId);
  }
  summaries() {
    return this.all(`SELECT id,parent_id,input_id,role,substr(goal,1,200) AS goal,status,integration,updated_at,
      agent_wakes,agent_last_seen_at FROM tasks ORDER BY id`);
  }
  /** Tasks the scheduler may still touch: a clear has to wait for all of them. */
  activeTasks() {
    return this.all("SELECT id,status FROM tasks WHERE status NOT IN ('completed','failed','cancelled') ORDER BY id");
  }
  /**
   * Project-level reset: drops every task-scoped row plus the input audit trail.
   * Only Project#clear calls this, and only after proving no task is active and no
   * invocation is still unwinding. Disk state (worktrees, branches, sessions) is not touched,
   * which is why nextTaskId() is pinned first: the retained names must stay unambiguous.
   */
  purge() {
    const counts = {};
    return this.transaction(() => {
      this.setTaskIdHigh(Math.max(this.taskIdHigh(), this.get('SELECT COALESCE(MAX(id),0) AS value FROM tasks').value));
      // Children of tasks/inputs go first; foreign keys are on, so the order is not decorative.
      for (const table of ['task_specs','messages','notices','task_deps','events','tasks','drafts','inputs']) {
        counts[table] = this.get(`SELECT count(*) AS value FROM ${table}`).value;
        this.run(`DELETE FROM ${table}`);
      }
      return counts;
    });
  }
  /** Credentials exist only while their invocation runs; Project#actor is the only reader. */
  armAgent(taskId, hash) { this.run('UPDATE tasks SET agent_token_hash=? WHERE id=?', hash, taskId); }
  /** Last authenticated agent contact; deliberately does not touch updated_at, so it never reorders the tree. */
  touchAgent(taskId) { this.run("UPDATE tasks SET agent_last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", taskId); }
  agentByToken(hash) { return this.get('SELECT * FROM tasks WHERE agent_token_hash=?', hash); }
  children(taskId) { return this.all('SELECT * FROM tasks WHERE parent_id=? ORDER BY id', taskId); }
  addDraft(content) {
    const row = this.run('INSERT INTO drafts(content) VALUES (?)', content);
    return this.get('SELECT * FROM drafts WHERE id=?', Number(row.lastInsertRowid));
  }
  draft(draftId) {
    const draft = this.get('SELECT * FROM drafts WHERE id=?', id(draftId));
    check(draft, `draft ${draftId} not found`);
    return draft;
  }
  /** Buffered drafts in input order; submitted ones keep their input_id as the audit link. */
  openDrafts() { return this.all('SELECT * FROM drafts WHERE input_id IS NULL ORDER BY id'); }
  draftCount() { return this.get('SELECT count(*) AS n FROM drafts WHERE input_id IS NULL').n; }
  addDep(taskId, dependsOn, kind) {
    this.run('INSERT INTO task_deps(task_id,depends_on,kind) VALUES (?,?,?)', taskId, dependsOn, kind);
  }
  deps(taskId) { return this.all('SELECT depends_on, kind FROM task_deps WHERE task_id=? ORDER BY depends_on', taskId); }
  dependents(taskId) { return this.all('SELECT task_id, kind FROM task_deps WHERE depends_on=? ORDER BY task_id', taskId); }
  depsDetail(taskId) {
    return this.all(`SELECT d.depends_on AS id, d.kind, t.role, t.status, t.integration, substr(t.goal,1,200) AS goal
      FROM task_deps d JOIN tasks t ON t.id=d.depends_on WHERE d.task_id=? ORDER BY d.depends_on`, taskId);
  }
  dependentsDetail(taskId) {
    return this.all(`SELECT d.task_id AS id, d.kind, t.role, t.status, substr(t.goal,1,200) AS goal
      FROM task_deps d JOIN tasks t ON t.id=d.task_id WHERE d.depends_on=? ORDER BY d.task_id`, taskId);
  }
  /** One query for the whole read model: task id -> edges carrying the upstream status. */
  depMap() {
    const map = new Map();
    for (const row of this.all(`SELECT d.task_id, d.depends_on AS id, d.kind, t.status
      FROM task_deps d JOIN tasks t ON t.id=d.depends_on ORDER BY d.task_id, d.depends_on`)) {
      if (!map.has(row.task_id)) map.set(row.task_id, []);
      map.get(row.task_id).push({ id: row.id, kind: row.kind, status: row.status });
    }
    return map;
  }
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
  }
  update(taskId, patch) {
    const allowed = ['status','result','error','calls','agent_wakes','workspace','branch','base_commit','head_commit','integration','target_branch','integration_error'];
    check(Object.keys(patch).every(key => allowed.includes(key)), 'invalid task patch');
    this.run(`UPDATE tasks SET ${Object.keys(patch).map(key => `${key}=?`).join(',')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`, ...Object.values(patch), taskId);
    return this.task(taskId);
  }
  /** name is the task's own short slug; it is written once at spawn and never edited, so a worktree keeps its name. */
  create({ parent_id = null, input_id, role, goal, name = null }) {
    const taskId = this.nextTaskId();
    this.run('INSERT INTO tasks(id,parent_id,input_id,role,goal,name) VALUES (?,?,?,?,?,?)', taskId, parent_id, input_id, role, goal, name);
    const task = this.task(taskId);
    this.event(task.id, 'created', { parent_id, role, goal, name });
    return task;
  }
  event(taskId, type, data) { this.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', taskId, type, JSON.stringify(data)); }
  message(taskId, body, sender = null) { this.run('INSERT INTO messages(task_id,sender_id,body) VALUES (?,?,?)', taskId, sender, body); }
  unread(taskId) { return this.all('SELECT * FROM messages WHERE task_id=? AND consumed=0 ORDER BY id', taskId); }
  history(taskId, after = 0) {
    return bounded(this.all('SELECT * FROM events WHERE task_id=? AND id>? ORDER BY id LIMIT 100', taskId, after).map(row => ({ ...row, data: JSON.parse(row.data) })), 900000);
  }
}
