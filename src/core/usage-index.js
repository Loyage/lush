/** Rebuildable project-local expenditure cache, never an authoritative history store. */
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { USAGE_SESSION, usageSignature, readCompactUsageFile } from './usage-statistics.js';

const VERSION = 2;
const COUNTS = ['requests', 'unknown_tokens', 'unknown_cost', 'known_tokens', 'known_cost'];
const VALUES = ['input', 'output', 'cost'];
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));

function validSummary(value, taskId, signature) {
  if (!value || value.task_id !== taskId || value.signature !== signature
    || !Number.isSafeInteger(value.malformed) || value.malformed < 0
    || !Number.isSafeInteger(value.incomplete) || value.incomplete < 0) return false;
  const r = value.resources;
  return r && COUNTS.every(key => Number.isSafeInteger(r[key]) && r[key] >= 0)
    && VALUES.every(key => typeof r[key] === 'number' && Number.isFinite(r[key]) && r[key] >= 0)
    && r.known_tokens + r.unknown_tokens === r.requests
    && r.known_cost + r.unknown_cost === r.requests;
}

export class UsageIndex {
  constructor(config, { batchSize = 8, intervalMs = 5000, parse = readCompactUsageFile } = {}) {
    this.config = config;
    this.dir = path.join(config.home, 'sessions');
    this.file = path.join(config.home, 'usage-index.sqlite');
    this.scope = JSON.stringify([path.resolve(config.project), path.resolve(config.home)]);
    this.batchSize = batchSize; this.intervalMs = intervalMs; this.parse = parse;
    this.db = null; this.pending = new Map(); this.writes = new Map();
    this.active = false; this.closed = false; this.stopping = false;
    this.timer = null; this.flight = null;
  }

  open() {
    if (this.db || this.closed) return this.db;
    // Only this disposable cache may be rebuilt. Never touch project.db or sessions.
    for (let attempt = 0; attempt < 2; attempt++) {
      let db;
      try {
        // The cache is local; never open a symlink into another project's database.
        try { if (!fs.lstatSync(this.file).isFile()) return null; }
        catch (error) { if (error.code !== 'ENOENT') return null; }
        db = new Database(this.file, { create: true });
        db.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        const version = db.query("SELECT value FROM metadata WHERE key='version'").get()?.value;
        const scope = db.query("SELECT value FROM metadata WHERE key='scope'").get()?.value;
        if (version !== String(VERSION) || scope !== this.scope) {
          db.exec('DROP TABLE IF EXISTS summaries; DELETE FROM metadata');
          db.query('INSERT INTO metadata VALUES (?,?)').run('version', String(VERSION));
          db.query('INSERT INTO metadata VALUES (?,?)').run('scope', this.scope);
        }
        db.exec('CREATE TABLE IF NOT EXISTS summaries (name TEXT PRIMARY KEY, signature TEXT NOT NULL, summary TEXT NOT NULL)');
        // Reject a damaged/incompatible cache schema even if its metadata survived.
        db.query('SELECT name,signature,summary FROM summaries LIMIT 1').get();
        db.query('INSERT OR REPLACE INTO summaries VALUES (?,?,?)');
        this.db = db; return db;
      } catch {
        try { db?.close(); } catch {}
        if (attempt) return null;
        try { for (const suffix of ['', '-wal', '-shm']) fs.rmSync(this.file + suffix, { force: true }); }
        catch { return null; }
      }
    }
    return null;
  }

  get(file, stat) {
    if (this.closed || path.dirname(file) !== this.dir || !stat.isFile()) return null;
    try {
      const key = usageSignature(stat), name = path.basename(file);
      const buffered = this.writes.get(name);
      if (buffered?.signature === key) return buffered;
      const row = this.open()?.query('SELECT signature,summary FROM summaries WHERE name=?').get(name);
      if (!row || row.signature !== key) return null;
      const value = JSON.parse(row.summary);
      if (validSummary(value, Number(name.match(USAGE_SESSION)?.[1]), key)) return value;
      // Leave invalid rows unavailable until the next batched rebuild overwrites them.
    } catch { /* Cache errors affect coverage, not Worker execution or other files. */ }
    return null;
  }

  flush() {
    if (!this.writes.size) return;
    const entries = [...this.writes];
    this.writes.clear();
    try {
      const db = this.open();
      if (!db) return;
      const insert = db.query('INSERT OR REPLACE INTO summaries VALUES (?,?,?)');
      db.transaction(() => {
        for (const [name, summary] of entries) insert.run(name, summary.signature, JSON.stringify(summary));
      })();
    } catch { /* Lost cache writes only require rebuilding; history is untouched. */ }
  }

  read(file, stat, { deferWrite = false } = {}) {
    if (this.closed || this.stopping || path.dirname(file) !== this.dir || !stat.isFile()) return Promise.resolve(null);
    const cached = this.get(file, stat);
    if (cached) return Promise.resolve(cached);
    if (this.pending.has(file)) return this.pending.get(file).then(summary =>
      summary?.signature === usageSignature(stat) ? summary : null);
    const promise = (async () => {
      try {
        const summary = await this.parse(file, stat);
        const current = await fs.promises.lstat(file);
        // Parsing snapshots the size. Never label a concurrent append/replacement as current.
        if (!current.isFile() || usageSignature(current) !== usageSignature(stat)
          || !validSummary(summary, Number(file.match(USAGE_SESSION)?.[1]), usageSignature(stat))) return null;
        this.writes.set(path.basename(file), summary);
        if (!deferWrite || this.writes.size >= this.batchSize) this.flush();
        return summary;
      } catch { return null; }
    })().finally(() => this.pending.delete(file));
    this.pending.set(file, promise); return promise;
  }

  start() {
    if (this.active || this.closed || this.stopping) return;
    this.active = true; this.schedule(0);
  }

  schedule(delay) {
    if (!this.active || this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh().finally(() => this.schedule(this.intervalMs));
    }, delay);
    this.timer.unref?.();
  }

  /** Single-flight reconciliation, one stream at a time, yielding after each bounded batch.
   * A pass snapshots directory membership and each file size; live writers cannot prolong it.
   * stop() stops admission between files, drains admitted streams, then closes SQLite.
   */
  refresh() {
    if (this.closed || this.stopping) return Promise.resolve();
    if (this.flight) return this.flight;
    this.flight = (async () => {
      let names;
      try { names = (await fs.promises.readdir(this.dir)).filter(name => USAGE_SESSION.test(name)).sort(); }
      catch (error) { if (error.code === 'ENOENT') names = []; else return; }
      try {
        const db = this.open();
        const live = new Set(names);
        const stale = (db?.query('SELECT name FROM summaries').all() ?? []).filter(row => !live.has(row.name));
        if (stale.length) db.transaction(() => {
          const remove = db.query('DELETE FROM summaries WHERE name=?');
          for (const row of stale) remove.run(row.name);
        })();
      } catch { /* Reconciliation may retry on the next pass. */ }
      for (let i = 0; i < names.length && !this.stopping; i++) {
        try {
          const file = path.join(this.dir, names[i]), stat = await fs.promises.lstat(file);
          if (stat.isFile() && !this.get(file, stat)) await this.read(file, stat, { deferWrite: true });
        } catch { /* One broken source must not stop backfill of its neighbors. */ }
        if ((i + 1) % this.batchSize === 0) { this.flush(); await yieldTurn(); }
      }
    })().finally(() => { this.flush(); this.flight = null; });
    return this.flight;
  }

  async stop() {
    this.active = false; this.stopping = true;
    clearTimeout(this.timer); this.timer = null;
    await this.flight;
    await Promise.allSettled([...this.pending.values()]);
    this.flush();
    this.closed = true;
    this.db?.close(); this.db = null;
  }
}
