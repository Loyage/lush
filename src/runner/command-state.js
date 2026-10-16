import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, check, integer, identifier, stable } from './protocol.js';
import { beginCommandResources } from './command-resources.js';

export const ACTIVE_COMMAND_STATES = ['starting', 'running', 'stopping', 'unknown'];
export const DEFAULT_OUTPUT_STORAGE_BYTES = 256 * 1024 * 1024;
// Logical storage charge includes bounded per-chunk overhead, so tiny writes cannot create unbounded rows.
// This is not a physical SQLite/WAL filesystem quota.
export const OUTPUT_CHUNK_STORAGE_BYTES = 1024;
export function outputStorageUsed(store) {
  return store.db.query('SELECT coalesce(sum(length(data) + ?),0) AS used FROM output_chunks')
    .get(OUTPUT_CHUNK_STORAGE_BYTES).used;
}
export function executionRow(store, id) { return store.db.query('SELECT * FROM executions WHERE execution_id=?').get(id); }
export function authorizedExecution(store, ctx, params) {
  identifier(params.execution_id, 'execution_id');
  const row = executionRow(store, params.execution_id);
  check(row && row.workspace_key === ctx.workspace.workspace_key, 'NOT_FOUND', 'Command not found');
  const owner = JSON.parse(row.identity_json);
  check(ctx.authority === 'control' || owner.run_id === ctx.identity.run_id, 'UNAUTHORIZED', 'Command belongs to another invocation');
  return row;
}
export function executionView(row) {
  return { execution_id: row.execution_id, state: row.state, created_at: row.created_at, started_at: row.started_at,
    ended_at: row.ended_at, exit_code: row.exit_code, reason: row.reason, stop_confirmed: Boolean(row.stop_confirmed),
    output_bytes: row.output_bytes, output_seen: row.output_seen, output_seq: row.output_seq,
    truncated: Boolean(row.truncated), output_complete: Boolean(row.output_complete),
    output_error: row.error_json ? JSON.parse(row.error_json) : null };
}
export function authorityActive(store, row, now = Date.now()) {
  if (row.lease_id) {
    const lease = store.db.query('SELECT * FROM leases WHERE lease_id=?').get(row.lease_id);
    return Boolean(lease && !lease.revoked && lease.expires_at > now && lease.session_id === row.session_id
      && lease.workspace_key === row.workspace_key && lease.run_id === JSON.parse(row.identity_json).run_id);
  }
  return row.expires_at > now;
}
export function finishExecution(store, row, { reason, exit_code = null, stop_confirmed, output_complete = true, unknown = false }) {
  store.transaction(() => {
    const fresh = executionRow(store, row.execution_id);
    if (!fresh || fresh.stop_confirmed) return;
    // A cancelled queued command never reached a guard or allocated OS resources.
    if (fresh.state === 'queued' && stop_confirmed && !unknown && JSON.parse(fresh.spec_json).resources_version === 1)
      beginCommandResources(store, fresh);
    store.db.query('UPDATE executions SET state=?,reason=?,exit_code=?,ended_at=?,stop_confirmed=?,output_complete=? WHERE execution_id=?')
      .run(unknown ? 'unknown' : 'exited', reason, exit_code, Date.now(), stop_confirmed ? 1 : 0,
        output_complete ? 1 : 0, row.execution_id);
    // Unknown outcomes retain the workspace barrier even if a reconciliation proves processes stopped.
    if (stop_confirmed && !unknown) store.unlock(row.workspace_key, row.request_id);
  });
}
export function appendOutput(store, execution_id, stream, data) {
  const incoming = Buffer.from(data);
  store.transaction(() => {
    const row = executionRow(store, execution_id);
    if (!row || row.stop_confirmed) return;
    const spec = JSON.parse(row.spec_json), cap = spec.output_bytes;
    const activeCaps = store.db.query('SELECT spec_json FROM executions WHERE stop_confirmed=0').all()
      .map(item => JSON.parse(item.spec_json).output_storage_bytes ?? DEFAULT_OUTPUT_STORAGE_BYTES);
    const nodeCap = Math.min(spec.output_storage_bytes ?? DEFAULT_OUTPUT_STORAGE_BYTES, ...activeCaps);
    let nodeRemaining = Math.max(0, nodeCap - outputStorageUsed(store));
    const chunkCap = 32 * Math.ceil(LIMITS.output_bytes / LIMITS.output_chunk_bytes);
    let remaining = incoming.subarray(0, Math.max(0, cap - row.output_bytes)), seq = row.output_seq;
    let stored = 0;
    while (remaining.length && seq < chunkCap && nodeRemaining > OUTPUT_CHUNK_STORAGE_BYTES) {
      const length = Math.min(remaining.length, LIMITS.output_chunk_bytes, nodeRemaining - OUTPUT_CHUNK_STORAGE_BYTES);
      const chunk = remaining.subarray(0, length); remaining = remaining.subarray(length); stored += length;
      nodeRemaining -= length + OUTPUT_CHUNK_STORAGE_BYTES;
      store.db.query('INSERT INTO output_chunks (execution_id,seq,stream,data) VALUES (?,?,?,?)')
        .run(execution_id, ++seq, stream, chunk);
    }
    const scope = nodeRemaining <= OUTPUT_CHUNK_STORAGE_BYTES ? 'node_output_storage' : 'command_output';
    const outputError = stored < incoming.length ? JSON.stringify({ code: 'LIMIT_EXCEEDED',
      message: scope === 'node_output_storage' ? 'Node output storage capacity reached; logs retained' : 'Command output budget reached',
      details: { scope } }) : null;
    store.db.query('UPDATE executions SET output_bytes=output_bytes+?,output_seen=output_seen+?,output_seq=?,truncated=?,error_json=coalesce(error_json,?) WHERE execution_id=?')
      .run(stored, incoming.length, seq, row.truncated || stored < incoming.length ? 1 : 0, outputError, execution_id);
  });
}
export function safeCwd(workspace, relative = '.') {
  check(typeof relative === 'string' && relative.length <= 4096 && !relative.includes('\0') && !relative.includes('\\')
    && !path.isAbsolute(relative) && !/^[A-Za-z]:/.test(relative)
    && (relative === '.' || relative.split('/').every(part => part && part !== '.' && part !== '..')),
  'INVALID_REQUEST', 'Command cwd must be workspace-relative');
  const root = workspace.directory;
  let current = root;
  const rootStat = fs.lstatSync(root, { bigint: true });
  check(rootStat.isDirectory() && !rootStat.isSymbolicLink() && fs.realpathSync(root) === root
    && String(rootStat.dev) === workspace.dev && String(rootStat.ino) === workspace.ino, 'STALE', 'Workspace identity changed');
  if (relative !== '.') for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'UNAUTHORIZED', 'Command cwd contains a symlink or non-directory');
  }
  return current;
}
const BASE_ENV = Object.freeze({ PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
const DENY_ENV = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|API_KEY|SOCKET)|^(?:LUSH|PI_|OPENAI|ANTHROPIC|CODEX|GIT_CONFIG|LD_|DYLD_|BASH_ENV$|ENV$|NODE_OPTIONS$|BUN_OPTIONS$|SSH_)/i;
export function commandSpec(ctx, params, config) {
  check((params.script !== undefined) !== (params.argv !== undefined), 'INVALID_REQUEST', 'Provide exactly one script or argv');
  let argv;
  if (params.script !== undefined) {
    check(typeof params.script === 'string' && Buffer.byteLength(params.script) <= 64 * 1024 && !params.script.includes('\0'), 'INVALID_REQUEST', 'Invalid shell script');
    argv = ['/bin/bash', '--noprofile', '--norc', '-c', params.script];
  } else {
    check(Array.isArray(params.argv) && params.argv.length > 0 && params.argv.length <= 256
      && params.argv.every(arg => typeof arg === 'string' && !arg.includes('\0'))
      && Buffer.byteLength(JSON.stringify(params.argv)) <= 64 * 1024 && params.argv[0], 'INVALID_REQUEST', 'Invalid command argv');
    argv = [...params.argv];
  }
  const cwd = params.cwd ?? '.';
  safeCwd(ctx.workspace, cwd);
  const env = params.env ?? {};
  check(env && typeof env === 'object' && !Array.isArray(env), 'INVALID_REQUEST', 'Invalid command environment');
  const allowed = new Set(config.command_env_allowlist ?? ['CI', 'TERM', 'NO_COLOR', 'FORCE_COLOR']);
  for (const [name, value] of Object.entries(env)) {
    check(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && allowed.has(name) && !DENY_ENV.test(name)
      && !['PATH', 'HOME', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME'].includes(name)
      && typeof value === 'string' && value.length <= 8192 && !value.includes('\0'), 'UNAUTHORIZED', 'Command environment key is not authorized');
  }
  check(Buffer.byteLength(stable(env)) <= 32768, 'LIMIT_EXCEEDED', 'Command environment exceeds budget');
  const commandPath = config.command_path ?? BASE_ENV.PATH;
  check(typeof commandPath === 'string' && commandPath.length <= 8192 && commandPath.split(':').every(part => path.isAbsolute(part) && !part.includes('\0')),
    'INVALID_REQUEST', 'Invalid node command search path');
  const commandMax = Math.min(LIMITS.max_command_ms, config.limits?.max_command_ms ?? LIMITS.max_command_ms,
    config.limits?.command_ms ?? LIMITS.max_command_ms, config.budgets?.timeout_ms ?? LIMITS.max_command_ms);
  const outputMax = Math.min(LIMITS.output_bytes, config.limits?.output_bytes ?? LIMITS.output_bytes,
    config.budgets?.output_bytes ?? LIMITS.output_bytes);
  return { argv, cwd, env: { ...BASE_ENV, PATH: commandPath, ...env }, resources_version: 1,
    command_ms: integer(params.command_ms ?? Math.min(config.limits?.command_ms ?? LIMITS.command_ms, commandMax), 'command_ms', 1, commandMax),
    queue_ms: integer(params.queue_ms ?? LIMITS.queue_ms, 'queue_ms', 1, LIMITS.max_command_ms),
    output_bytes: integer(params.output_bytes ?? outputMax, 'output_bytes', 1, outputMax),
    output_storage_bytes: integer(config.output_storage_bytes ?? DEFAULT_OUTPUT_STORAGE_BYTES, 'output_storage_bytes', OUTPUT_CHUNK_STORAGE_BYTES + 1),
    node_id: config.node_id, cgroup_root: config.cgroup_root,
    max_commands: integer(Math.min(config.max_commands ?? 1, config.budgets?.max_commands ?? 64), 'max_commands', 1, 64),
    memory_reserve_bytes: config.memory_reserve_bytes ?? 512 * 1024 * 1024 };
}
