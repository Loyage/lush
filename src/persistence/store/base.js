import { Database } from 'bun:sqlite';
import { SCHEMA, bindProject } from './schema.js';

/**
 * 加列式 schema 演进：只给已有的表补缺失的可空列，不改类型、不重写任何行。
 * `CREATE TABLE IF NOT EXISTS` 管不了早就建好的表，所以每个后来加的列都要在这里登记一次。
 */
const ADDED_COLUMNS = {
  inputs: ['anchor_branch', 'anchor_commit', 'anchor_workspace', 'anchor_target_branch'],
  branches: ['summary', 'showcase_reservation'],
  tasks: ['review_candidate_id', 'progress_plan', 'showcase', 'retry_profile'],
  agent_runs: ['model', 'thinking'],
};
function addMissingColumns(db) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const present = new Set(db.query(`PRAGMA table_info(${table})`).all().map(row => row.name));
    for (const column of columns) if (!present.has(column)) db.query(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`).run();
  }
}

/** 打开数据库、事务与 id 分配。 */
export class StoreBase {
  constructor(file, project) {
    this.db = new Database(file, { create: true });
    this.db.exec(SCHEMA);
    bindProject(this.db, project);
    addMissingColumns(this.db);
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
  /**
   * 输入 id 同样只往大走，理由更强：锚点的分支名与检出目录名里带着 input id
   * （`input-<id>`），复用 id 会让新输入撞上保留下来的旧目录。
   * 输入行要等锚点建好才写，所以这个 id 必须能在 INSERT 之前就分配出来。
   */
  inputIdHigh() { return Number(this.get("SELECT value FROM meta WHERE key='input_id_high'")?.value ?? 0); }
  setInputIdHigh(value) {
    this.run("INSERT INTO meta(key,value) VALUES ('input_id_high',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(value));
  }
  nextInputId() {
    const next = Math.max(this.inputIdHigh(), this.get('SELECT COALESCE(MAX(id),0) AS value FROM inputs').value) + 1;
    this.setInputIdHigh(next);
    return next;
  }
}
