import fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { check, isPlainObject, LushError } from '../core/types.js';
import { DaemonLock } from '../daemon/locking.js';
import { RPCServer } from '../rpc/server.js';
import { AdministratorStore } from './store.js';
import { administratorPaths, administratorHome, assertPrivateFile, ensurePrivateDirectory, readControlSecret, sameSecret, digest, writePrivateJSON } from './paths.js';
import { ADMINISTRATOR_MODE, ADMINISTRATOR_SCOPE, ADMINISTRATOR_RISK, ADMINISTRATOR_LIMITS, normalizeAdministratorDefinition, administratorDefinitionText } from './protocol.js';
import { ADMINISTRATOR_RPC, ADMINISTRATOR_TOOL_RPC } from './runtime-protocol.js';
import { strictFields, userBinding, stableJSON, safeRuntimeValue, runtimeFailure, sampledRuntimeFailure, decodeStored } from './runtime-safety.js';

const newId = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const nowISO = clock => new Date(clock()).toISOString();
function pageOptions(value = {}, detail = false) {
  strictFields(value, detail ? ['id', 'before', 'limit'] : ['before', 'limit'], detail ? ['id'] : []);
  const limit = value.limit ?? 30;
  check(Number.isSafeInteger(limit) && limit >= 1 && limit <= ADMINISTRATOR_LIMITS.page, 'administrator limit must be 1..100');
  const before = value.before ?? null;
  check(before === null || typeof before === 'string' && /^[1-9]\d*$/.test(before) && Number.isSafeInteger(Number(before)), 'invalid administrator cursor');
  if (detail) check(typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.id), 'invalid administrator Worker id');
  return { ...value, before, limit };
}
function definition(value) {
  try { return normalizeAdministratorDefinition(value); }
  catch { throw new LushError('invalid administrator definition', -32602); }
}

/** Independent device runtime. Only this service owns its Workers, invocations and receipts. */
export class AdministratorService {
  constructor({ env = process.env, home = administratorHome(env), runner = null, executor = null, clock = Date.now } = {}) {
    this.paths = administratorPaths(home); this.env = env; this.clock = clock;
    this.runner = runner; this.executor = executor; this.owners = new Map(); this.closed = false;
    this.closing = null; this.server = null; this.shutdownRequested = false;
    ensurePrivateDirectory(this.paths.home); ensurePrivateDirectory(this.paths.socketDir);
    assertPrivateFile(`${this.paths.home}/daemon.lock`, { missing: true });
    this.lock = new DaemonLock(this.paths.home); this.lock.acquire();
    try {
      this.control = readControlSecret(this.paths, true);
      this.store = new AdministratorStore(this.paths.database);
      this.serviceId = this.store.serviceId;
      this.recover();
    } catch (error) { this.store?.close(); this.lock.release(); throw error; }
  }
  now() { return nowISO(this.clock); }
  secrets() { return [this.control, ...[...this.owners.values()].map(owner => owner.token)]; }
  event(workerId, instructionId, type, data = {}) {
    return this.store.event(workerId, instructionId, type, safeRuntimeValue(data, this.secrets()), this.now());
  }
  firstInstructionFailure(instructionId, fallback) {
    const recorded = this.store.get(`SELECT json_extract(data,'$.original_failure') AS original_failure FROM events
      WHERE instruction_id=? AND type IN ('tool.failed','tool.returned','tool.completion_not_observed')
      AND json_type(data,'$.original_failure')='object' ORDER BY id LIMIT 1`, instructionId);
    return decodeStored(recorded?.original_failure) ?? fallback;
  }
  recover() {
    this.store.transaction(() => {
      const failure = runtimeFailure('recovery');
      for (const message of this.store.all("SELECT * FROM messages WHERE status='running'")) {
        const original = this.firstInstructionFailure(message.id, failure);
        this.store.run("UPDATE messages SET status='unknown',effect='unknown',finished_at=?,error=?,original_failure=COALESCE(original_failure,?) WHERE id=?",
          this.now(), failure.message, JSON.stringify(original), message.id);
        this.store.run("UPDATE workers SET status='unknown',error=?,original_failure=COALESCE(original_failure,?),updated_at=?,revision=revision+1 WHERE id=?",
          failure.message, JSON.stringify(original), this.now(), message.worker_id);
        this.store.run("UPDATE agent_runs SET status='unknown',token_hash=NULL,finished_at=?,error=?,original_failure=COALESCE(original_failure,?) WHERE instruction_id=? AND status='running'",
          this.now(), failure.message, JSON.stringify(original), message.id);
        this.event(message.worker_id, message.id, 'instruction.recovery_unknown', { original_failure: original });
      }
      this.store.run("UPDATE agent_runs SET status='unknown',token_hash=NULL,finished_at=?,error=?,original_failure=COALESCE(original_failure,?) WHERE status='running'",
        this.now(), failure.message, JSON.stringify(failure));
      for (const call of this.store.all("SELECT * FROM tool_calls WHERE status='running'")) {
        this.store.run("UPDATE tool_calls SET status='unknown',effect='unknown',finished_at=?,error=?,original_failure=COALESCE(original_failure,?) WHERE id=?",
          this.now(), failure.message, JSON.stringify(failure), call.id);
        this.event(call.worker_id, call.instruction_id, 'tool.recovery_unknown', { call_id: call.id, operation: call.operation, original_failure: failure });
      }
      // A durable stop never turns back into a live authorization after process death.
      this.store.run("UPDATE workers SET status='stopped',updated_at=? WHERE status='stopping' OR stopped_at IS NOT NULL", this.now());
      this.store.run("UPDATE messages SET status='cancelled',effect='not_started',finished_at=? WHERE status='queued' AND worker_id IN (SELECT id FROM workers WHERE stopped_at IS NOT NULL)", this.now());
    });
  }
  canInput(row) {
    return !this.closed && !this.shutdownRequested && !row.stopped_at && row.status === 'ready' && !this.owners.has(row.id)
      && !this.store.get("SELECT id FROM messages WHERE worker_id=? AND status IN ('queued','running','unknown') LIMIT 1", row.id)
      && !this.store.get("SELECT id FROM tool_calls WHERE worker_id=? AND status IN ('running','unknown') LIMIT 1", row.id);
  }
  workerView(row) {
    const completionMissing = row.status === 'running' && !this.owners.has(row.id);
    const diagnostic = completionMissing ? this.completionFailure ?? runtimeFailure('recovery') : row.status === 'queued' ? this.startFailure : null;
    return { id: row.id, worker_number: row.worker_number, name: row.name, mode: row.mode, scope: row.scope,
      task_kind: 'administrator', role: 'administrator', status: completionMissing ? 'unknown' : row.status, recorded_status: row.status,
      created_at: row.created_at, updated_at: row.updated_at,
      can_input: Boolean(this.canInput(row)), result: completionMissing ? null : decodeStored(row.result), error: row.error ?? diagnostic?.message ?? null,
      original_failure: decodeStored(row.original_failure) ?? diagnostic ?? null, stopped_at: row.stopped_at,
      running: this.owners.has(row.id), effect: this.store.get('SELECT effect FROM messages WHERE worker_id=? ORDER BY rowid DESC LIMIT 1', row.id)?.effect ?? 'not_started' };
  }
  instructionView(row) {
    return { id: row.id, worker_id: row.worker_id, instruction: row.instruction, status: row.status,
      created_at: row.created_at, started_at: row.started_at, finished_at: row.finished_at,
      result: decodeStored(row.result), error: row.error, original_failure: decodeStored(row.original_failure), effect: row.effect };
  }
  callView(row) {
    return { id: row.id, operation: row.operation, status: row.status, effect: row.effect,
      created_at: row.created_at, finished_at: row.finished_at, error: row.error, original_failure: decodeStored(row.original_failure) };
  }
  status() {
    return { version: 1, online: true, service_id: this.serviceId, pid: process.pid, mode: ADMINISTRATOR_MODE, scope: ADMINISTRATOR_SCOPE,
      stopping: this.shutdownRequested, active: this.owners.size, coverage: 'administrator_service_only' };
  }
  list(options = {}) {
    const { before, limit } = pageOptions(options);
    const rows = this.store.all(`SELECT rowid AS cursor,* FROM workers ${before ? 'WHERE rowid<?' : ''} ORDER BY rowid DESC LIMIT ?`, ...(before ? [Number(before)] : []), limit + 1);
    const items = []; let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const value = this.workerView(row), size = Buffer.byteLength(JSON.stringify(value));
      if (bytes + size > 800000) break;
      items.push({ row, value }); bytes += size;
    }
    return { version: 1, online: true, items: items.map(item => item.value), next_cursor: items.length ? String(items.at(-1).row.cursor) : null,
      has_more: rows.length > items.length, coverage: 'administrator_workers_only' };
  }
  detail(options) {
    const { id, before, limit } = pageOptions(options, true);
    const worker = this.workerView(this.store.worker(id));
    const rows = this.store.all(`SELECT * FROM events WHERE worker_id=? ${before ? 'AND id<?' : ''} ORDER BY id DESC LIMIT ?`, id, ...(before ? [Number(before)] : []), limit + 1);
    const events = [], instructions = new Map();
    // Include current input on the first page even when a long transcript has moved its submission off page.
    if (!before) {
      const latest = this.store.get('SELECT * FROM messages WHERE worker_id=? ORDER BY rowid DESC LIMIT 1', id);
      if (latest) instructions.set(latest.id, { ...this.instructionView(latest), result: null, result_available_on_worker: true });
    }
    for (const row of rows.slice(0, limit)) {
      const item = { id: row.id, type: row.type, created_at: row.created_at, instruction_id: row.instruction_id, data: decodeStored(row.data) };
      const associated = row.type === 'instruction.confirmed' && row.instruction_id && !instructions.has(row.instruction_id)
        ? this.instructionView(this.store.instruction(row.instruction_id)) : null;
      const size = Buffer.byteLength(JSON.stringify({ worker, events: [...events, item], instructions: [...instructions.values(), ...(associated ? [associated] : [])] }));
      if (size > 800000) break;
      if (associated) instructions.set(associated.id, associated);
      events.push(item);
    }
    return { version: 1, online: true, worker, instructions: [...instructions.values()], events: events.reverse(),
      next_cursor: events.length ? String(Math.min(...events.map(row => row.id))) : null, has_more: rows.length > events.length,
      coverage: 'current_input_and_event_page_with_linked_inputs', history_complete: false, truncated: rows.length > events.length };
  }
  preview(value, binding) {
    check(!this.closed && !this.shutdownRequested, 'administrator service is stopping');
    userBinding(binding);
    const normalized = definition(value), text = administratorDefinitionText(normalized);
    let revision = null;
    if (normalized.kind === 'input') {
      const worker = this.store.worker(normalized.id);
      check(this.canInput(worker), 'administrator Worker cannot accept new input; inspect state and effects');
      revision = worker.revision;
    }
    const confirmationId = newId('confirmation'), expires = this.clock() + ADMINISTRATOR_LIMITS.confirmationSeconds * 1000;
    this.store.transaction(() => {
      this.store.run('INSERT INTO confirmations(id,binding_hash,definition,definition_hash,worker_revision,expires_at,created_at) VALUES (?,?,?,?,?,?,?)',
        confirmationId, digest(binding), text, digest(text), revision, expires, this.now());
      this.event(normalized.kind === 'input' ? normalized.id : null, null, 'authorization.previewed',
        { kind: normalized.kind, definition_hash: digest(text), mode: normalized.mode, scope: normalized.scope });
    });
    return { version: 1, confirmation_id: confirmationId, expires_at: new Date(expires).toISOString(), definition: normalized, risk: ADMINISTRATOR_RISK };
  }
  commit(body, binding) {
    check(!this.closed && !this.shutdownRequested, 'administrator service is stopping');
    strictFields(body, ['confirmation_id', 'definition', 'confirm'], ['confirmation_id', 'definition', 'confirm']);
    check(body.confirm === true && typeof body.confirmation_id === 'string', 'exact user confirmation required'); userBinding(binding);
    const normalized = definition(body.definition), text = administratorDefinitionText(normalized);
    const receipt = this.store.transaction(() => {
      const confirmation = this.store.get('SELECT * FROM confirmations WHERE id=?', body.confirmation_id);
      check(confirmation && sameSecret(confirmation.binding_hash, digest(binding)), 'administrator confirmation does not belong to this user session');
      check(confirmation.definition === text && confirmation.definition_hash === digest(text), 'administrator confirmation content or permission mode changed');
      // Exact retries return the original identity without restoring stopped/failed authority.
      if (confirmation.consumed_at) {
        const original = decodeStored(confirmation.receipt);
        return { ...original, worker: this.workerView(this.store.worker(original.worker.id)),
          ...(original.instruction ? { instruction: this.instructionView(this.store.instruction(original.instruction.id)) } : {}) };
      }
      check(!confirmation.revoked_at && confirmation.expires_at > this.clock(), 'administrator confirmation expired or revoked');
      // Re-previewing an already committed exact request does not create a second identity or instruction.
      const prior = this.store.get('SELECT receipt,definition FROM confirmations WHERE consumed_at IS NOT NULL AND json_extract(definition,\'$.client_request_id\')=? LIMIT 1', normalized.client_request_id);
      if (prior) {
        check(prior.definition === text, 'administrator request id already belongs to a different definition');
        const original = decodeStored(prior.receipt);
        this.store.run('UPDATE confirmations SET consumed_at=?,receipt=? WHERE id=?', this.now(), JSON.stringify(original), confirmation.id);
        return { ...original, worker: this.workerView(this.store.worker(original.worker.id)),
          ...(original.instruction ? { instruction: this.instructionView(this.store.instruction(original.instruction.id)) } : {}) };
      }
      let result;
      if (normalized.kind === 'create') {
        const id = newId('adm'), number = this.store.nextWorkerNumber();
        this.store.run('INSERT INTO workers(id,worker_number,name,mode,scope,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
          id, number, normalized.name, ADMINISTRATOR_MODE, ADMINISTRATOR_SCOPE, 'ready', this.now(), this.now());
        this.event(id, null, 'worker.created', { worker_number: number, mode: ADMINISTRATOR_MODE, scope: ADMINISTRATOR_SCOPE, definition_hash: digest(text) });
        result = { version: 1, worker: this.workerView(this.store.worker(id)) };
      } else {
        const worker = this.store.worker(normalized.id);
        check(this.canInput(worker) && worker.revision === confirmation.worker_revision, 'administrator Worker changed after confirmation preview');
        const id = newId('input');
        this.store.run('INSERT INTO messages(id,worker_id,client_request_id,instruction,status,created_at) VALUES (?,?,?,?,?,?)',
          id, worker.id, normalized.client_request_id, normalized.instruction, 'queued', this.now());
        this.store.run("UPDATE workers SET status='queued',updated_at=?,revision=revision+1 WHERE id=?", this.now(), worker.id);
        this.event(worker.id, id, 'instruction.confirmed', { definition_hash: digest(text), mode: ADMINISTRATOR_MODE, scope: ADMINISTRATOR_SCOPE });
        result = { version: 1, worker: this.workerView(this.store.worker(worker.id)), instruction: this.instructionView(this.store.instruction(id)) };
      }
      this.store.run('UPDATE confirmations SET consumed_at=?,receipt=? WHERE id=?', this.now(), JSON.stringify(result), confirmation.id);
      return result;
    });
    this.kick();
    return receipt;
  }
  receipt(options, binding) {
    strictFields(options, ['client_request_id'], ['client_request_id']); userBinding(binding);
    check(typeof options.client_request_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(options.client_request_id), 'invalid administrator request identity');
    // Read-only recovery has the same authenticated device-owner scope as list/detail.
    // Re-login may change the Web session binding; it must not make an already saved
    // receipt unreachable. The mutation confirmation itself remains session-bound.
    const confirmation = this.store.get(`SELECT definition,receipt FROM confirmations WHERE consumed_at IS NOT NULL
      AND json_extract(definition,'$.client_request_id')=? ORDER BY rowid DESC LIMIT 1`, options.client_request_id);
    // A miss is only an observation; a concurrently dispatched commit can still finish later.
    if (!confirmation) return { version: 1, found: false };
    const original = decodeStored(confirmation.receipt);
    return { version: 1, found: true, definition: decodeStored(confirmation.definition), worker: this.workerView(this.store.worker(original.worker.id)),
      ...(original.instruction ? { instruction: this.instructionView(this.store.instruction(original.instruction.id)) } : {}) };
  }
  stop(id, binding) {
    userBinding(binding); check(!this.closed, 'administrator service is closed');
    const worker = this.store.worker(id), owner = this.owners.get(id);
    if (worker.stopped_at) return { version: 1, worker: this.workerView(worker) };
    this.store.transaction(() => {
      this.store.run("UPDATE workers SET status=?,stopped_at=?,updated_at=?,revision=revision+1 WHERE id=?", owner ? 'stopping' : 'stopped', this.now(), this.now(), id);
      this.store.run("UPDATE confirmations SET revoked_at=? WHERE consumed_at IS NULL AND json_extract(definition,'$.id')=?", this.now(), id);
      this.store.run("UPDATE messages SET status='cancelled',effect='not_started',finished_at=? WHERE worker_id=? AND status='queued'", this.now(), id);
      if (!owner) {
        const failure = runtimeFailure('recovery');
        for (const input of this.store.all("SELECT id FROM messages WHERE worker_id=? AND status='running'", id)) {
          const original = this.firstInstructionFailure(input.id, failure);
          this.store.run("UPDATE messages SET status='unknown',effect='unknown',error=?,original_failure=COALESCE(original_failure,?),finished_at=? WHERE id=?",
            failure.message, JSON.stringify(original), this.now(), input.id);
          this.store.run('UPDATE workers SET original_failure=COALESCE(original_failure,?) WHERE id=?', JSON.stringify(original), id);
          this.store.run("UPDATE agent_runs SET original_failure=COALESCE(original_failure,?) WHERE instruction_id=? AND status='running'", JSON.stringify(original), input.id);
        }
        this.store.run("UPDATE tool_calls SET status='unknown',effect='unknown',error=?,original_failure=COALESCE(original_failure,?),finished_at=? WHERE worker_id=? AND status='running'",
          failure.message, JSON.stringify(failure), this.now(), id);
        this.store.run("UPDATE agent_runs SET status='unknown',token_hash=NULL,error=?,original_failure=COALESCE(original_failure,?),finished_at=? WHERE worker_id=? AND status='running'",
          failure.message, JSON.stringify(failure), this.now(), id);
      }
      this.event(id, owner?.instructionId ?? null, 'worker.stop_requested', { owner_present: Boolean(owner), history_preserved: true });
    });
    owner?.abort.abort();
    return { version: 1, worker: this.workerView(this.store.worker(id)) };
  }
  authenticateInvocation(token) {
    check(typeof token === 'string' && token.length >= 32 && token.length <= 128, 'active administrator invocation required');
    const owner = [...this.owners.values()].find(value => sameSecret(value.token, token));
    check(owner && !owner.abort.signal.aborted && !this.closed && !this.shutdownRequested, 'active administrator invocation required');
    const worker = this.store.worker(owner.workerId), input = this.store.instruction(owner.instructionId);
    const run = this.store.get('SELECT * FROM agent_runs WHERE id=?', owner.runId);
    check(worker.status === 'running' && !worker.stopped_at && input.status === 'running' && run?.status === 'running' && sameSecret(run.token_hash, digest(token)), 'administrator invocation is no longer active');
    return owner;
  }
  catalog(token) {
    this.authenticateInvocation(token);
    check(this.executor && typeof this.executor.catalog === 'function' && typeof this.executor.execute === 'function', 'administrator executor is not configured');
    const catalog = this.executor.catalog();
    check(Array.isArray(catalog) && catalog.length <= 256 && catalog.every(entry => isPlainObject(entry)
      && typeof entry.name === 'string' && /^[a-z][a-z0-9_.-]{0,100}$/.test(entry.name) && typeof entry.readOnly === 'boolean')
      && new Set(catalog.map(entry => entry.name)).size === catalog.length, 'invalid administrator executor catalog');
    return safeRuntimeValue(catalog, this.secrets());
  }
  async call(token, operation, params) {
    const owner = this.authenticateInvocation(token);
    check(typeof operation === 'string' && this.catalog(token).some(entry => entry.name === operation), 'administrator operation is not registered');
    check(isPlainObject(params), 'administrator tool params must be an object');
    const canonical = stableJSON(params), key = digest(`${operation}\n${canonical}`);
    const previous = this.store.get('SELECT * FROM tool_calls WHERE instruction_id=? AND request_key=?', owner.instructionId, key);
    if (previous) {
      this.event(owner.workerId, owner.instructionId, 'tool.deduplicated', { call_id: previous.id, operation, status: previous.status });
      return { version: 1, call: this.callView(previous), ...(previous.result !== null ? { result: decodeStored(previous.result) } : {}) };
    }
    const callId = newId('call'), readOnly = this.catalog(token).find(entry => entry.name === operation).readOnly;
    this.store.transaction(() => {
      this.authenticateInvocation(token);
      this.store.run('INSERT INTO tool_calls(id,worker_id,instruction_id,run_id,request_key,operation,params,status,effect,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        callId, owner.workerId, owner.instructionId, owner.runId, key, operation, canonical, 'running', readOnly ? 'not_applicable' : 'unknown', this.now());
      this.event(owner.workerId, owner.instructionId, 'tool.started', { call_id: callId, operation, read_only: readOnly, evidence: 'dispatch_entered' });
    });
    const identity = { service_id: this.serviceId, worker_id: owner.workerId, instruction_id: owner.instructionId, call_id: callId };
    const job = (async () => {
      let result, receiptFailure = null;
      try {
        this.authenticateInvocation(token);
        result = safeRuntimeValue(await this.executor.execute({ operation, params: JSON.parse(canonical), identity, signal: owner.abort.signal }), this.secrets());
        // Only a top-level executor receipt bound to this call represents its outcome.
        // A queried target's nested unknown state is not this invocation's result.
        if (isPlainObject(result) && result.version === 1 && result.status === 'unknown' && result.effect === 'unknown'
          && isPlainObject(result.identity) && Object.entries(identity).every(([key, value]) => result.identity[key] === value)) {
          receiptFailure = sampledRuntimeFailure('execution', 'unknown', result.error, 'executor_receipt', this.secrets());
          owner.firstFailures.set(callId, receiptFailure);
        }
      } catch (error) {
        const failure = sampledRuntimeFailure('execution', readOnly ? 'not_applicable' : 'unknown', error, 'executor_exception', this.secrets());
        owner.firstFailures.set(callId, failure);
        try {
          this.store.transaction(() => {
            this.store.run("UPDATE tool_calls SET status='unknown',effect=?,error=?,original_failure=COALESCE(original_failure,?),finished_at=? WHERE id=?",
              failure.effect, failure.message, JSON.stringify(failure), this.now(), callId);
            this.event(owner.workerId, owner.instructionId, 'tool.failed', { call_id: callId, operation, original_failure: failure });
          });
        } catch (error) {
          owner.auditFailure ??= sampledRuntimeFailure('persistence', 'unknown', error, 'completion_audit', this.secrets());
          owner.auditFailed = true; owner.abort.abort();
        }
        return { version: 1, call: this.callView(this.store.get('SELECT * FROM tool_calls WHERE id=?', callId)) };
      }
      try {
        this.store.transaction(() => {
          // A normal callback return cannot turn an explicit unknown business receipt into success.
          this.store.run('UPDATE tool_calls SET status=?,effect=?,result=?,error=?,original_failure=COALESCE(original_failure,?),finished_at=? WHERE id=?',
            receiptFailure ? 'unknown' : 'succeeded', receiptFailure?.effect ?? (readOnly ? 'not_applicable' : 'unknown'), JSON.stringify(result),
            receiptFailure?.message ?? null, receiptFailure ? JSON.stringify(receiptFailure) : null, this.now(), callId);
          this.event(owner.workerId, owner.instructionId, 'tool.returned', { call_id: callId, operation, status: receiptFailure ? 'unknown' : 'succeeded',
            evidence: receiptFailure ? 'executor_unknown_receipt_saved' : 'executor_return_saved', business_completion: 'inspect_result_receipt', original_failure: receiptFailure });
        });
      } catch (error) {
        const failure = sampledRuntimeFailure('persistence', 'unknown', error, 'completion_audit', this.secrets());
        if (!owner.firstFailures.has(callId)) owner.firstFailures.set(callId, failure);
        owner.auditFailure ??= failure;
        owner.auditFailed = true; owner.abort.abort();
        throw new LushError('administrator completion audit failed; result withheld; do not replay', -32061);
      }
      return { version: 1, call: this.callView(this.store.get('SELECT * FROM tool_calls WHERE id=?', callId)), result };
    })();
    owner.jobs.add(job);
    try { return await job; } finally { owner.jobs.delete(job); }
  }
  kick() {
    if (this.closed || this.shutdownRequested || this.kickPending) return;
    this.kickPending = true;
    queueMicrotask(() => {
      this.kickPending = false;
      if (this.closed || this.shutdownRequested) return;
      for (const input of this.store.all("SELECT * FROM messages WHERE status='queued' ORDER BY rowid")) {
        if (this.owners.has(input.worker_id)) continue;
        this.begin(input);
      }
    });
  }
  begin(input) {
    const worker = this.store.worker(input.worker_id);
    if (worker.stopped_at) return;
    const token = randomBytes(32).toString('base64url'), runId = newId('run');
    const owner = { workerId: worker.id, instructionId: input.id, runId, token, abort: new AbortController(), jobs: new Set(),
      firstFailures: new Map(), auditFailed: false, promise: null };
    const configured = typeof this.runner === 'function' && this.executor && typeof this.executor.execute === 'function' && typeof this.executor.catalog === 'function';
    try {
      this.store.transaction(() => {
        this.store.run("UPDATE messages SET status='running',started_at=?,effect=? WHERE id=? AND status='queued'", this.now(), configured ? 'unknown' : 'not_started', input.id);
        this.store.run("UPDATE workers SET status='running',updated_at=? WHERE id=?", this.now(), worker.id);
        this.store.run('INSERT INTO agent_runs(id,worker_id,instruction_id,status,token_hash,started_at) VALUES (?,?,?,?,?,?)', runId, worker.id, input.id, 'running', digest(token), this.now());
        this.event(worker.id, input.id, 'instruction.started', { run_id: runId, configured });
      });
    } catch (error) {
      // A failing start transaction must never launch a provider. Leave queued evidence for operator repair.
      this.startFailure = sampledRuntimeFailure('persistence', 'not_started', error, 'start_audit', this.secrets());
      return;
    }
    this.owners.set(worker.id, owner);
    owner.promise = this.run(owner, configured);
    owner.promise.catch(() => {});
  }
  async run(owner, configured) {
    let output = null, failure = null, originalFailure = null;
    try {
      check(configured, 'administrator runner and executor are not configured');
      output = safeRuntimeValue(await this.runner({ worker: this.workerView(this.store.worker(owner.workerId)),
        instruction: this.instructionView(this.store.instruction(owner.instructionId)), token: owner.token,
        socket: this.paths.socket, signal: owner.abort.signal,
        onEvent: event => {
          try {
            strictFields(event, ['type', 'data'], ['type', 'data']);
            check(typeof event.type === 'string' && /^[a-z][a-z0-9_.-]{0,60}$/.test(event.type), 'invalid administrator agent event');
            this.event(owner.workerId, owner.instructionId, `agent.${event.type}`, event.data);
          } catch (error) {
            owner.auditFailure ??= sampledRuntimeFailure('persistence', 'unknown', error, 'invocation_audit', this.secrets());
            owner.auditFailed = true; owner.abort.abort(); throw error;
          }
        } }), this.secrets());
    } catch (error) { failure = sampledRuntimeFailure(configured ? 'execution' : 'configuration', configured ? 'unknown' : 'not_started', error, 'runner_exception', this.secrets()); }
    // The provider may return before an independent dispatched tool is settled. Its true owner remains here.
    await Promise.allSettled([...owner.jobs]);
    if (owner.auditFailed) { failure = owner.auditFailure ?? runtimeFailure('persistence'); output = null; }
    let stopped = false;
    try {
      const unknownCall = this.store.get("SELECT * FROM tool_calls WHERE instruction_id=? AND status IN ('running','unknown') ORDER BY rowid LIMIT 1", owner.instructionId);
      if (unknownCall) {
        originalFailure = owner.firstFailures.values().next().value ?? this.firstInstructionFailure(owner.instructionId, decodeStored(unknownCall.original_failure));
        failure ??= originalFailure ?? runtimeFailure('execution');
      }
      stopped = Boolean(this.store.worker(owner.workerId).stopped_at);
    } catch (error) { failure = sampledRuntimeFailure('persistence', 'unknown', error, 'completion_audit', this.secrets()); output = null; }
    if (owner.abort.signal.aborted && !failure) failure = runtimeFailure('stopping');
    originalFailure ??= owner.firstFailures.values().next().value ?? failure;
    try {
      this.store.transaction(() => {
        // Any begun tool without a durable completion remains unknown; neither stop nor provider success fixes it.
        for (const call of this.store.all("SELECT * FROM tool_calls WHERE instruction_id=? AND status='running'", owner.instructionId)) {
          const original = owner.firstFailures.get(call.id) ?? runtimeFailure('recovery');
          this.store.run("UPDATE tool_calls SET status='unknown',effect='unknown',error=?,original_failure=COALESCE(original_failure,?),finished_at=? WHERE id=?",
            original.message, JSON.stringify(original), this.now(), call.id);
          this.event(owner.workerId, owner.instructionId, 'tool.completion_not_observed', { call_id: call.id, operation: call.operation, original_failure: original });
        }
        const status = failure ? failure.effect === 'not_started' ? 'failed' : 'unknown' : 'succeeded';
        this.store.run('UPDATE messages SET status=?,result=?,error=?,original_failure=COALESCE(original_failure,?),effect=?,finished_at=? WHERE id=?',
          status, output === null ? null : JSON.stringify(output), failure?.message ?? null, originalFailure ? JSON.stringify(originalFailure) : null,
          failure?.effect ?? 'unknown', this.now(), owner.instructionId);
        this.store.run('UPDATE agent_runs SET status=?,token_hash=NULL,error=?,original_failure=COALESCE(original_failure,?),finished_at=? WHERE id=?',
          status, failure?.message ?? null, originalFailure ? JSON.stringify(originalFailure) : null, this.now(), owner.runId);
        this.store.run('UPDATE workers SET status=?,result=?,error=?,original_failure=COALESCE(original_failure,?),updated_at=?,revision=revision+1 WHERE id=?',
          stopped ? 'stopped' : failure ? status : 'ready', output === null ? null : JSON.stringify(output), failure?.message ?? null,
          originalFailure ? JSON.stringify(originalFailure) : null, this.now(), owner.workerId);
        this.event(owner.workerId, owner.instructionId, 'instruction.finished', { run_id: owner.runId, status,
          effect: failure?.effect ?? 'unknown', original_failure: originalFailure, stopped });
      });
    } catch (error) {
      // Completion was not durably saved. Keep running/unknown facts; no result is released by this path.
      this.completionFailure = sampledRuntimeFailure('persistence', 'unknown', error, 'completion_audit', this.secrets());
    } finally {
      owner.token = ''; this.owners.delete(owner.workerId);
      this.kick();
    }
  }
  async dispatch(method, params = {}) {
    try {
      check(!this.closed, 'administrator service is closed');
      if (ADMINISTRATOR_TOOL_RPC.includes(method)) {
        strictFields(params, method === ADMINISTRATOR_RPC.toolCatalog ? ['token'] : ['token', 'operation', 'params'],
          method === ADMINISTRATOR_RPC.toolCatalog ? ['token'] : ['token', 'operation', 'params']);
        if (method === ADMINISTRATOR_RPC.toolCatalog) {
          const owner = this.authenticateInvocation(params.token), items = this.catalog(params.token);
          this.event(owner.workerId, owner.instructionId, 'tool.catalog_read', { count: items.length });
          return { version: 1, items };
        }
        return await this.call(params.token, params.operation, params.params);
      }
      const allowed = {
        [ADMINISTRATOR_RPC.status]: [], [ADMINISTRATOR_RPC.list]: ['options'], [ADMINISTRATOR_RPC.detail]: ['options'],
        [ADMINISTRATOR_RPC.preview]: ['definition', 'user_binding'], [ADMINISTRATOR_RPC.commit]: ['body', 'user_binding'],
        [ADMINISTRATOR_RPC.receipt]: ['options', 'user_binding'], [ADMINISTRATOR_RPC.stop]: ['id', 'user_binding'], [ADMINISTRATOR_RPC.shutdown]: ['user_binding'],
      };
      check(Object.hasOwn(allowed, method), 'unknown administrator method');
      strictFields(params, ['control', ...allowed[method]], ['control', ...allowed[method]]);
      check(sameSecret(params.control, this.control), 'administrator user control identity required');
      switch (method) {
        case ADMINISTRATOR_RPC.status: return this.status();
        case ADMINISTRATOR_RPC.list: return this.list(params.options);
        case ADMINISTRATOR_RPC.detail: return this.detail(params.options);
        case ADMINISTRATOR_RPC.preview: return this.preview(params.definition, params.user_binding);
        case ADMINISTRATOR_RPC.commit: return this.commit(params.body, params.user_binding);
        case ADMINISTRATOR_RPC.receipt: return this.receipt(params.options, params.user_binding);
        case ADMINISTRATOR_RPC.stop: return this.stop(params.id, params.user_binding);
        case ADMINISTRATOR_RPC.shutdown:
          userBinding(params.user_binding); this.shutdownRequested = true;
          for (const row of this.store.all("SELECT * FROM workers WHERE status IN ('queued','running','stopping')")) this.stop(row.id, params.user_binding);
          // Delay teardown only to flush the acceptance response, not to infer provider completion.
          setTimeout(() => this.close(), 25).unref();
          return { version: 1, stopping: true, active: this.owners.size };
      }
    } catch (error) {
      if (error instanceof LushError) throw error;
      throw new LushError('administrator request failed; completion may be unknown; inspect the original receipt before any retry', -32060);
    }
  }
  async start() {
    check(!this.closed && !this.server, 'administrator service already started or closed');
    const existing = assertPrivateFile(this.paths.socket, { missing: true, socket: true });
    // The kernel lock is held before removing a stale service socket.
    if (existing) fs.unlinkSync(this.paths.socket);
    const dispatcher = { dispatch: (method, params) => this.dispatch(method, params), stopping: { isRequested: () => false, set() {} } };
    this.server = new RPCServer(this.paths.socket, dispatcher);
    try {
      await this.server.start();
      writePrivateJSON(this.paths.descriptor, { version: 1, service_id: this.serviceId, pid: process.pid, socket: this.paths.socket, started_at: this.now() });
      this.kick();
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  async idle() { await Promise.resolve(); await Promise.allSettled([...this.owners.values()].map(owner => owner.promise)); }
  close() {
    if (this.closing) return this.closing;
    this.shutdownRequested = true;
    this.closing = (async () => {
      for (const row of this.store.all("SELECT * FROM workers WHERE status IN ('queued','running','stopping')")) this.stop(row.id, 'internal-service-shutdown');
      await this.idle();
      this.closed = true;
      await this.server?.close(); this.server = null;
      try { if (assertPrivateFile(this.paths.socket, { missing: true, socket: true })) fs.unlinkSync(this.paths.socket); } catch { /* Preserve changed/foreign ownership. */ }
      this.store.close(); this.lock.release();
      this.onClosed?.();
    })();
    return this.closing;
  }
}
