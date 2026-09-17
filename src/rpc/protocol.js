/** JSON-RPC framing and dispatch; business rules remain in ProcessManager. */
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

// [wire name, ProcessManager method] — the wire protocol keeps snake_case.
const MANAGER_METHODS = [
  ['inspect', 'inspect'], ['parent', 'parent'], ['children', 'children'], ['spawn', 'spawn'],
  ['call', 'call'], ['start', 'start'], ['stop', 'stop'], ['kill', 'kill'], ['reclaim', 'reclaim'],
  ['update_state', 'updateState'], ['complete', 'complete'], ['history', 'history'],
];

export class Dispatcher {
  constructor(manager, stopping) {
    this.manager = manager;
    this.stopping = stopping;
    this.methods = {
      'system.status': { params: { required: [] }, fn: () => this.status() },
      'system.shutdown': { params: { required: [] }, fn: () => this.shutdown() },
      'process.list': { params: { required: [] }, fn: () => manager.list() },
      'process.tree': { params: { required: [] }, fn: () => manager.list() },
    };
    for (const [wire, method] of MANAGER_METHODS) {
      this.methods[`process.${wire}`] = { params: PARAMS[wire], fn: manager[method].bind(manager) };
    }
  }

  status() {
    const runtime = this.manager.runtime;
    return {
      daemon_pid: process.pid,
      root_pid: 0,
      provider: runtime ? runtime.provider.name : 'unbound',
      process_count: this.manager.list().length,
      active_calls: runtime ? runtime.activeCalls : 0,
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
