import fs from 'node:fs';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { check } from '../core/types.js';
import { assertPrivateFile } from './paths.js';

const SCHEMA = `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS administrator_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workers(
 id TEXT PRIMARY KEY,worker_number TEXT NOT NULL UNIQUE,name TEXT NOT NULL,mode TEXT NOT NULL,scope TEXT NOT NULL,
 status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 result TEXT,error TEXT,original_failure TEXT,stopped_at TEXT);
CREATE TABLE IF NOT EXISTS messages(
 id TEXT PRIMARY KEY,worker_id TEXT NOT NULL REFERENCES workers(id),client_request_id TEXT NOT NULL UNIQUE,
 instruction TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,
 result TEXT,error TEXT,original_failure TEXT,effect TEXT NOT NULL DEFAULT 'not_started');
CREATE UNIQUE INDEX IF NOT EXISTS one_active_input ON messages(worker_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS agent_runs(
 id TEXT PRIMARY KEY,worker_id TEXT NOT NULL REFERENCES workers(id),instruction_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
 status TEXT NOT NULL,token_hash TEXT,started_at TEXT NOT NULL,finished_at TEXT,error TEXT,original_failure TEXT);
CREATE TABLE IF NOT EXISTS confirmations(
 id TEXT PRIMARY KEY,binding_hash TEXT NOT NULL,definition TEXT NOT NULL,definition_hash TEXT NOT NULL,
 worker_revision INTEGER,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL,consumed_at TEXT,receipt TEXT,revoked_at TEXT);
CREATE INDEX IF NOT EXISTS confirmation_expiry ON confirmations(expires_at);
CREATE TABLE IF NOT EXISTS tool_calls(
 id TEXT PRIMARY KEY,worker_id TEXT NOT NULL REFERENCES workers(id),instruction_id TEXT NOT NULL REFERENCES messages(id),
 run_id TEXT NOT NULL REFERENCES agent_runs(id),request_key TEXT NOT NULL,operation TEXT NOT NULL,params TEXT NOT NULL,
 status TEXT NOT NULL,effect TEXT NOT NULL,result TEXT,error TEXT,original_failure TEXT,
 created_at TEXT NOT NULL,finished_at TEXT,UNIQUE(instruction_id,request_key));
CREATE TABLE IF NOT EXISTS events(
 id INTEGER PRIMARY KEY AUTOINCREMENT,worker_id TEXT REFERENCES workers(id),instruction_id TEXT,type TEXT NOT NULL,
 created_at TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_worker ON events(worker_id,id);
CREATE INDEX IF NOT EXISTS messages_worker ON messages(worker_id,created_at,id);
`;

/** Dedicated device authority. It never opens, binds or migrates any project's Store. */
export class AdministratorStore {
  constructor(file) {
    const existing = assertPrivateFile(file, { missing: true });
    if (!existing) fs.closeSync(fs.openSync(file, 'wx', 0o600));
    for (const suffix of ['-wal', '-shm']) assertPrivateFile(`${file}${suffix}`, { missing: true });
    this.db = new Database(file, { readwrite: true });
    try {
      if (existing) {
        check(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='administrator_meta'").get(), 'database is not an administrator service store');
        check(this.db.query("SELECT value FROM administrator_meta WHERE key='schema_version'").get()?.value === '1', 'unsupported administrator store version');
      }
      this.db.exec(SCHEMA);
      this.transaction(() => {
        if (!existing) {
          this.setMeta('schema_version', '1'); this.setMeta('service_id', randomUUID()); this.setMeta('worker_number_high', '0');
        }
      });
      this.serviceId = this.meta('service_id');
      check(typeof this.serviceId === 'string' && this.serviceId.length > 0, 'administrator store identity missing');
    } catch (error) { this.db.close(); throw error; }
  }
  get(sql, ...args) { return this.db.query(sql).get(...args); }
  all(sql, ...args) { return this.db.query(sql).all(...args); }
  run(sql, ...args) { return this.db.query(sql).run(...args); }
  transaction(fn) { return this.db.transaction(fn)(); }
  meta(key) { return this.get('SELECT value FROM administrator_meta WHERE key=?', key)?.value; }
  setMeta(key, value) { this.run('INSERT INTO administrator_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value)); }
  nextWorkerNumber() {
    const high = Number(this.meta('worker_number_high'));
    check(Number.isSafeInteger(high) && high >= 0 && high < Number.MAX_SAFE_INTEGER, 'administrator number limit reached');
    this.setMeta('worker_number_high', high + 1);
    return `ADM${high + 1}`;
  }
  worker(id) { const value = this.get('SELECT * FROM workers WHERE id=?', id); check(value, 'administrator Worker not found'); return value; }
  instruction(id) { const value = this.get('SELECT * FROM messages WHERE id=?', id); check(value, 'administrator instruction not found'); return value; }
  event(workerId, instructionId, type, data, now) {
    return Number(this.run('INSERT INTO events(worker_id,instruction_id,type,created_at,data) VALUES (?,?,?,?,?)', workerId, instructionId, type, now, JSON.stringify(data)).lastInsertRowid);
  }
  close() { this.db.close(); }
}
