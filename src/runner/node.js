import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunnerStore } from './store.js';
import { OPERATIONS, CAPABILITIES, IMPLEMENTATION_VERSION, LIMITS, PROTOCOL_VERSION, check, fail, hash, identifier, integer,
  publicError, redact, requestSecrets, tokenMatches, validToken, validateRequest, workspaceKey } from './protocol.js';

export function normalizeConfig(raw) {
  identifier(raw.node_id, 'node_id');
  check(typeof raw.machine_token_hash === 'string' && /^[a-f0-9]{64}$/.test(raw.machine_token_hash), 'INVALID_REQUEST', 'Missing machine token hash');
  check(raw.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects), 'INVALID_REQUEST', 'Missing project authorities');
  for (const [id, project] of Object.entries(raw.projects)) {
    identifier(id, 'project_id');
    check(project && typeof project === 'object' && /^[a-f0-9]{64}$/.test(project.control_token_hash ?? ''), 'INVALID_REQUEST', 'Missing project control token hash');
    check(project.enabled === undefined || typeof project.enabled === 'boolean', 'INVALID_REQUEST', 'Invalid project enabled flag');
  }
  if (raw.command_env_allowlist !== undefined) check(Array.isArray(raw.command_env_allowlist)
    && raw.command_env_allowlist.length <= 64 && raw.command_env_allowlist.every(key => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)),
    'INVALID_REQUEST', 'Invalid command environment allowlist');
  if (raw.command_path !== undefined) check(typeof raw.command_path === 'string' && raw.command_path.length <= 8192
    && raw.command_path.split(':').every(part => path.isAbsolute(part) && !part.includes('\0')), 'INVALID_REQUEST', 'Invalid command search path');
  const budgets = raw.budgets ?? {};
  return { ...raw, max_commands: Math.min(integer(raw.max_commands ?? budgets.max_commands ?? 1, 'max_commands', 1, 64),
      integer(budgets.max_commands ?? raw.max_commands ?? 1, 'budgets.max_commands', 1, 64)),
    memory_reserve_bytes: integer(raw.memory_reserve_bytes ?? 512 * 1024 * 1024, 'memory_reserve_bytes', 0),
    output_storage_bytes: integer(raw.output_storage_bytes ?? 256 * 1024 * 1024, 'output_storage_bytes', 1025, 16 * 1024 ** 3),
    limits: { ...LIMITS,
      command_ms: integer(budgets.timeout_ms ?? LIMITS.command_ms, 'budgets.timeout_ms', 1, LIMITS.max_command_ms),
      output_bytes: integer(budgets.output_bytes ?? LIMITS.output_bytes, 'budgets.output_bytes', 1, LIMITS.output_bytes) } };
}

/** Transport-independent authority and durable request boundary. Missing services fail closed. */
export class RunnerNode {
  constructor(config, { services = {}, preflight = async () => fail('UNSUPPORTED', 'Command containment service is not installed'), refresh_config = null } = {}) {
    this.config = normalizeConfig(config);
    this.store = new RunnerStore(config.root);
    this.config.runner_id = this.store.runner_id;
    this.runner_id = this.store.runner_id;
    this.services = services;
    this.preflight = preflight;
    this.sessions = new Set();
    this.closed = false;
    this.refresh_config = refresh_config;
    this.background = new Set();
    this.stopping_workspaces = new Map();
    if (refresh_config) {
      this.config_timer = setInterval(() => { try { this.refreshAuthorization(); } catch { this.revokeProjects(Object.keys(this.config.projects)); } }, 250);
      this.config_timer.unref();
    }
  }
  revokeProjects(project_ids) {
    for (const project_id of project_ids) {
      const rows = this.store.db.query('SELECT w.workspace_key FROM workspaces w WHERE w.project_id=? AND (EXISTS (SELECT 1 FROM leases l WHERE l.workspace_key=w.workspace_key AND l.revoked=0) OR EXISTS (SELECT 1 FROM executions e WHERE e.workspace_key=w.workspace_key AND e.stop_confirmed=0))').all(project_id);
      for (const row of rows) {
        if (this.stopping_workspaces.has(row.workspace_key)) continue;
        this.store.db.query('UPDATE leases SET revoked=1 WHERE workspace_key=? AND revoked=0').run(row.workspace_key);
        const stopping = this.stopWorkspace(row.workspace_key).catch(() => {});
        this.background.add(stopping); stopping.finally(() => this.background.delete(stopping));
      }
    }
  }
  stopWorkspace(key) {
    if (this.stopping_workspaces.has(key)) return this.stopping_workspaces.get(key);
    // Repeated status requests/config checks join one stop operation rather than flooding
    // the shared FULL-synchronous database and starving the independent watchdog.
    const stopping = Promise.resolve().then(() => this.services.stop_workspace?.(key));
    this.stopping_workspaces.set(key, stopping);
    stopping.finally(() => this.stopping_workspaces.delete(key)).catch(() => {});
    return stopping;
  }
  refreshAuthorization() {
    if (!this.refresh_config) return;
    const next = normalizeConfig(this.refresh_config());
    check(next.root === this.config.root && next.node_id === this.config.node_id && next.cgroup_root === this.config.cgroup_root,
      'STALE', 'Runner identity/root changes require a new controlled process');
    const revoked = Object.keys(this.config.projects).filter(id => next.machine_token_hash !== this.config.machine_token_hash
      || !next.projects[id] || next.projects[id].enabled === false || next.projects[id].control_token_hash !== this.config.projects[id].control_token_hash);
    this.revokeProjects(revoked);
    Object.assign(this.config, next, { runner_id: this.runner_id });
  }
  openSession() { check(!this.closed, 'UNAVAILABLE', 'Runner is closed'); const id = randomUUID(); this.sessions.add(id); return id; }
  authorize(request, spec, session_id) {
    check(this.sessions.has(session_id) && !this.closed, 'UNAUTHORIZED', 'Inactive connection');
    try { this.refreshAuthorization(); }
    catch (error) { this.revokeProjects(Object.keys(this.config.projects)); throw error; }
    const { identity, auth } = request;
    check(identity.node_id === this.config.node_id && tokenMatches(auth.machine_token, this.config.machine_token_hash), 'UNAUTHORIZED', 'Invalid node authorization');
    if (request.method !== 'hello' || identity.runner_id !== undefined && identity.runner_id !== null)
      check(identity.runner_id === this.runner_id, 'STALE', 'Runner installation identity changed or is missing');
    if (request.method === 'hello' && request.params.expected_runner_id !== undefined)
      check(request.params.expected_runner_id === this.runner_id, 'STALE', 'Runner installation identity changed');
    const project = this.config.projects[identity.project_id];
    check(project, 'UNAUTHORIZED', 'Project is not registered');
    const observation = ['hello', 'request.status', 'workspace.inspect', 'workspace.barrier', 'command.status', 'command.output',
      'command.cancel', 'lease.revoke', 'lease.release', 'workspace.cleanup', 'workspace.git.inspect'].includes(request.method) || spec.observation === true;
    check(project.enabled !== false || observation, 'UNAUTHORIZED', 'Project authorization is disabled');
    const authority = identity.run_id === undefined ? 'control' : 'run';
    check(spec.authority === 'either' || spec.authority === authority, 'UNAUTHORIZED', 'Operation requires a different authority');
    let lease;
    if (authority === 'control') check(tokenMatches(auth.control_token, project.control_token_hash), 'UNAUTHORIZED', 'Invalid control authorization');
    else {
      lease = this.store.lease(identity);
      check(lease && tokenMatches(auth.run_token, lease.token_hash), 'UNAUTHORIZED', 'Invalid invocation authorization');
      // After expiry/revocation only bounded observation and explicit stopping remain authorized.
      check(observation && request.method !== 'hello' || !lease.revoked && lease.expires_at > Date.now() && lease.session_id === session_id,
        'UNAUTHORIZED', 'Invocation lease is revoked, expired or belongs to another connection');
    }
    const workspace = spec.workspace ? this.store.workspace(identity) : null;
    if (spec.workspace) {
      check(workspace, 'NOT_FOUND', 'Workspace identity is not registered');
      check(workspace.state !== 'removed' || ['request.status', 'workspace.inspect', 'workspace.barrier'].includes(request.method),
        'STALE', 'Workspace resources have been removed');
      if (authority === 'control' && spec.mutation && !spec.concurrent && !spec.live_control && request.method !== 'lease.grant') {
        const live = this.store.db.query('SELECT lease_id FROM leases WHERE workspace_key=? AND revoked=0 AND expires_at>?')
          .get(workspace.workspace_key, Date.now());
        check(!live, 'BUSY', 'An invocation owns this workspace');
      }
      if (spec.idle_read) {
        const active = this.store.db.query('SELECT 1 FROM executions WHERE workspace_key=? AND stop_confirmed=0 LIMIT 1').get(workspace.workspace_key);
        check(!workspace.busy_request && !active, 'BUSY', 'Workspace has active or unknown writers');
      }
      const stat = fs.lstatSync(workspace.directory, { bigint: true });
      check(stat.isDirectory() && !stat.isSymbolicLink() && String(stat.dev) === workspace.dev && String(stat.ino) === workspace.ino
        && fs.realpathSync(workspace.directory) === workspace.directory, 'STALE', 'Workspace directory identity changed');
    }
    return { node: this, store: this.store, config: this.config, workspace, identity, request,
      request_id: request.request_id, session_id, authority, lease,
      authorization_expires_at: lease?.expires_at ?? Date.now() + LIMITS.max_lease_ms };
  }
  async dispatch(request, session_id) {
    let spec, context, recorded = false;
    const secrets = requestSecrets(request);
    try {
      spec = validateRequest(request);
      context = this.authorize(request, spec, session_id);
      const paramsText = JSON.stringify(request.params);
      check(!Object.values(request.auth).filter(validToken).some(secret => paramsText.includes(secret)),
        'UNAUTHORIZED', 'Authorization credentials must not appear in operation parameters');
      const handler = this.builtins[request.method] ?? this.services[request.method];
      check(handler, 'UNSUPPORTED', 'Runner operation is not installed');
      if (request.method === 'hello') await this.preflight();
      if (spec.mutation) {
        const lock = Boolean(spec.workspace && !spec.concurrent && !['lease.renew'].includes(request.method));
        const receipt = this.store.beginRequest(request, session_id, { lock });
        if (!receipt.fresh) {
          if (receipt.row.error_json) return { version: PROTOCOL_VERSION, request_id: request.request_id, error: JSON.parse(receipt.row.error_json) };
          if (receipt.row.state === 'completed') return { version: PROTOCOL_VERSION, request_id: request.request_id, result: JSON.parse(receipt.row.result_json ?? 'null') };
          fail('UNKNOWN', 'Request was recorded but its outcome is not confirmed; do not replay', { request_id: request.request_id });
        }
        recorded = true;
      }
      // Recheck authority after recording, before any side effect. No fallback on rejection.
      this.authorize(request, spec, session_id);
      if (spec.context) {
        check(this.services.check_context, 'UNSUPPORTED', 'Context precondition service is not installed');
        await this.services.check_context(context, request.params);
      }
      this.authorize(request, spec, session_id);
      const result = redact(await handler(context, request.params), secrets);
      if (recorded) this.store.finishRequest(request, result, null, { unlock: !spec.retain_busy });
      return { version: PROTOCOL_VERSION, request_id: request.request_id, result };
    } catch (error) {
      const wire = redact(publicError(error), secrets);
      if (recorded) {
        // Unknown native failures may have produced a side effect. Never clear their lock or replay.
        if (wire.code === 'INTERNAL' || wire.code === 'UNKNOWN') {
          this.store.db.query("UPDATE requests SET state='unknown',updated_at=? WHERE project_id=? AND request_id=?")
            .run(Date.now(), request.identity.project_id, request.request_id);
        } else this.store.finishRequest(request, undefined, wire);
      }
      return { version: PROTOCOL_VERSION, request_id: typeof request?.request_id === 'string' ? request.request_id.slice(0,128) : null, error: wire };
    }
  }
  builtins = {
    hello: () => ({ protocol_version: PROTOCOL_VERSION, implementation_version: IMPLEMENTATION_VERSION,
      node_id: this.config.node_id, runner_id: this.runner_id, platform: process.platform, arch: process.arch,
      capabilities: CAPABILITIES.filter(name => this.builtins[name] || this.services[name]), limits: this.config.limits,
      max_commands: this.config.max_commands, memory_reserve_bytes: this.config.memory_reserve_bytes }),
    'workspace.register': (ctx) => {
      const key = workspaceKey(ctx.identity);
      let existing = this.store.workspace(ctx.identity);
      if (existing) return this.workspaceView(existing);
      const previous = this.store.db.query('SELECT * FROM workspaces WHERE project_id=? AND (workspace_id=? OR worker_id=?) ORDER BY generation DESC LIMIT 1')
        .get(ctx.identity.project_id, ctx.identity.workspace_id, ctx.identity.worker_id);
      check(!previous, 'CONFLICT', 'Workspace ID is already registered; generation replacement requires explicit reconciliation');
      const directory = path.join(this.store.root, 'workspaces', key);
      fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
      check(fs.realpathSync(path.dirname(directory)) === path.dirname(directory), 'STALE', 'Workspace container changed');
      // The durable request identifies this preparation before mkdir; an interrupted path is never adopted blindly.
      check(!fs.existsSync(directory), 'CONFLICT', 'Unregistered workspace directory exists');
      fs.mkdirSync(directory, { mode: 0o700 });
      const stat = fs.statSync(directory, { bigint: true });
      this.store.db.query('INSERT INTO workspaces (workspace_key,project_id,node_id,worker_id,workspace_id,generation,directory,dev,ino,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(key, ctx.identity.project_id, ctx.identity.node_id, ctx.identity.worker_id, ctx.identity.workspace_id, ctx.identity.generation,
          directory, String(stat.dev), String(stat.ino), Date.now());
      return this.workspaceView(this.store.workspace(ctx.identity));
    },
    'workspace.inspect': ctx => this.workspaceView(this.store.workspace(ctx.identity)),
    'lease.grant': (ctx, params) => {
      integer(params.run_id, 'run_id');
      check(validToken(params.run_token), 'INVALID_REQUEST', 'Invalid run token');
      const ttl = integer(params.ttl_ms ?? LIMITS.lease_ms, 'ttl_ms', 100, LIMITS.max_lease_ms);
      return this.store.transaction(() => {
        const current = this.store.workspace(ctx.identity);
        check(params.run_id > current.last_run_id, 'STALE', 'Run ID must advance monotonically');
        const live = this.store.db.query('SELECT lease_id FROM leases WHERE workspace_key=? AND revoked=0 AND expires_at>?').get(current.workspace_key, Date.now());
        check(!live, 'BUSY', 'Workspace already has an active lease');
        const lease_id = randomUUID(), expires_at = Date.now() + ttl;
        this.store.db.query('INSERT INTO leases (lease_id,workspace_key,run_id,token_hash,session_id,expires_at) VALUES (?,?,?,?,?,?)')
          .run(lease_id, current.workspace_key, params.run_id, hash(params.run_token), ctx.session_id, expires_at);
        this.store.db.query('UPDATE workspaces SET last_run_id=? WHERE workspace_key=?').run(params.run_id, current.workspace_key);
        return { lease_id, run_id: params.run_id, expires_at };
      });
    },
    'lease.renew': (ctx, params) => {
      const expires_at = Date.now() + integer(params.ttl_ms ?? LIMITS.lease_ms, 'ttl_ms', 100, LIMITS.max_lease_ms);
      const changed = this.store.db.query('UPDATE leases SET expires_at=? WHERE lease_id=? AND revoked=0 AND expires_at>?')
        .run(expires_at, ctx.lease.lease_id, Date.now());
      check(changed.changes === 1, 'UNAUTHORIZED', 'Lease changed before renewal');
      return { lease_id: ctx.lease.lease_id, expires_at };
    },
    'lease.revoke': async (ctx) => {
      this.store.db.query('UPDATE leases SET revoked=1 WHERE workspace_key=? AND revoked=0').run(ctx.workspace.workspace_key);
      await this.stopWorkspace(ctx.workspace.workspace_key);
      return this.barrier(ctx);
    },
    'lease.release': async (ctx) => {
      if (ctx.lease) {
        this.store.db.query('UPDATE leases SET revoked=1 WHERE lease_id=? AND revoked=0').run(ctx.lease.lease_id);
        // Revoked/expired Runs retain stop-only access to THEIR lease, not a newer
        // invocation (or control execution) sharing the same workspace/connection.
        await this.services.stop_lease?.(ctx.workspace.workspace_key, ctx.lease.lease_id);
      } else {
        this.store.db.query('UPDATE leases SET revoked=1 WHERE workspace_key=? AND revoked=0').run(ctx.workspace.workspace_key);
        await this.stopWorkspace(ctx.workspace.workspace_key);
      }
      // Always a global workspace observation, never a claim that stopping one Run made it idle.
      return this.barrier(ctx);
    },
    'request.status': (ctx, params) => {
      identifier(params.request_id, 'request_id');
      const receipt = this.store.request(ctx.identity.project_id, params.request_id);
      check(receipt && receipt.workspace_key === ctx.workspace.workspace_key, 'NOT_FOUND', 'Request not found');
      const owner = JSON.parse(receipt.identity_json);
      check(ctx.authority === 'control' || owner.run_id === ctx.identity.run_id, 'UNAUTHORIZED', 'Request belongs to another invocation');
      // Additive, authenticated evidence only: no auth material or request parameters. Old
      // nodes lacking this evidence cannot prove recovery of a central tool journal.
      const methods = JSON.stringify(Object.keys(OPERATIONS).filter(method => OPERATIONS[method].tool_effect));
      const where = "workspace_key=? AND json_extract(identity_json,'$.run_id')=? AND method IN (SELECT value FROM json_each(?))";
      const args = [receipt.workspace_key, owner.run_id ?? null, methods];
      const total = this.store.db.query(`SELECT count(*) AS n FROM requests WHERE ${where}`).get(...args).n;
      const rows = this.store.db.query(`SELECT request_id,method,fingerprint FROM requests WHERE ${where} ORDER BY request_id LIMIT 256`).all(...args);
      return { request_id: receipt.request_id, state: receipt.state, method: receipt.method, identity: owner,
        fingerprint: receipt.fingerprint, history: { total, truncated: total > rows.length, requests: rows },
        result: JSON.parse(receipt.result_json ?? 'null'), error: JSON.parse(receipt.error_json ?? 'null') };
    },
    'workspace.barrier': ctx => this.barrier(ctx),
  };
  workspaceView(workspace) {
    return { workspace_id: workspace.workspace_id, worker_id: workspace.worker_id, generation: workspace.generation,
      directory: workspace.directory, state: workspace.state, busy: Boolean(workspace.busy_request), last_run_id: workspace.last_run_id };
  }
  barrier(ctx) {
    const workspace = this.store.workspace(ctx.identity);
    const total = this.store.db.query('SELECT COUNT(*) AS n FROM executions WHERE workspace_key=? AND stop_confirmed=0').get(workspace.workspace_key).n;
    const active = ctx.authority === 'control'
      ? this.store.db.query('SELECT execution_id,state,stop_confirmed FROM executions WHERE workspace_key=? AND stop_confirmed=0 ORDER BY created_at,execution_id LIMIT 32').all(workspace.workspace_key)
      : this.store.db.query("SELECT execution_id,state,stop_confirmed FROM executions WHERE workspace_key=? AND stop_confirmed=0 AND json_extract(identity_json,'$.run_id')=? ORDER BY created_at,execution_id LIMIT 32").all(workspace.workspace_key, ctx.identity.run_id);
    return { stopped: !workspace.busy_request && total === 0, busy: Boolean(workspace.busy_request), executions: active,
      total, truncated: total > active.length };
  }
  async disconnect(session_id) {
    this.sessions.delete(session_id);
    this.store.db.query('UPDATE leases SET revoked=1 WHERE session_id=?').run(session_id);
    await this.services.disconnect?.(session_id);
  }
  async close() {
    clearInterval(this.config_timer);
    for (const id of [...this.sessions]) await this.disconnect(id);
    await Promise.allSettled([...this.background]);
    await this.services.close?.(); this.closed = true; this.store.close();
  }
}
