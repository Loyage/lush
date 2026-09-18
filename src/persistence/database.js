/** One connection owned by the daemon event loop; transactions never await. */
import { Database as SQLite } from 'bun:sqlite';

/**
 * The current schema.
 *
 * `processes` are passive nodes: identity, permissions (`child_templates`),
 * variables and persistent state. They never run an agent themselves — the
 * work happens in `tasks`, each mounted on exactly one process. A `task` owns
 * one agent conversation (`agent_calls` / `messages`, both carrying the
 * `task_id` next to the `pid` they ran on) and may have child tasks, which is
 * what makes a task tree visible while it is being worked through the process
 * tree.
 *
 * Status sets match `core/lifecycle.js`: processes are `created / active /
 * stopped`, tasks are `created / running / waiting / completed / failed /
 * cancelled`.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS processes (
    pid INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_pid INTEGER REFERENCES processes(pid),
    original_parent_pid INTEGER REFERENCES processes(pid),
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('created','active','stopped')),
    template TEXT NOT NULL,
    template_snapshot TEXT NOT NULL,
    goal TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK((pid=0 AND parent_pid IS NULL AND original_parent_pid IS NULL)
       OR (pid>0 AND parent_pid IS NOT NULL AND original_parent_pid IS NOT NULL)),
    CHECK(parent_pid IS NULL OR parent_pid != pid)
);
CREATE INDEX IF NOT EXISTS process_parent ON processes(parent_pid);
CREATE TABLE IF NOT EXISTS contexts (
    pid INTEGER PRIMARY KEY REFERENCES processes(pid),
    system_prompt TEXT NOT NULL,
    state TEXT NOT NULL,
    artifacts TEXT NOT NULL,
    refs TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL REFERENCES processes(pid),
    parent_task_id INTEGER REFERENCES tasks(id),
    root_task_id INTEGER NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('created','running','waiting','completed','failed','cancelled')),
    result TEXT,
    error TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK(parent_task_id IS NULL OR parent_task_id != id)
);
CREATE INDEX IF NOT EXISTS tasks_pid ON tasks(pid, id);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id, id);
CREATE INDEX IF NOT EXISTS tasks_root ON tasks(root_task_id, id);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, id);
CREATE TABLE IF NOT EXISTS agent_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL REFERENCES processes(pid),
    task_id INTEGER REFERENCES tasks(id),
    prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted')),
    output TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS calls_pid ON agent_calls(pid, id);
CREATE INDEX IF NOT EXISTS calls_task ON agent_calls(task_id, id);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL REFERENCES processes(pid),
    task_id INTEGER REFERENCES tasks(id),
    call_id INTEGER NOT NULL REFERENCES agent_calls(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_pid ON messages(pid, id);
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, id);
CREATE TABLE IF NOT EXISTS process_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL REFERENCES processes(pid),
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_pid ON process_events(pid, id);
CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id);
PRAGMA user_version = 3;
`;

/**
 * v1 → v2: one process kind. Rows become `type='service'`, `cancelled`
 * collapses into `stopped`, and the row-level status CHECK stops depending on
 * the type. SQLite cannot drop a CHECK constraint, so the table is rebuilt in
 * place; foreign keys are switched off around the swap because every sibling
 * table references `processes` by name.
 */
const MIGRATION_V2 = `
CREATE TABLE processes_v2 (
    pid INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_pid INTEGER REFERENCES processes(pid),
    original_parent_pid INTEGER REFERENCES processes(pid),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type='service'),
    status TEXT NOT NULL CHECK(status IN ('created','running','stopped','failed','completed','reclaimed')),
    template TEXT NOT NULL,
    template_snapshot TEXT NOT NULL,
    goal TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK((pid=0 AND parent_pid IS NULL AND original_parent_pid IS NULL AND type='service')
       OR (pid>0 AND parent_pid IS NOT NULL AND original_parent_pid IS NOT NULL)),
    CHECK(parent_pid IS NULL OR parent_pid != pid)
);
INSERT INTO processes_v2
  (pid,parent_pid,original_parent_pid,name,type,status,template,template_snapshot,goal,created_at,updated_at)
  SELECT pid,parent_pid,original_parent_pid,name,'service',
         CASE status WHEN 'cancelled' THEN 'stopped' ELSE status END,
         template,template_snapshot,goal,created_at,updated_at
  FROM processes;
DROP TABLE processes;
ALTER TABLE processes_v2 RENAME TO processes;
CREATE INDEX IF NOT EXISTS process_parent ON processes(parent_pid);
PRAGMA user_version = 2;
`;

/**
 * v2 → v3: the task layer, and processes as passive nodes.
 *
 * `type` disappears (`service` and process are the same thing) and the process
 * status set collapses to created / active / stopped. Every historical agent
 * call becomes a root task, so old work stays readable as a task with the same
 * prompt, output and messages; processes that were completed / failed /
 * reclaimed are simply `stopped` now, because "done" is a fact about a task,
 * not about a node.
 */
const MIGRATION_V3 = `
CREATE TABLE processes_v3 (
    pid INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_pid INTEGER REFERENCES processes(pid),
    original_parent_pid INTEGER REFERENCES processes(pid),
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('created','active','stopped')),
    template TEXT NOT NULL,
    template_snapshot TEXT NOT NULL,
    goal TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK((pid=0 AND parent_pid IS NULL AND original_parent_pid IS NULL)
       OR (pid>0 AND parent_pid IS NOT NULL AND original_parent_pid IS NOT NULL)),
    CHECK(parent_pid IS NULL OR parent_pid != pid)
);
INSERT INTO processes_v3
  (pid,parent_pid,original_parent_pid,name,status,template,template_snapshot,goal,created_at,updated_at)
  SELECT pid,parent_pid,original_parent_pid,name,
         CASE status WHEN 'created' THEN 'created' WHEN 'stopped' THEN 'stopped' ELSE 'active' END,
         template,template_snapshot,goal,created_at,updated_at
  FROM processes;
DROP TABLE processes;
ALTER TABLE processes_v3 RENAME TO processes;
CREATE INDEX IF NOT EXISTS process_parent ON processes(parent_pid);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL REFERENCES processes(pid),
    parent_task_id INTEGER REFERENCES tasks(id),
    root_task_id INTEGER NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('created','running','waiting','completed','failed','cancelled')),
    result TEXT,
    error TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK(parent_task_id IS NULL OR parent_task_id != id)
);
CREATE INDEX IF NOT EXISTS tasks_pid ON tasks(pid, id);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id, id);
CREATE INDEX IF NOT EXISTS tasks_root ON tasks(root_task_id, id);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, id);
ALTER TABLE agent_calls ADD COLUMN task_id INTEGER REFERENCES tasks(id);
ALTER TABLE messages ADD COLUMN task_id INTEGER REFERENCES tasks(id);
CREATE INDEX IF NOT EXISTS calls_task ON agent_calls(task_id, id);
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, id);
CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id);
PRAGMA user_version = 3;
`;

/** One historical call → the root task it becomes in v3. */
const CALL_TASK_STATUS = {
  succeeded: 'completed', failed: 'failed', interrupted: 'cancelled', running: 'failed',
};

export class Database {
  constructor(file) {
    this.connection = new SQLite(file, { create: true });
    this.connection.exec('PRAGMA foreign_keys = ON');
    this.connection.exec('PRAGMA busy_timeout = 5000');
    this.connection.exec('PRAGMA journal_mode = WAL');
    const version = this.connection.query('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== 1 && version !== 2 && version !== 3) {
      this.close();
      throw new Error(`unsupported database schema: ${version}`);
    }
    if (version === 1) this.migrateV2();
    if (version === 1 || version === 2) this.migrateV3();
    this.connection.exec(SCHEMA);
  }

  /** Rebuild `processes` without the Task/Service split (see `MIGRATION_V2`). */
  migrateV2() {
    this.script(MIGRATION_V2);
  }

  /** Add the task layer to an older home (see `MIGRATION_V3`). */
  migrateV3() {
    this.script(MIGRATION_V3);
    this._adoptHistoricalCalls();
  }

  /**
   * A v2 home has agent calls but no tasks. Each call becomes a root task with
   * the same pid / prompt / output / window, and its messages are attached to
   * it, so `lush task list` and `lush task history` keep showing old work.
   */
  _adoptHistoricalCalls() {
    this.transaction(() => {
      const calls = this.connection.query('SELECT * FROM agent_calls WHERE task_id IS NULL ORDER BY id').all();
      for (const call of calls) {
        const status = CALL_TASK_STATUS[call.status] ?? 'failed';
        const finished = call.finished_at ?? call.started_at;
        let result = null;
        if (call.output !== null && call.output !== undefined) {
          try {
            result = JSON.stringify(call.output);
          } catch {
            result = null;
          }
        }
        const taskId = this.connection.run(
          `INSERT INTO tasks(pid,parent_task_id,root_task_id,goal,status,result,error,state,
                             created_at,started_at,finished_at,updated_at)
           VALUES(?,NULL,0,?,?,?,?,?,?,?,?,?)`,
          [call.pid, call.prompt, status, result, call.error ?? null, '{}',
            call.started_at, call.started_at, finished, finished],
        ).lastInsertRowid;
        this.connection.run('UPDATE tasks SET root_task_id=? WHERE id=?', [taskId, taskId]);
        this.connection.run('UPDATE agent_calls SET task_id=? WHERE id=?', [taskId, call.id]);
        this.connection.run('UPDATE messages SET task_id=? WHERE call_id=?', [taskId, call.id]);
      }
    });
  }

  /** Run one migration script body (no BEGIN/COMMIT of its own) with FKs off. */
  script(sql) {
    // Must be set outside a transaction, and back on before anyone else runs.
    this.connection.exec('PRAGMA foreign_keys = OFF');
    try {
      this.connection.exec(`BEGIN IMMEDIATE;${sql}COMMIT;`);
    } catch (err) {
      try {
        this.connection.exec('ROLLBACK');
      } catch {
        /* the transaction is already gone; the original error is what matters */
      }
      throw err;
    } finally {
      this.connection.exec('PRAGMA foreign_keys = ON');
    }
  }

  /** Run `fn` inside a synchronous BEGIN IMMEDIATE transaction. */
  transaction(fn) {
    this.connection.exec('BEGIN IMMEDIATE');
    let result;
    try {
      result = fn();
    } catch (err) {
      try {
        this.connection.exec('ROLLBACK');
      } catch {
        /* the transaction is already gone; the original error is what matters */
      }
      throw err;
    }
    this.connection.exec('COMMIT');
    return result;
  }

  close() {
    this.connection.close();
  }
}
