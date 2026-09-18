/**
 * One connection owned by the daemon event loop; transactions never await.
 *
 * The class decides *when* to run which DDL: a fresh home gets `SCHEMA`, an
 * older one is walked forward by the migration scripts (v1 → v8), and the
 * one interpretive step — turning pre-task agent calls into root tasks — lives
 * at the bottom of this file because it reads rows, not just DDL.
 */
import { Database as SQLite } from 'bun:sqlite';
import { CALL_TASK_STATUS, MIGRATION_V2, MIGRATION_V3, MIGRATION_V4, MIGRATION_V5, MIGRATION_V6, MIGRATION_V7, MIGRATION_V8, SCHEMA } from './schema.js';

export class Database {
  constructor(file) {
    this.connection = new SQLite(file, { create: true });
    this.connection.exec('PRAGMA foreign_keys = ON');
    this.connection.exec('PRAGMA busy_timeout = 5000');
    this.connection.exec('PRAGMA journal_mode = WAL');
    const version = this.connection.query('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7 && version !== 8) {
      this.close();
      throw new Error(`unsupported database schema: ${version}`);
    }
    if (version === 1) this.migrateV2();
    if (version === 1 || version === 2) this.migrateV3();
    if (version === 1 || version === 2 || version === 3) this.migrateV4();
    if (version === 1 || version === 2 || version === 3 || version === 4) this.migrateV5();
    if (version >= 1 && version <= 5) this.migrateV6();
    if (version >= 1 && version <= 6) this.migrateV7();
    if (version >= 1 && version <= 7) this.migrateV8();
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

  /** Rename the persisted logical process entity to the service entity. */
  migrateV4() {
    this.script(MIGRATION_V4);
  }

  /** Rename service identifiers from PID terminology to SID terminology. */
  migrateV5() {
    this.script(MIGRATION_V5);
  }

  /** Add the notice channel (see `MIGRATION_V6`). */
  migrateV6() {
    this.script(MIGRATION_V6);
  }

  /** Add the task inbox (see `MIGRATION_V7`). */
  migrateV7() {
    this.script(MIGRATION_V7);
  }

  /** Index the outbound side of the inbox, for the chain view (see `MIGRATION_V8`). */
  migrateV8() {
    this.script(MIGRATION_V8);
  }

  /**
   * A v2 home has agent calls but no tasks. Each call becomes a root task with
   * the same sid / prompt / output / window, and its messages are attached to
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
