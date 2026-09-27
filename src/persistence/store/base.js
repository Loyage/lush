import { Database } from 'bun:sqlite';
import { SCHEMA, bindProject } from './schema.js';

/**
 * 加列式 schema 演进：只给已有的表补缺失的可空列，不改类型、不重写任何行。
 * `CREATE TABLE IF NOT EXISTS` 管不了早就建好的表，所以每个后来加的列都要在这里登记一次。
 */
const ADDED_COLUMNS = {
  inputs: ['anchor_branch', 'anchor_commit', 'anchor_workspace', 'anchor_target_branch'],
  branches: ['summary', 'showcase_reservation', 'merge_run'],
  messages: ['signal_type', 'signal_key'],
  aps: ['review_candidate_id', 'progress_plan', 'showcase', 'retry_profile', 'ap_kind', 'reservation'],
  agent_runs: ['model', 'thinking'],
};
function addMissingColumns(db) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const present = new Set(db.query(`PRAGMA table_info(${table})`).all().map(row => row.name));
    for (const column of columns) if (!present.has(column)) db.query(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`).run();
  }
  // Old free-text messages have NULL keys, so a partial unique index adds no new restriction to history.
  db.query(`CREATE UNIQUE INDEX IF NOT EXISTS messages_signal_once ON messages(ap_id,sender_id,signal_key)
    WHERE signal_key IS NOT NULL`).run();
  db.query(`CREATE UNIQUE INDEX IF NOT EXISTS aps_new_branch_owner ON aps(branch)
    WHERE ap_kind IN ('main','say','owner') AND branch IS NOT NULL`).run();
}

/** 打开数据库、事务与 id 分配。 */
export class StoreBase {
  constructor(file, project) {
    this.db = new Database(file, { create: true });
    // 改名为 AP 后不再读旧 task schema：不迁移、不覆盖旧数据，只明确告诉用户这个库已经过时。
    const legacy = this.db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'`).get();
    if (legacy) { this.db.close(); throw new Error('database uses the retired task schema; start a fresh project instead of reading it'); }
    this.db.exec(SCHEMA);
    bindProject(this.db, project);
    addMissingColumns(this.db);
  }
  run(sql, ...params) { return this.db.query(sql).run(...params); }
  get(sql, ...params) { return this.db.query(sql).get(...params); }
  all(sql, ...params) { return this.db.query(sql).all(...params); }
  transaction(fn) { return this.db.transaction(fn)(); }
  close() { this.db.close(); }
  /** Highest AP id ever handed out, kept in meta so a cleared project never reuses an id. */
  apIdHigh() { return Number(this.get("SELECT value FROM meta WHERE key='ap_id_high'")?.value ?? 0); }
  setAPIdHigh(value) {
    this.run("INSERT INTO meta(key,value) VALUES ('ap_id_high',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(value));
  }
  /** Ids are never recycled: worktree directories, branches and pi sessions outlive the rows that named them. */
  nextAPId() {
    const next = Math.max(this.apIdHigh(), this.get('SELECT COALESCE(MAX(id),0) AS value FROM aps').value) + 1;
    this.setAPIdHigh(next);
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
