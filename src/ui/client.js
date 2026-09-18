import { LushError, isPlainObject, text, validSid } from '../core/types.js';
import { RPCClient } from '../rpc/client.js';

/**
 * Transport-neutral operations shared by user interfaces.
 *
 * CLI keeps its rich command surface, while Web UI and a future native TUI can
 * use this small interaction model instead of knowing JSON-RPC method names.
 */
export class UIClient {
  constructor(transport) {
    if (transport === null || typeof transport !== 'object' || typeof transport.request !== 'function') {
      throw new TypeError('UIClient requires a request transport');
    }
    this.transport = transport;
  }

  /**
   * The complete application gateway used by command-driven adapters. The CLI
   * resolves its declaration tree to a method + params and stops here; Web/TUI
   * normally use the typed workflows below. No adapter talks to RPC directly.
   */
  execute(method, params = {}) {
    if (typeof method !== 'string' || method.trim() === '') {
      throw new TypeError('UI method must be a non-empty string');
    }
    return this.transport.request(method, params);
  }

  status() {
    return this.execute('system.status');
  }

  shutdown() {
    return this.execute('system.shutdown');
  }

  serviceTree() {
    return this.execute('service.tree');
  }

  /** Create a user-facing root task and return immediately while it runs. */
  createTask(sid, goal) {
    validSid(sid);
    text(goal, 'goal');
    return this.execute('call', { sid, goal, detach: true });
  }

  taskResult(taskId) {
    validSid(taskId);
    return this.execute('task.result', { task_id: taskId });
  }

  /** Rows (newest first) for the task browser; `roots` picks root or child tasks. */
  taskList({ sid = null, status = null, roots = null, limit = 200 } = {}) {
    return this.execute('task.list', { sid, status, roots, limit });
  }

  /** The task plus its whole subtree of delegated work (`lush task tree`). */
  taskTree(taskId) {
    validSid(taskId);
    return this.execute('task.tree', { task_id: taskId });
  }

  /** Cancel a task and its subtree; idempotent for an already-settled task. */
  cancelTask(taskId) {
    validSid(taskId);
    return this.execute('task.cancel', { task_id: taskId });
  }

  /** Remove a finished task's rows; `recursive` also removes its finished subtree. */
  deleteTask(taskId, recursive = false) {
    validSid(taskId);
    if (typeof recursive !== 'boolean') throw new TypeError('recursive must be a boolean');
    return this.execute('task.delete', { task_id: taskId, recursive });
  }

  taskSession(taskId) {
    validSid(taskId);
    return this.execute('task.session', { task_id: taskId });
  }

  openInteractiveTask(sid, goal) {
    validSid(sid);
    text(goal, 'goal');
    return this.execute('call', { sid, goal, interactive: true });
  }

  recordInteractivePid(taskId, callId, osPid) {
    return this.execute('call.os_pid', { task_id: taskId, call_id: callId, os_pid: osPid });
  }

  settleInteractiveTask(taskId, callId, status, { output = null, error = null } = {}) {
    return this.execute('call.end', {
      task_id: taskId,
      call_id: callId,
      status,
      ...(output === null ? {} : { output }),
      ...(error === null ? {} : { error }),
    });
  }
}

/** Production composition: adapters receive UIClient, never the RPC transport. */
export function connectUI(socket, timeout) {
  return new UIClient(new RPCClient(socket, timeout));
}

/** Strictly decode the intentionally tiny Web UI create-task payload. */
export function taskRequest(value) {
  if (!isPlainObject(value)) throw new LushError('request body must be a JSON object', -32602);
  const keys = Object.keys(value);
  for (const key of keys) {
    if (key !== 'sid' && key !== 'goal') {
      throw new LushError(`request body has unexpected field '${key}'`, -32602);
    }
  }
  if (!Object.hasOwn(value, 'sid')) throw new LushError("request body is missing 'sid'", -32602);
  if (!Object.hasOwn(value, 'goal')) throw new LushError("request body is missing 'goal'", -32602);
  validSid(value.sid);
  text(value.goal, 'goal');
  return { sid: value.sid, goal: value.goal };
}

const TASK_LIST_PARAMS = ['sid', 'status', 'roots', 'limit'];
const TASK_ROOTS = ['roots', 'children'];

function nonNegativeInt(value, field) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new LushError(`${field} must be a non-negative integer`, -32602);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new LushError(`${field} must be a non-negative integer`, -32602);
  return parsed;
}

/**
 * Strictly decode the Web UI task-list query (`?sid=&status=&roots=&limit=`).
 * Range and enum checks stay in Core so the error text lives in one place; here
 * only the wire shape (known, single, well-formed keys) is enforced.
 */
export function taskListQuery(search) {
  const raw = new Map();
  for (const [key, value] of search) {
    if (!TASK_LIST_PARAMS.includes(key)) throw new LushError(`unknown query parameter '${key}'`, -32602);
    if (raw.has(key)) throw new LushError(`duplicate query parameter '${key}'`, -32602);
    raw.set(key, value);
  }
  const query = { sid: null, status: null, roots: null, limit: 200 };
  if (raw.has('sid')) query.sid = validSid(nonNegativeInt(raw.get('sid'), 'sid'));
  if ((raw.get('status') ?? '') !== '') query.status = raw.get('status');
  const roots = raw.get('roots');
  if (roots !== undefined && roots !== '') {
    if (!TASK_ROOTS.includes(roots)) throw new LushError("roots must be 'roots' or 'children'", -32602);
    query.roots = roots;
  }
  if ((raw.get('limit') ?? '') !== '') query.limit = nonNegativeInt(raw.get('limit'), 'limit');
  return query;
}

/** Strictly decode the Web UI delete-task payload (`{ recursive?: boolean }`). */
export function taskDeleteRequest(value) {
  if (!isPlainObject(value)) throw new LushError('request body must be a JSON object', -32602);
  for (const key of Object.keys(value)) {
    if (key !== 'recursive') throw new LushError(`request body has unexpected field '${key}'`, -32602);
  }
  const recursive = value.recursive ?? false;
  if (typeof recursive !== 'boolean') throw new LushError('recursive must be a boolean', -32602);
  return { recursive };
}
