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
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES tasks(id), input_id INTEGER REFERENCES inputs(id),
        role TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        result TEXT, error TEXT, calls INTEGER NOT NULL DEFAULT 0,
        agent_wakes INTEGER NOT NULL DEFAULT 0, agent_token_hash TEXT, agent_last_seen_at TEXT,
        workspace TEXT, branch TEXT, base_commit TEXT, head_commit TEXT,
        integration TEXT NOT NULL DEFAULT 'none', target_branch TEXT, integration_error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
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
    for (const [name, type] of [['agent_wakes', 'INTEGER NOT NULL DEFAULT 0'], ['agent_token_hash', 'TEXT'], ['agent_last_seen_at', 'TEXT']]) {
      if (!columns.has(name)) this.run(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    }
    this.run('CREATE INDEX IF NOT EXISTS tasks_agent_token ON tasks(agent_token_hash)');
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
    return this.all(`SELECT id,parent_id,input_id,role,substr(goal,1,200) AS goal,status,integration,updated_at,
      agent_wakes,agent_last_seen_at FROM tasks ORDER BY id`);
  }
  /** Credentials exist only while their invocation runs; Project#actor is the only reader. */
  armAgent(taskId, hash) { this.run('UPDATE tasks SET agent_token_hash=? WHERE id=?', hash, taskId); }
  /** Last authenticated agent contact; deliberately does not touch updated_at, so it never reorders the tree. */
  touchAgent(taskId) { this.run("UPDATE tasks SET agent_last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", taskId); }
  agentByToken(hash) { return this.get('SELECT * FROM tasks WHERE agent_token_hash=?', hash); }
  children(taskId) { return this.all('SELECT * FROM tasks WHERE parent_id=? ORDER BY id', taskId); }
  update(taskId, patch) {
    const allowed = ['status','result','error','calls','agent_wakes','workspace','branch','base_commit','head_commit','integration','target_branch','integration_error'];
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
