import { Database } from 'bun:sqlite';
import { SCHEMA, bindProject } from './schema.js';

/** 打开数据库、事务与 id 分配。 */
export class StoreBase {
  constructor(file, project) {
    this.db = new Database(file, { create: true });
    this.db.exec(SCHEMA);
    bindProject(this.db, project);
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
}
