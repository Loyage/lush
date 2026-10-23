import fs from 'node:fs';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { check } from '../core/types.js';
import { assertPrivateFile } from './paths.js';

const SCHEMA = `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workers(id TEXT PRIMARY KEY,worker_number TEXT NOT NULL UNIQUE,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,
 profile TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,result TEXT,error TEXT,stopped_at TEXT);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,worker_id TEXT NOT NULL REFERENCES workers(id),client_request_id TEXT NOT NULL UNIQUE,
 definition TEXT NOT NULL,definition_hash TEXT NOT NULL,binding_hash TEXT NOT NULL,instruction TEXT NOT NULL,profile TEXT NOT NULL,
 status TEXT NOT NULL,effect TEXT NOT NULL DEFAULT 'not_started',created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,result TEXT,error TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS active_input ON messages(worker_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS agent_runs(id TEXT PRIMARY KEY,worker_id TEXT NOT NULL REFERENCES workers(id),instruction_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
 status TEXT NOT NULL,token_hash TEXT,started_at TEXT NOT NULL,finished_at TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS tool_calls(id INTEGER PRIMARY KEY AUTOINCREMENT,worker_id TEXT NOT NULL REFERENCES workers(id),instruction_id TEXT NOT NULL REFERENCES messages(id),
 run_id TEXT NOT NULL REFERENCES agent_runs(id),request_key TEXT NOT NULL,method TEXT NOT NULL,params TEXT NOT NULL,status TEXT NOT NULL,effect TEXT NOT NULL,
 created_at TEXT NOT NULL,finished_at TEXT,result TEXT,error TEXT,UNIQUE(instruction_id,request_key));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,worker_id TEXT NOT NULL REFERENCES workers(id),instruction_id TEXT,type TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS event_worker ON events(worker_id,id);
CREATE INDEX IF NOT EXISTS message_worker ON messages(worker_id,created_at,id);`;

/** Separate device authority: never opens or migrates project or legacy ADM databases. */
export class DeviceValetStore {
  constructor(file) {
    const existing = assertPrivateFile(file,{missing:true});
    if (!existing) fs.closeSync(fs.openSync(file,'wx',0o600));
    for (const suffix of ['-wal','-shm']) assertPrivateFile(file+suffix,{missing:true});
    this.db = new Database(file,{readwrite:true});
    try {
      if (existing) {
        check(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get(), 'not a device Valet store');
        check(this.db.query("SELECT value FROM meta WHERE key='schema_version'").get()?.value === '1', 'unsupported device Valet store version');
      }
      this.db.exec(SCHEMA);
      if (!existing) this.transaction(() => { this.setMeta('schema_version','1'); this.setMeta('service_id',randomUUID()); this.setMeta('number_high','0'); });
      this.serviceId = this.meta('service_id'); check(typeof this.serviceId === 'string' && this.serviceId.length > 0,'device Valet identity missing');
    } catch(error) { this.db.close(); throw error; }
  }
  get(sql,...args) { return this.db.query(sql).get(...args); }
  all(sql,...args) { return this.db.query(sql).all(...args); }
  run(sql,...args) { return this.db.query(sql).run(...args); }
  transaction(fn) { return this.db.transaction(fn)(); }
  meta(key) { return this.get('SELECT value FROM meta WHERE key=?',key)?.value; }
  setMeta(key,value) { this.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,String(value)); }
  nextNumber() { const n=Number(this.meta('number_high')); check(Number.isSafeInteger(n) && n>=0 && n<Number.MAX_SAFE_INTEGER,'device Valet number limit'); this.setMeta('number_high',n+1); return `DV${n+1}`; }
  worker(id) { const row=this.get('SELECT * FROM workers WHERE id=?',id); check(row,'device Valet not found'); return row; }
  instruction(id) { const row=this.get('SELECT * FROM messages WHERE id=?',id); check(row,'device Valet instruction not found'); return row; }
  event(workerId,instructionId,type,data,now) { return Number(this.run('INSERT INTO events(worker_id,instruction_id,type,created_at,data) VALUES (?,?,?,?,?)',workerId,instructionId,type,now,JSON.stringify(data)).lastInsertRowid); }
  close() { this.db.close(); }
}
