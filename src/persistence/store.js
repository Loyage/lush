import { Database } from 'bun:sqlite';
import { check, id, bounded } from '../core/types.js';

export class Store {
  constructor(file, project) {
    this.db = new Database(file, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inputs (
        id INTEGER PRIMARY KEY, content TEXT NOT NULL, task_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      -- 用户输入先落成草稿；input_id IS NULL 表示还没提交。提交时整批拼成一条 inputs。
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY, content TEXT NOT NULL, input_id INTEGER REFERENCES inputs(id),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS drafts_open ON drafts(input_id);
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES tasks(id), input_id INTEGER REFERENCES inputs(id),
        role TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        result TEXT, error TEXT, calls INTEGER NOT NULL DEFAULT 0,
        workspace TEXT, branch TEXT, base_commit TEXT, head_commit TEXT,
        integration TEXT NOT NULL DEFAULT 'none', target_branch TEXT, integration_error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
      -- 依赖边只 writable-at-create：spawn 时写入，之后不可变。kind: code=从上游分支继续, order=只等它结束。
      CREATE TABLE IF NOT EXISTS task_deps (
        task_id INTEGER NOT NULL REFERENCES tasks(id), depends_on INTEGER NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL CHECK (kind IN ('code','order')), PRIMARY KEY (task_id, depends_on));
      CREATE INDEX IF NOT EXISTS task_deps_reverse ON task_deps(depends_on);
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
    const binding = this.get('SELECT value FROM meta WHERE key=?', 'project');
    if (binding && binding.value !== project) { this.close(); throw new Error('database belongs to another project'); }
    this.run('INSERT OR IGNORE INTO meta VALUES (?,?)', 'project', project);
  }
  run(sql, ...params) { return this.db.query(sql).run(...params); }
  get(sql, ...params) { return this.db.query(sql).get(...params); }
  all(sql, ...params) { return this.db.query(sql).all(...params); }
  transaction(fn) { return this.db.transaction(fn)(); }
  close() { this.db.close(); }
  task(taskId) {
    const task = this.get('SELECT * FROM tasks WHERE id=?', id(taskId));
    check(task, `task ${taskId} not found`);
    return task;
  }
  tasks() { return this.all('SELECT * FROM tasks ORDER BY id'); }
  summaries() {
    return this.all('SELECT id,parent_id,input_id,role,substr(goal,1,200) AS goal,status,integration,updated_at FROM tasks ORDER BY id');
  }
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
    const allowed = ['status','result','error','calls','workspace','branch','base_commit','head_commit','integration','target_branch','integration_error'];
    check(Object.keys(patch).every(key => allowed.includes(key)), 'invalid task patch');
    this.run(`UPDATE tasks SET ${Object.keys(patch).map(key => `${key}=?`).join(',')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`, ...Object.values(patch), taskId);
    return this.task(taskId);
  }
  create({ parent_id = null, input_id, role, goal }) {
    const row = this.run('INSERT INTO tasks(parent_id,input_id,role,goal) VALUES (?,?,?,?)', parent_id, input_id, role, goal);
    const task = this.task(Number(row.lastInsertRowid));
    this.event(task.id, 'created', { parent_id, role, goal });
    return task;
  }
  event(taskId, type, data) { this.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', taskId, type, JSON.stringify(data)); }
  message(taskId, body, sender = null) { this.run('INSERT INTO messages(task_id,sender_id,body) VALUES (?,?,?)', taskId, sender, body); }
  unread(taskId) { return this.all('SELECT * FROM messages WHERE task_id=? AND consumed=0 ORDER BY id', taskId); }
  history(taskId, after = 0) {
    return bounded(this.all('SELECT * FROM events WHERE task_id=? AND id>? ORDER BY id LIMIT 100', taskId, after).map(row => ({ ...row, data: JSON.parse(row.data) })), 900000);
  }
}
