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

  /**
   * The three questions a parent asks about a node before delegating work to
   * it: what it is (`description`), what it may still create (`templates`), and
   * the prompt its tasks run with (`prompt`). Defaults to exactly those
   * sections; callers may pass any `VIEW_SECTIONS` subset.
   */
  serviceView(sid, sections = ['description', 'templates', 'prompt']) {
    validSid(sid);
    if (!Array.isArray(sections) || sections.length === 0) {
      throw new TypeError('sections must be a non-empty array');
    }
    return this.execute('service.view', { sid, sections });
  }

  /**
   * Say something about a node: what a user types becomes one **intension**,
   * which the top-level parsing node turns into work (or answers). This is the
   * only entry point that creates work; everything else observes or steers it.
   */
  submitIntension(content, sid = null) {
    if (sid !== null) validSid(sid);
    text(content, 'content');
    return this.execute('intent.submit', {
      content, ...(sid === null ? {} : { sid }), source: 'web',
    });
  }

  /**
   * Submit an intension *and* keep its parse task for this terminal: the daemon
   * records the input and creates the task without starting it, and returns the
   * argv to run. Used by `lush intent submit --interactive`.
   */
  submitInteractiveIntension(content, sid = null) {
    if (sid !== null) validSid(sid);
    text(content, 'content');
    return this.execute('intent.submit', {
      content, ...(sid === null ? {} : { sid }), source: 'cli', interactive: true,
    });
  }

  /** The queue: what the user has said, and where each input has got to. */
  intensionList({ status = null, sid = undefined, open = false, limit = 200 } = {}) {
    return this.execute('intent.list', { status, sid, open, limit });
  }

  intensionInspect(intensionId) {
    validSid(intensionId);
    return this.execute('intent.inspect', { intension_id: intensionId });
  }

  /** The architecture the parser judged this input against, plus its precheck. */
  intensionContext(intensionId) {
    validSid(intensionId);
    return this.execute('intent.context', { intension_id: intensionId });
  }

  withdrawIntension(intensionId, reason = null) {
    validSid(intensionId);
    if (reason !== null && typeof reason !== 'string') throw new TypeError('reason must be a string or null');
    return this.execute('intent.withdraw', { intension_id: intensionId, reason });
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

  /**
   * The subtree's collaboration timeline (`task.trace`): delegations, messages
   * in either direction, and settlements, oldest step first. `limit` bounds the
   * returned tail; the payload's `total` / `truncated` say what was left out.
   */
  taskTrace(taskId, { limit = 200 } = {}) {
    validSid(taskId);
    return this.execute('task.trace', { task_id: taskId, limit });
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

  /** Notices still waiting for a human, newest first (sidebar inbox). */
  noticeList({ status = null, taskId = null, sid = null, limit = 200 } = {}) {
    return this.execute('notice.list', { status, task_id: taskId, sid, limit });
  }

  /** One notice: reporter, declared answer form, and any answer already given. */
  noticeInspect(noticeId) {
    validSid(noticeId);
    return this.execute('notice.inspect', { notice_id: noticeId });
  }

  /** Fill in a notice's declared form; the answer is handed to the reporter. */
  answerNotice(noticeId, answer) {
    validSid(noticeId);
    if (!isPlainObject(answer)) throw new TypeError('answer must be an object');
    return this.execute('notice.answer', { notice_id: noticeId, answer });
  }

  /** Dismiss a notice without answering it. */
  dismissNotice(noticeId, reason = null) {
    validSid(noticeId);
    if (reason !== null && typeof reason !== 'string') throw new TypeError('reason must be a string or null');
    return this.execute('notice.dismiss', { notice_id: noticeId, reason });
  }

  /**
   * Submit an intension *and* keep its parse task for this terminal: the daemon
   * records the input and creates the task without starting it, and returns the
   * argv to run. Used by `lush intent submit --interactive`.
   */
  submitInteractiveIntension(content, sid = null) {
    if (sid !== null) validSid(sid);
    text(content, 'content');
    return this.execute('intent.submit', {
      content, ...(sid === null ? {} : { sid }), source: 'cli', interactive: true,
    });
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

/**
 * Strictly decode the intentionally tiny Web UI submission payload: the user's
 * words, and the service they optionally named.
 */
export function intensionRequest(value) {
  if (!isPlainObject(value)) throw new LushError('request body must be a JSON object', -32602);
  for (const key of Object.keys(value)) {
    if (key !== 'content' && key !== 'sid') {
      throw new LushError(`request body has unexpected field '${key}'`, -32602);
    }
  }
  if (!Object.hasOwn(value, 'content')) throw new LushError("request body is missing 'content'", -32602);
  text(value.content, 'content');
  const sid = value.sid ?? null;
  if (sid !== null) validSid(sid);
  return { content: value.content, sid };
}

const INTENSION_LIST_PARAMS = ['status', 'sid', 'open', 'limit'];

/**
 * Strictly decode the Web UI intension-list query
 * (`?status=&sid=&open=&limit=`). As with the other lists, only the wire shape
 * is enforced here; the enum and range checks stay in Core. `sid=none` asks for
 * the inputs that named no service, which is a different question from omitting
 * it (that means *any* target).
 */
export function intensionListQuery(search) {
  const raw = new Map();
  for (const [key, value] of search) {
    if (!INTENSION_LIST_PARAMS.includes(key)) throw new LushError(`unknown query parameter '${key}'`, -32602);
    if (raw.has(key)) throw new LushError(`duplicate query parameter '${key}'`, -32602);
    raw.set(key, value);
  }
  const query = { status: null, sid: undefined, open: false, limit: 200 };
  if ((raw.get('status') ?? '') !== '') query.status = raw.get('status');
  const sid = raw.get('sid');
  if (sid !== undefined && sid !== '') query.sid = sid === 'none' ? null : nonNegativeInt(sid, 'sid');
  const open = raw.get('open');
  if (open !== undefined && open !== '') {
    if (open !== '1' && open !== 'true') throw new LushError("open must be '1' or 'true'", -32602);
    query.open = true;
  }
  if ((raw.get('limit') ?? '') !== '') query.limit = nonNegativeInt(raw.get('limit'), 'limit');
  return query;
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

/**
 * Strictly decode the Web UI trace query (`?limit=`). As with the task list,
 * only the wire shape is enforced here; the range check stays in Core.
 */
export function taskTraceQuery(search) {
  const raw = new Map();
  for (const [key, value] of search) {
    if (key !== 'limit') throw new LushError(`unknown query parameter '${key}'`, -32602);
    if (raw.has(key)) throw new LushError(`duplicate query parameter '${key}'`, -32602);
    raw.set(key, value);
  }
  const value = raw.get('limit');
  return { limit: value === undefined || value === '' ? 200 : nonNegativeInt(value, 'limit') };
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

const NOTICE_LIST_PARAMS = ['status', 'task_id', 'sid', 'limit'];

/**
 * Strictly decode the Web UI notice-list query
 * (`?status=&task_id=&sid=&limit=`). As with tasks, only the wire shape is
 * enforced here; the enum and range checks stay in Core.
 */
export function noticeListQuery(search) {
  const raw = new Map();
  for (const [key, value] of search) {
    if (!NOTICE_LIST_PARAMS.includes(key)) throw new LushError(`unknown query parameter '${key}'`, -32602);
    if (raw.has(key)) throw new LushError(`duplicate query parameter '${key}'`, -32602);
    raw.set(key, value);
  }
  const query = { status: null, taskId: null, sid: null, limit: 200 };
  if ((raw.get('status') ?? '') !== '') query.status = raw.get('status');
  if ((raw.get('task_id') ?? '') !== '') query.taskId = nonNegativeInt(raw.get('task_id'), 'task_id');
  if ((raw.get('sid') ?? '') !== '') query.sid = nonNegativeInt(raw.get('sid'), 'sid');
  if ((raw.get('limit') ?? '') !== '') query.limit = nonNegativeInt(raw.get('limit'), 'limit');
  return query;
}

/** Strictly decode the Web UI notice-answer payload (`{ answer: object }`). */
export function noticeAnswerRequest(value) {
  if (!isPlainObject(value)) throw new LushError('request body must be a JSON object', -32602);
  for (const key of Object.keys(value)) {
    if (key !== 'answer') throw new LushError(`request body has unexpected field '${key}'`, -32602);
  }
  if (!Object.hasOwn(value, 'answer')) throw new LushError("request body is missing 'answer'", -32602);
  if (!isPlainObject(value.answer)) throw new LushError('answer must be an object', -32602);
  return { answer: value.answer };
}

/** Strictly decode the Web UI notice-dismiss payload (`{ reason?: string }`). */
export function noticeDismissRequest(value) {
  if (!isPlainObject(value)) throw new LushError('request body must be a JSON object', -32602);
  for (const key of Object.keys(value)) {
    if (key !== 'reason') throw new LushError(`request body has unexpected field '${key}'`, -32602);
  }
  const reason = value.reason ?? null;
  if (reason !== null && typeof reason !== 'string') {
    throw new LushError('reason must be a string', -32602);
  }
  return { reason };
}
