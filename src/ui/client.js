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
