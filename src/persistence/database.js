/** One connection owned by the daemon event loop; transactions never await. */
import { Database as SQLite } from 'bun:sqlite';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS processes (
    pid INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_pid INTEGER REFERENCES processes(pid),
    original_parent_pid INTEGER REFERENCES processes(pid),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('service','task')),
    status TEXT NOT NULL CHECK(
      (type='service' AND status IN ('created','running','stopped','failed')) OR
      (type='task' AND status IN ('created','running','completed','failed','cancelled','reclaimed'))
    ),
    template TEXT NOT NULL,
    template_snapshot TEXT NOT NULL,
    goal TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK((pid=0 AND parent_pid IS NULL AND original_parent_pid IS NULL AND type='service')
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
CREATE TABLE IF NOT EXISTS agent_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL REFERENCES processes(pid),
    prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted')),
    output TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS calls_pid ON agent_calls(pid, id);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL REFERENCES processes(pid),
    call_id INTEGER NOT NULL REFERENCES agent_calls(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_pid ON messages(pid, id);
CREATE TABLE IF NOT EXISTS process_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL REFERENCES processes(pid),
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_pid ON process_events(pid, id);
PRAGMA user_version = 1;
`;

export class Database {
  constructor(file) {
    this.connection = new SQLite(file, { create: true });
    this.connection.exec('PRAGMA foreign_keys = ON');
    this.connection.exec('PRAGMA busy_timeout = 5000');
    this.connection.exec('PRAGMA journal_mode = WAL');
    const version = this.connection.query('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== 1) {
      this.close();
      throw new Error(`unsupported database schema: ${version}`);
    }
    this.connection.exec(SCHEMA);
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
