import fs from 'node:fs';
import { check, LushError } from '../core/types.js';
import { DaemonLock } from '../daemon/locking.js';
import { RPCServer } from '../rpc/server.js';
import { AdministratorStore } from './store.js';
import { administratorPaths, administratorHome, assertPrivateFile, ensurePrivateDirectory, readControlSecret, sameSecret, writePrivateJSON } from './paths.js';
import { ADMINISTRATOR_MODE, ADMINISTRATOR_SCOPE, ADMINISTRATOR_LIMITS } from './protocol.js';
import { ADMINISTRATOR_RPC } from './runtime-protocol.js';
import { strictFields, userBinding, runtimeFailure, decodeStored } from './runtime-safety.js';

const RETIRED = '全局管理员创建与执行已退役；请在当前项目的管家输入中选择单条密码提权。';
const retired = () => { throw new LushError(RETIRED, -32062); };
function pageOptions(value = {}, detail = false) {
  strictFields(value, detail ? ['id', 'before', 'limit'] : ['before', 'limit'], detail ? ['id'] : []);
  const limit = value.limit ?? 30, before = value.before ?? null;
  check(Number.isSafeInteger(limit) && limit >= 1 && limit <= ADMINISTRATOR_LIMITS.page, 'administrator limit must be 1..100');
  check(before === null || typeof before === 'string' && /^[1-9]\d*$/.test(before) && Number.isSafeInteger(Number(before)), 'invalid administrator cursor');
  if (detail) check(typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.id), 'invalid administrator Worker id');
  return { ...value, before, limit };
}

/** D737 legacy history/stop adapter only. D738 runs new work in native project management. */
export class AdministratorService {
  constructor({ env = process.env, home = administratorHome(env), clock = Date.now } = {}) {
    this.paths = administratorPaths(home); this.clock = clock; this.closed = false; this.closing = null; this.server = null;
    ensurePrivateDirectory(this.paths.home); ensurePrivateDirectory(this.paths.socketDir);
    assertPrivateFile(`${this.paths.home}/daemon.lock`, { missing: true });
    this.lock = new DaemonLock(this.paths.home); this.lock.acquire();
    try {
      this.control = readControlSecret(this.paths, true);
      this.store = new AdministratorStore(this.paths.database); this.serviceId = this.store.serviceId;
      this.recover();
    } catch (error) { this.store?.close(); this.lock.release(); throw error; }
  }
  now() { return new Date(this.clock()).toISOString(); }
  event(workerId, instructionId, type, data = {}) { return this.store.event(workerId, instructionId, type, data, this.now()); }
  firstInstructionFailure(instructionId, fallback) {
    const recorded = this.store.get(`SELECT json_extract(data,'$.original_failure') AS original_failure FROM events
      WHERE instruction_id=? AND type IN ('tool.failed','tool.returned','tool.completion_not_observed')
      AND json_type(data,'$.original_failure')='object' ORDER BY id LIMIT 1`, instructionId);
    return decodeStored(recorded?.original_failure) ?? fallback;
  }
  recover() {
    this.store.transaction(() => {
      const failure = runtimeFailure('recovery');
      for (const input of this.store.all("SELECT * FROM messages WHERE status='running'")) {
        const original = this.firstInstructionFailure(input.id, failure);
        this.store.run("UPDATE messages SET status='unknown',effect='unknown',finished_at=?,error=?,original_failure=COALESCE(original_failure,?) WHERE id=?", this.now(), failure.message, JSON.stringify(original), input.id);
        this.store.run("UPDATE workers SET status='unknown',error=?,original_failure=COALESCE(original_failure,?),updated_at=?,revision=revision+1 WHERE id=?", failure.message, JSON.stringify(original), this.now(), input.worker_id);
        this.store.run("UPDATE agent_runs SET status='unknown',token_hash=NULL,finished_at=?,error=?,original_failure=COALESCE(original_failure,?) WHERE instruction_id=? AND status='running'", this.now(), failure.message, JSON.stringify(original), input.id);
        this.event(input.worker_id, input.id, 'instruction.recovery_unknown', { original_failure: original });
      }
      this.store.run("UPDATE agent_runs SET status='unknown',token_hash=NULL,finished_at=?,error=?,original_failure=COALESCE(original_failure,?) WHERE status='running'", this.now(), failure.message, JSON.stringify(failure));
      for (const call of this.store.all("SELECT * FROM tool_calls WHERE status='running'")) {
        this.store.run("UPDATE tool_calls SET status='unknown',effect='unknown',finished_at=?,error=?,original_failure=COALESCE(original_failure,?) WHERE id=?", this.now(), failure.message, JSON.stringify(failure), call.id);
        this.event(call.worker_id, call.instruction_id, 'tool.recovery_unknown', { call_id: call.id, operation: call.operation, original_failure: failure });
      }
      this.store.run("UPDATE workers SET status='stopped',updated_at=? WHERE status='stopping' OR stopped_at IS NOT NULL", this.now());
      // Cancel only provably unstarted legacy work; never replay it on a history-service restart.
      for (const input of this.store.all("SELECT id,worker_id FROM messages WHERE status='queued'")) {
        this.store.run("UPDATE messages SET status='cancelled',effect='not_started',finished_at=? WHERE id=?", this.now(), input.id);
        this.store.run("UPDATE workers SET status='stopped',stopped_at=COALESCE(stopped_at,?),updated_at=?,revision=revision+1 WHERE id=? AND status='queued'", this.now(), this.now(), input.worker_id);
        this.event(input.worker_id, input.id, 'instruction.retired_unstarted', { effect: 'not_started', history_preserved: true });
      }
    });
  }
  workerView(row) {
    return { id: row.id, worker_number: row.worker_number, name: row.name, mode: row.mode, scope: row.scope,
      task_kind: 'administrator', role: 'administrator', status: row.status, recorded_status: row.status,
      created_at: row.created_at, updated_at: row.updated_at, can_input: false, retired: true, reason: RETIRED,
      result: decodeStored(row.result), error: row.error, original_failure: decodeStored(row.original_failure),
      stopped_at: row.stopped_at, running: false,
      effect: this.store.get('SELECT effect FROM messages WHERE worker_id=? ORDER BY rowid DESC LIMIT 1', row.id)?.effect ?? 'not_started' };
  }
  instructionView(row) {
    return { id: row.id, worker_id: row.worker_id, instruction: row.instruction, status: row.status, created_at: row.created_at,
      started_at: row.started_at, finished_at: row.finished_at, result: decodeStored(row.result), error: row.error,
      original_failure: decodeStored(row.original_failure), effect: row.effect };
  }
  status() { return { version: 1, online: true, retired: true, service_id: this.serviceId, pid: process.pid,
    mode: ADMINISTRATOR_MODE, scope: ADMINISTRATOR_SCOPE, stopping: Boolean(this.closing), active: 0, coverage: 'legacy_administrator_history_only' }; }
  list(options = {}) {
    const { before, limit } = pageOptions(options);
    const rows = this.store.all(`SELECT rowid AS cursor,* FROM workers ${before ? 'WHERE rowid<?' : ''} ORDER BY rowid DESC LIMIT ?`, ...(before ? [Number(before)] : []), limit + 1);
    const items = []; let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const value = this.workerView(row), size = Buffer.byteLength(JSON.stringify(value));
      if (bytes + size > 800000) break;
      items.push({ row, value }); bytes += size;
    }
    return { version: 1, online: true, retired: true, items: items.map(item => item.value), next_cursor: items.length ? String(items.at(-1).row.cursor) : null,
      has_more: rows.length > items.length, coverage: 'legacy_administrator_workers_only' };
  }
  detail(options) {
    const { id, before, limit } = pageOptions(options, true), worker = this.workerView(this.store.worker(id));
    const rows = this.store.all(`SELECT * FROM events WHERE worker_id=? ${before ? 'AND id<?' : ''} ORDER BY id DESC LIMIT ?`, id, ...(before ? [Number(before)] : []), limit + 1);
    const events = [], instructions = new Map();
    if (!before) {
      const latest = this.store.get('SELECT * FROM messages WHERE worker_id=? ORDER BY rowid DESC LIMIT 1', id);
      if (latest) instructions.set(latest.id, { ...this.instructionView(latest), result: null, result_available_on_worker: true });
    }
    for (const row of rows.slice(0, limit)) {
      const item = { id: row.id, type: row.type, created_at: row.created_at, instruction_id: row.instruction_id, data: decodeStored(row.data) };
      const associated = row.type === 'instruction.confirmed' && row.instruction_id && !instructions.has(row.instruction_id) ? this.instructionView(this.store.instruction(row.instruction_id)) : null;
      if (Buffer.byteLength(JSON.stringify({ worker, events: [...events, item], instructions: [...instructions.values(), ...(associated ? [associated] : [])] })) > 800000) break;
      if (associated) instructions.set(associated.id, associated);
      events.push(item);
    }
    return { version: 1, online: true, retired: true, worker, instructions: [...instructions.values()], events: events.reverse(),
      next_cursor: events.length ? String(Math.min(...events.map(row => row.id))) : null, has_more: rows.length > events.length,
      coverage: 'legacy_current_input_and_event_page_with_linked_inputs', history_complete: false, truncated: rows.length > events.length };
  }
  receipt(options, binding) {
    strictFields(options, ['client_request_id'], ['client_request_id']); userBinding(binding);
    check(typeof options.client_request_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(options.client_request_id), 'invalid administrator request identity');
    const confirmation = this.store.get(`SELECT definition,receipt FROM confirmations WHERE consumed_at IS NOT NULL
      AND json_extract(definition,'$.client_request_id')=? ORDER BY rowid DESC LIMIT 1`, options.client_request_id);
    if (!confirmation) return { version: 1, found: false };
    const original = decodeStored(confirmation.receipt);
    return { version: 1, found: true, definition: decodeStored(confirmation.definition), worker: this.workerView(this.store.worker(original.worker.id)),
      ...(original.instruction ? { instruction: this.instructionView(this.store.instruction(original.instruction.id)) } : {}) };
  }
  stop(id, binding) {
    userBinding(binding); check(!this.closed, 'administrator service is closed');
    const worker = this.store.worker(id);
    if (!worker.stopped_at) this.store.transaction(() => {
      this.store.run("UPDATE workers SET status='stopped',stopped_at=?,updated_at=?,revision=revision+1 WHERE id=?", this.now(), this.now(), id);
      this.store.run("UPDATE confirmations SET revoked_at=? WHERE consumed_at IS NULL AND json_extract(definition,'$.id')=?", this.now(), id);
      this.event(id, null, 'worker.stop_requested', { owner_present: false, history_preserved: true });
    });
    return { version: 1, worker: this.workerView(this.store.worker(id)) };
  }
  preview() { return retired(); }
  commit() { return retired(); }
  authenticateInvocation() { return retired(); }
  catalog() { return retired(); }
  call() { return retired(); }
  kick() { /* History startup never launches an Agent. */ }
  begin() { return retired(); }
  async dispatch(method, params = {}) {
    try {
      check(!this.closed, 'administrator service is closed');
      if ([ADMINISTRATOR_RPC.preview, ADMINISTRATOR_RPC.commit, ADMINISTRATOR_RPC.toolCatalog, ADMINISTRATOR_RPC.toolCall].includes(method)) return retired();
      const allowed = { [ADMINISTRATOR_RPC.status]: [], [ADMINISTRATOR_RPC.list]: ['options'], [ADMINISTRATOR_RPC.detail]: ['options'],
        [ADMINISTRATOR_RPC.receipt]: ['options', 'user_binding'], [ADMINISTRATOR_RPC.stop]: ['id', 'user_binding'], [ADMINISTRATOR_RPC.shutdown]: ['user_binding'] };
      check(Object.hasOwn(allowed, method), 'unknown administrator method');
      strictFields(params, ['control', ...allowed[method]], ['control', ...allowed[method]]);
      check(sameSecret(params.control, this.control), 'administrator user control identity required');
      switch (method) {
        case ADMINISTRATOR_RPC.status: return this.status();
        case ADMINISTRATOR_RPC.list: return this.list(params.options);
        case ADMINISTRATOR_RPC.detail: return this.detail(params.options);
        case ADMINISTRATOR_RPC.receipt: return this.receipt(params.options, params.user_binding);
        case ADMINISTRATOR_RPC.stop: return this.stop(params.id, params.user_binding);
        case ADMINISTRATOR_RPC.shutdown:
          userBinding(params.user_binding);
          setTimeout(() => this.close(), 25).unref();
          return { version: 1, stopping: true, active: 0 };
      }
    } catch (error) {
      if (error instanceof LushError) throw error;
      throw new LushError('legacy administrator history request failed; do not replay historical effects', -32060);
    }
  }
  async start() {
    check(!this.closed && !this.server, 'administrator service already started or closed');
    if (assertPrivateFile(this.paths.socket, { missing: true, socket: true })) fs.unlinkSync(this.paths.socket);
    this.server = new RPCServer(this.paths.socket, { dispatch: (method, params) => this.dispatch(method, params), stopping: { isRequested: () => false, set() {} } });
    try {
      await this.server.start();
      writePrivateJSON(this.paths.descriptor, { version: 1, service_id: this.serviceId, pid: process.pid, socket: this.paths.socket, started_at: this.now(), retired: true });
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  async idle() { /* No legacy execution owner exists in this process. */ }
  close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.closed = true;
      await this.server?.close(); this.server = null;
      try { if (assertPrivateFile(this.paths.socket, { missing: true, socket: true })) fs.unlinkSync(this.paths.socket); } catch { /* Do not remove foreign ownership. */ }
      this.store.close(); this.lock.release(); this.onClosed?.();
    })();
    return this.closing;
  }
}
