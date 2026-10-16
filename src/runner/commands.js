import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createCgroupController, commandGroupName } from './cgroup.js';
import { ACTIVE_COMMAND_STATES, authorityActive, authorizedExecution, commandSpec, executionRow,
  executionView, finishExecution, outputStorageUsed, OUTPUT_CHUNK_STORAGE_BYTES } from './command-state.js';
import { LIMITS, check, hash, integer, stable } from './protocol.js';

function productionAdapter(config) {
  const controller = createCgroupController(config);
  return {
    preflight: controller.preflight, availableMemory: controller.availableMemory,
    launch({ root, execution_id }) {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./command-guard.js', import.meta.url))], {
        detached: true, env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.stdin.on('error', () => {});
      // Do not close stdin: EOF is the independent guard's parent-death signal.
      child.stdin.write(JSON.stringify({ root, execution_id }) + '\n');
      return child;
    },
    async reconcile(row) {
      const spec = JSON.parse(row.spec_json), receipt = spec.containment;
      check(receipt && ['not_started', 'exited'].includes(spec.bootstrap_state)
        && row.cgroup_name === commandGroupName(row) && receipt.name === row.cgroup_name
        && spec.node_id === config.node_id && spec.cgroup_root === config.cgroup_root,
      'UNKNOWN', 'Command containment ownership cannot be reconciled');
      await controller.stop(receipt);
      return !controller.populated(receipt);
    },
  };
}

/** Shared SQLite admission, independent watchdogs, no local-shell fallback. */
export function createCommandService({ store, config, process_adapter }) {
  const adapter = process_adapter ?? productionAdapter(config);
  const sessions = new Set(), guards = new Map(), reconciling = new Map();
  let closed = false, ticking = false;
  const preflight = () => adapter.preflight();
  const activeRows = () => store.db.query(`SELECT * FROM executions WHERE stop_confirmed=0 AND state IN ('starting','running','stopping','unknown')`).all();
  function markUnknown(id) {
    const row = executionRow(store, id);
    if (row && !row.stop_confirmed) finishExecution(store, row, { reason: 'guard_lost', stop_confirmed: false, output_complete: false, unknown: true });
  }
  function reconcile(row) {
    if (reconciling.has(row.execution_id) || guards.has(row.execution_id)) return;
    const pending = (async () => {
      try {
        const confirmed = await adapter.reconcile(row);
        finishExecution(store, row, { reason: 'reconciled_unknown', stop_confirmed: Boolean(confirmed), output_complete: false, unknown: true });
      } catch { markUnknown(row.execution_id); }
    })().finally(() => reconciling.delete(row.execution_id));
    reconciling.set(row.execution_id, pending);
    return pending;
  }
  function cancelRow(row, reason) {
    store.transaction(() => {
      const fresh = executionRow(store, row.execution_id);
      if (!fresh || fresh.stop_confirmed) return;
      if (fresh.state === 'queued') finishExecution(store, fresh, { reason, stop_confirmed: true });
      else if (!['unknown', 'stopping'].includes(fresh.state)) store.db.query("UPDATE executions SET state='stopping',reason=? WHERE execution_id=? AND stop_confirmed=0")
        .run(reason, row.execution_id);
    });
  }
  function claim(row) {
    return store.transaction(() => {
      const fresh = executionRow(store, row.execution_id);
      if (!fresh || fresh.state !== 'queued' || !sessions.has(fresh.session_id) || closed) return false;
      if (!authorityActive(store, fresh)) { finishExecution(store, fresh, { reason: 'revoked', stop_confirmed: true }); return false; }
      if (fresh.queue_deadline <= Date.now()) { finishExecution(store, fresh, { reason: 'queue_timeout', stop_confirmed: true }); return false; }
      const active = activeRows();
      const max = Math.min(config.max_commands ?? 1, config.budgets?.max_commands ?? 64,
        ...active.map(item => JSON.parse(item.spec_json).max_commands ?? 1));
      if (active.length >= max) return false;
      const reserve = Math.max(config.memory_reserve_bytes ?? 512 * 1024 * 1024,
        ...active.map(item => JSON.parse(item.spec_json).memory_reserve_bytes ?? 0));
      if ((adapter.availableMemory?.() ?? os.freemem()) < reserve) return false;
      // FIFO among still-authorized queued work across all projects/connections on this node.
      const earlier = store.db.query("SELECT * FROM executions WHERE state='queued' AND (created_at<? OR (created_at=? AND execution_id<?))")
        .all(fresh.created_at, fresh.created_at, fresh.execution_id);
      if (earlier.some(item => item.queue_deadline > Date.now() && authorityActive(store, item))) return false;
      return store.db.query("UPDATE executions SET state='starting' WHERE execution_id=? AND state='queued'").run(fresh.execution_id).changes === 1;
    });
  }
  async function tick() {
    if (closed || ticking) return;
    ticking = true;
    try {
      // Expired foreign queues cannot block FIFO forever; no historical PID is inspected or killed.
      for (const row of store.db.query("SELECT * FROM executions WHERE stop_confirmed=0 AND state='queued'").all()) {
        if (!authorityActive(store, row)) cancelRow(row, 'revoked');
        else if (row.queue_deadline <= Date.now()) cancelRow(row, 'queue_timeout');
      }
      for (const row of activeRows()) {
        if (row.state === 'unknown' || !authorityActive(store, row)) {
          if (row.state !== 'unknown') cancelRow(row, 'revoked');
          if (!guards.has(row.execution_id)) void reconcile(row);
        }
      }
      for (const row of store.db.query("SELECT * FROM executions WHERE state='queued' ORDER BY created_at,execution_id").all()) {
        if (!sessions.has(row.session_id)) continue;
        if (!claim(row)) continue;
        try {
          const child = adapter.launch({ root: store.root, execution_id: row.execution_id, config });
          guards.set(row.execution_id, child);
          child.once('error', () => { if (!closed) markUnknown(row.execution_id); });
          child.once('close', () => { guards.delete(row.execution_id); if (!closed) markUnknown(row.execution_id); });
        } catch { markUnknown(row.execution_id); }
      }
    } finally { ticking = false; }
  }
  const timer = setInterval(() => { void tick().catch(() => { /* Durable rows retain their safety barriers. */ }); }, 25);
  timer.unref?.();
  async function awaitStopped(rows, reason) {
    for (const row of rows) cancelRow(row, reason);
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      const pending = rows.map(row => executionRow(store, row.execution_id)).filter(row => row && !row.stop_confirmed);
      if (!pending.length) return;
      for (const row of pending) if (!guards.has(row.execution_id)) void reconcile(row);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    // Caller receives unknown via workspace.barrier; never equate a cancellation request to stopping.
    for (const row of rows) if (!executionRow(store, row.execution_id)?.stop_confirmed) markUnknown(row.execution_id);
  }
  const services = {
    'command.start': (ctx, params) => {
      check(!closed, 'UNAVAILABLE', 'Command service is closed');
      preflight();
      const spec = commandSpec(ctx, params, config), id = 'cmd-' + hash(`${ctx.identity.project_id}:${ctx.request_id}`);
      spec.params_fingerprint = hash(stable(params));
      const old = executionRow(store, id);
      if (old) {
        check(old.workspace_key === ctx.workspace.workspace_key && stable(JSON.parse(old.identity_json)) === stable(ctx.identity)
          && JSON.parse(old.spec_json).params_fingerprint === spec.params_fingerprint, 'CONFLICT', 'Command request identity changed');
        return executionView(old);
      }
      const created_at = Date.now();
      const row = { execution_id: id, workspace_key: ctx.workspace.workspace_key, request_id: ctx.request_id,
        identity_json: JSON.stringify(ctx.identity), session_id: ctx.session_id, lease_id: ctx.lease?.lease_id ?? null,
        expires_at: ctx.authorization_expires_at, created_at };
      check(authorityActive(store, row), 'UNAUTHORIZED', 'Command authorization expired');
      store.transaction(() => {
        check(outputStorageUsed(store) + OUTPUT_CHUNK_STORAGE_BYTES < spec.output_storage_bytes,
          'LIMIT_EXCEEDED', 'Node output storage capacity reached; logs retained and new commands blocked');
        const waiting = store.db.query("SELECT count(*) AS count FROM executions WHERE state='queued'").get().count;
        check(waiting < LIMITS.max_pending, 'LIMIT_EXCEEDED', 'Node command queue is full');
        const workspace = store.workspace(ctx.identity);
        check(workspace?.busy_request === ctx.request_id, 'BUSY', 'Command does not own workspace mutation gate');
        store.db.query(`INSERT INTO executions (execution_id,workspace_key,request_id,identity_json,session_id,lease_id,
          state,spec_json,cgroup_name,created_at,expires_at,queue_deadline) VALUES (?,?,?,?,?,?,'queued',?,?,?,?,?)`)
          .run(id, row.workspace_key, row.request_id, row.identity_json, row.session_id, row.lease_id,
            JSON.stringify(spec), commandGroupName(row), created_at, row.expires_at, created_at + spec.queue_ms);
      });
      sessions.add(ctx.session_id);
      // The durable queued receipt is returned before asynchronous admission/side effects.
      return executionView(executionRow(store, id));
    },
    'command.status': (ctx, params) => executionView(authorizedExecution(store, ctx, params)),
    'command.output': (ctx, params) => {
      const row = authorizedExecution(store, ctx, params);
      const after = integer(params.after ?? 0, 'after', 0), limit = integer(params.limit ?? 4, 'limit', 1, 8);
      check(after <= row.output_seq, 'STALE', 'Output cursor is ahead of execution');
      const chunks = store.db.query('SELECT seq,stream,data FROM output_chunks WHERE execution_id=? AND seq>? ORDER BY seq LIMIT ?')
        .all(row.execution_id, after, limit);
      let expected = after + 1, gap = false;
      for (const chunk of chunks) { if (chunk.seq !== expected) gap = true; expected = chunk.seq + 1; }
      const next_cursor = chunks.at(-1)?.seq ?? after;
      if (chunks.length < limit && next_cursor < row.output_seq) gap = true;
      return { execution_id: row.execution_id,
        chunks: chunks.map(chunk => ({ seq: chunk.seq, stream: chunk.stream, data: Buffer.from(chunk.data).toString('base64'), encoding: 'base64' })),
        next_cursor, has_more: next_cursor < row.output_seq, gap, truncated: Boolean(row.truncated),
        output_error: row.error_json ? JSON.parse(row.error_json) : null,
        complete: Boolean(row.output_complete) && next_cursor === row.output_seq && !gap, ...{ output_seen: row.output_seen, output_bytes: row.output_bytes } };
    },
    'command.cancel': async (ctx, params) => {
      const row = authorizedExecution(store, ctx, params);
      await awaitStopped([row], 'cancelled');
      return executionView(executionRow(store, row.execution_id));
    },
    // Internal Run release seam. Keep both ownership predicates; never fall back to workspace-wide stop.
    stop_lease: async (key, lease_id) => awaitStopped(store.db.query('SELECT * FROM executions WHERE workspace_key=? AND lease_id=? AND stop_confirmed=0')
      .all(key, lease_id), 'revoked'),
    stop_workspace: async key => awaitStopped(store.db.query('SELECT * FROM executions WHERE workspace_key=? AND stop_confirmed=0').all(key), 'revoked'),
    disconnect: async session_id => {
      sessions.delete(session_id);
      const rows = store.db.query('SELECT * FROM executions WHERE session_id=? AND stop_confirmed=0').all(session_id);
      // Dropping guard stdin independently stops even if this process is killed before writing cancellation.
      for (const row of rows) guards.get(row.execution_id)?.stdin.end();
      await awaitStopped(rows, 'disconnected');
    },
    close: async () => {
      if (closed) return;
      closed = true; clearInterval(timer);
      for (const session of [...sessions]) await services.disconnect(session);
      const children = [...guards.values()];
      for (const child of children) child.stdin.end();
      // Do not kill guards that still own an uncertain cgroup. They finish their bounded watchdog themselves.
      await Promise.all([...reconciling.values()]);
    },
  };
  return { services, preflight };
}
