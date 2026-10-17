import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { check, hash, stable, workspaceKey } from './protocol.js';
import { withInitializationLock } from './init-lock.js';
import { initializeCommandResourceContainer } from './command-resources.js';

/** Node-local execution facts only. Never stores central Worker or model/account tables. */
export class RunnerStore {
  constructor(root) {
    check(path.isAbsolute(root) && path.resolve(root) === root, 'INVALID_REQUEST', 'Runner root must be canonical');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    check(fs.realpathSync(root) === root && fs.lstatSync(root).isDirectory(), 'UNAUTHORIZED', 'Runner root must not contain symlinks');
    fs.chmodSync(root, 0o700);
    this.root = root;
    this.rootIdentity = fs.lstatSync(root, { bigint: true });
    const database = path.join(root, 'runner.db');
    if (fs.existsSync(database)) check(fs.lstatSync(database).isFile() && !fs.lstatSync(database).isSymbolicLink(), 'UNAUTHORIZED', 'Invalid Runner database');
    withInitializationLock(root, () => {
    this.db = new Database(database, { create: true });
    try {
    fs.chmodSync(database, 0o600);
    // Install the busy handler before journal-mode/schema acquisition, even under the bootstrap lock.
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS node_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_key TEXT PRIMARY KEY, project_id TEXT NOT NULL, node_id TEXT NOT NULL, worker_id INTEGER NOT NULL,
        workspace_id TEXT NOT NULL, generation INTEGER NOT NULL, directory TEXT NOT NULL, dev TEXT NOT NULL, ino TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'ready', busy_request TEXT, last_run_id INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, UNIQUE(project_id, workspace_id, generation));
      CREATE UNIQUE INDEX IF NOT EXISTS workspace_owner ON workspaces(project_id,worker_id);
      CREATE TABLE IF NOT EXISTS workspace_closures (
        project_id TEXT NOT NULL, worker_id INTEGER NOT NULL, workspace_id TEXT NOT NULL, workspace_key TEXT NOT NULL,
        identity_json TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        PRIMARY KEY(project_id,worker_id), UNIQUE(project_id,workspace_id));
      CREATE TABLE IF NOT EXISTS leases (
        lease_id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, run_id INTEGER NOT NULL, token_hash TEXT NOT NULL,
        session_id TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
        UNIQUE(workspace_key, run_id));
      CREATE TABLE IF NOT EXISTS requests (
        project_id TEXT NOT NULL, request_id TEXT NOT NULL, workspace_key TEXT NOT NULL, identity_json TEXT NOT NULL,
        method TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT, error_json TEXT,
        session_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, request_id));
      CREATE TABLE IF NOT EXISTS executions (
        execution_id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, request_id TEXT NOT NULL,
        identity_json TEXT NOT NULL, session_id TEXT NOT NULL, lease_id TEXT,
        state TEXT NOT NULL, spec_json TEXT NOT NULL, cgroup_name TEXT,
        created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
        expires_at INTEGER NOT NULL, queue_deadline INTEGER NOT NULL,
        exit_code INTEGER, reason TEXT, stop_confirmed INTEGER NOT NULL DEFAULT 0,
        output_bytes INTEGER NOT NULL DEFAULT 0, output_seen INTEGER NOT NULL DEFAULT 0,
        output_seq INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0,
        output_complete INTEGER NOT NULL DEFAULT 0, error_json TEXT);
      CREATE TABLE IF NOT EXISTS command_resources (
        execution_id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, runner_id TEXT NOT NULL,
        phase TEXT NOT NULL, home_state TEXT NOT NULL, cgroup_state TEXT NOT NULL,
        home_json TEXT, containment_json TEXT);
      CREATE TABLE IF NOT EXISTS output_chunks (
        execution_id TEXT NOT NULL, seq INTEGER NOT NULL, stream TEXT NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY(execution_id,seq));
      CREATE INDEX IF NOT EXISTS execution_workspace ON executions(workspace_key,state);
      CREATE INDEX IF NOT EXISTS lease_workspace ON leases(workspace_key,revoked,expires_at);
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, relative_path TEXT NOT NULL,
        digest TEXT NOT NULL, size INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    `);
    this.db.query("INSERT OR IGNORE INTO node_metadata(key,value) VALUES ('runner_id',?)").run(randomUUID());
    this.runner_id = this.db.query("SELECT value FROM node_metadata WHERE key='runner_id'").get().value;
    initializeCommandResourceContainer(this);
    } catch (error) { this.db.close(); throw error; }
    });
  }
  transaction(fn) { return this.db.transaction(fn).immediate(); }
  workspace(identity) { return this.db.query('SELECT * FROM workspaces WHERE workspace_key=?').get(workspaceKey(identity)); }
  preparationClosure(identity) {
    return this.db.query('SELECT * FROM workspace_closures WHERE project_id=? AND (worker_id=? OR workspace_id=?) LIMIT 1')
      .get(identity.project_id, identity.worker_id, identity.workspace_id);
  }
  assertPreparationOpen(identity) {
    check(!this.preparationClosure(identity), 'STALE', 'Workspace preparation was permanently closed');
  }
  request(project_id, request_id) { return this.db.query('SELECT * FROM requests WHERE project_id=? AND request_id=?').get(project_id, request_id); }
  lease(identity) { return this.db.query('SELECT * FROM leases WHERE workspace_key=? AND run_id=?').get(workspaceKey(identity), identity.run_id); }
  beginRequest(request, session_id, { lock = false } = {}) {
    const key = workspaceKey(request.identity);
    const fingerprint = hash(stable({ method: request.method, identity: request.identity, params: request.params }));
    return this.transaction(() => {
      if (request.method === 'workspace.register') this.assertPreparationOpen(request.identity);
      const old = this.request(request.identity.project_id, request.request_id);
      if (old) { check(old.fingerprint === fingerprint, 'CONFLICT', 'Request ID reused with different parameters'); return { fresh: false, row: old }; }
      if (lock) {
        const result = this.db.query("UPDATE workspaces SET busy_request=? WHERE workspace_key=? AND busy_request IS NULL AND state='ready'").run(request.request_id, key);
        check(result.changes === 1, 'BUSY', 'Workspace has active or unknown operations');
      }
      const now = Date.now();
      this.db.query('INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(request.identity.project_id,
        request.request_id, key, JSON.stringify(request.identity), request.method, fingerprint, 'accepted', null, null, session_id, now, now);
      return { fresh: true };
    });
  }
  finishRequest(request, result, error, { unlock = true } = {}) {
    this.transaction(() => {
      this.db.query('UPDATE requests SET state=?,result_json=?,error_json=?,updated_at=? WHERE project_id=? AND request_id=?')
        .run(error ? 'failed' : 'completed', result === undefined ? null : JSON.stringify(result), error ? JSON.stringify(error) : null,
          Date.now(), request.identity.project_id, request.request_id);
      if (unlock) this.unlock(workspaceKey(request.identity), request.request_id);
    });
  }
  unlock(key, request_id) { this.db.query('UPDATE workspaces SET busy_request=NULL WHERE workspace_key=? AND busy_request=?').run(key, request_id); }
  close() { this.db.close(); }
}
