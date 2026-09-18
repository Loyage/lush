/** JSON-RPC framing and dispatch; business rules remain in ServiceManager. */
import { PARAMS, invoke } from '../core/dispatch.js';
import { LushError, isPlainObject, jsonDump, jsonLoad } from '../core/types.js';

export const MAX_FRAME = 1024 * 1024;

export function encode(value) {
  const payload = Buffer.from(jsonDump(value), 'utf8');
  if (payload.length + 1 > MAX_FRAME) {
    throw new LushError('RPC frame exceeds 1 MiB; use paginated history', -32600);
  }
  return Buffer.concat([payload, Buffer.from('\n')]);
}

export function errorResponse(requestId, code, message) {
  return { jsonrpc: '2.0', id: requestId ?? null, error: { code, message } };
}

export function parseRequest(raw) {
  let value;
  try {
    value = jsonLoad(raw.toString('utf8'));
  } catch {
    throw new LushError('parse error', -32700);
  }
  if (!isPlainObject(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string') {
    throw new LushError('invalid JSON-RPC request', -32600);
  }
  if (Object.hasOwn(value, 'id') && value.id !== null
    && !(typeof value.id === 'string' || (typeof value.id === 'number' && Number.isInteger(value.id)))) {
    throw new LushError('id must be string, integer or null', -32600);
  }
  return value;
}

// [wire name, ServiceManager method, params key] — the wire protocol keeps snake_case.
const SERVICE_METHODS = [
  ['service.inspect', 'inspect', 'inspect'],
  ['service.parent', 'parent', 'parent'],
  ['service.children', 'children', 'children'],
  ['service.view', 'view', 'view'],
  ['service.construct', 'construct', 'construct'],
  ['service.tree', 'tree', 'tree'],
  ['service.orphans', 'orphans', 'orphans'],
  ['service.orphan_sweep', 'superviseOrphans', 'orphan_sweep'],
  ['service.start', 'start', 'start'],
  ['service.stop', 'stop', 'stop'],
  ['service.delete', 'delete', 'delete'],
  ['service.purge', 'purge', 'purge'],
  ['service.update_state', 'updateState', 'update_state'],
  ['service.update_vars', 'updateVars', 'update_vars'],
];

const TASK_METHODS = [
  ['task.list', 'taskList', 'task_list'],
  ['task.tree', 'taskTree', 'task_tree'],
  ['task.inspect', 'taskInspect', 'task_inspect'],
  ['task.result', 'taskResult', 'task_result'],
  ['task.history', 'taskHistory', 'task_history'],
  ['task.wait', 'taskWait', 'task_wait'],
  ['task.construct', 'taskConstruct', 'task_construct'],
  ['task.message', 'taskMessage', 'task_message'],
  ['task.inbox', 'taskInbox', 'task_inbox'],
  ['task.trace', 'taskTrace', 'task_trace'],
  ['task.complete', 'completeTask', 'task_complete'],
  ['task.cancel', 'cancelTask', 'task_cancel'],
  ['task.delete', 'taskDelete', 'task_delete'],
  ['task.update_state', 'updateTaskState', 'task_update_state'],
  ['task.agents_list', 'taskAgentsList', 'agents_list'],
  ['task.agents_show', 'taskAgentShow', 'agents_show'],
  ['task.agents_kill', 'taskAgentsKill', 'agents_kill'],
  ['task.session', 'taskSession', 'session'],
];

const CALL_METHODS = [
  ['call', 'call', 'call'],
  ['call.describe', 'callDescribe', 'call_describe'],
  ['call.end', 'callEnd', 'call_end'],
  ['call.os_pid', 'callOsPid', 'call_os_pid'],
];

const NOTICE_METHODS = [
  ['notice.list', 'noticeList', 'notice_list'],
  ['notice.inspect', 'noticeInspect', 'notice_inspect'],
  ['notice.post', 'noticePost', 'notice_post'],
  ['notice.answer', 'noticeAnswer', 'notice_answer'],
  ['notice.dismiss', 'noticeDismiss', 'notice_dismiss'],
];

export class Dispatcher {
  /**
   * `identity` is captured by the daemon at startup and reported verbatim:
   * which home (state) and which code (checkout + prompt surface) answer here.
   */
  constructor(manager, stopping, identity = {}) {
    this.manager = manager;
    this.stopping = stopping;
    this.identity = identity;
    this.methods = {
      'system.status': { params: { required: [] }, fn: () => this.status() },
      'system.shutdown': { params: { required: [] }, fn: () => this.shutdown() },
      'service.list': { params: PARAMS.list, fn: () => manager.list() },
    };
    for (const [wire, method, params] of [...SERVICE_METHODS, ...TASK_METHODS, ...CALL_METHODS, ...NOTICE_METHODS]) {
      this.methods[wire] = { params: PARAMS[params], fn: manager[method].bind(manager) };
    }
  }

  status() {
    const runtime = this.manager.runtime;
    return {
      daemon_pid: process.pid,
      root_sid: 0,
      provider: runtime ? runtime.provider.name : 'unbound',
      service_count: this.manager.list().length,
      active_calls: runtime ? runtime.activeCalls : 0,
      // Orphan supervision is configured at startup and only observable here:
      // the policy in wire shape plus how many orphans it currently holds.
      orphan_policy: this.manager.orphanPolicyReport(),
      orphans_active: this.manager.orphans().active_count,
      // Notices still waiting for a user: the one number that says "someone
      // needs a human" without walking the whole notice list.
      notices_open: this.manager.openNoticeCount(),
      // The daemon is long-lived and keeps the guide, the CLI declaration and
      // the templates in memory, so which code answers is not visible from the
      // socket path alone; report it and let clients compare with their own.
      ...this.identity,
      uptime_seconds: Math.round(process.uptime()),
    };
  }

  shutdown() {
    // The RPC server releases the daemon only after the reply is written.
    this.stopping.request();
    return { stopping: true };
  }

  async dispatch(method, params) {
    const entry = this.methods[method];
    if (!entry) throw new LushError(`method not found: ${method}`, -32601);
    return invoke(entry.fn, params, entry.params);
  }
}
