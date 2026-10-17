/** Trusted Bun-only bridge for Pi's Node extension. Never a user-identity RPC client. */
import path from 'node:path';
import { isWorkerNumber } from '../core/worker-number.js';
import { MANAGER_METHODS } from '../rpc/management-methods.js';
import { safeWorkerQueryError } from '../core/worker-query.js';

export const MANAGEMENT_RPC_METHODS = Object.freeze([...MANAGER_METHODS]);

export function managementInvocation(env = process.env) {
  let context;
  try { context = JSON.parse(env.LUSH_RUNTIME_CONTEXT || '{}'); } catch { throw new Error('invalid management invocation'); }
  if (context.role !== 'manager' || context.task_kind !== 'management' || !Number.isSafeInteger(context.task_id) || context.task_id <= 0
    || !Number.isSafeInteger(context.run_id) || context.run_id <= 0 || String(context.task_id) !== env.LUSH_TASK_ID
    || typeof env.LUSH_AGENT_TOKEN !== 'string' || !env.LUSH_AGENT_TOKEN.trim()
    || !path.isAbsolute(env.LUSH_PROJECT || '') || env.LUSH_HOME !== path.join(env.LUSH_PROJECT, '.lush')
    || !path.isAbsolute(env.LUSH_MANAGER_RPC_SOCKET || '')) throw new Error('current management invocation required');
  return { socket: env.LUSH_MANAGER_RPC_SOCKET, token: env.LUSH_AGENT_TOKEN };
}

export function validateManagementRPC(method, params) {
  if (!MANAGEMENT_RPC_METHODS.includes(method) || !params || typeof params !== 'object' || Array.isArray(params))
    throw new Error('unsupported management request');
  const keys = Object.keys(params);
  if (method === 'manager.catalog') {
    if (keys.length) throw new Error('catalog accepts no parameters');
  } else if (method === 'manager.history') {
    if (keys.some(key => !['id','before','limit'].includes(key))
      || ['id','before'].some(key => params[key] !== undefined && (!Number.isSafeInteger(params[key]) || params[key] <= 0))
      || params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100))
      throw new Error('invalid history parameters');
  } else if (method === 'manager.call') {
    if (keys.some(key => !['method','params','request_id'].includes(key)) || typeof params.method !== 'string'
      || params.method.length > 128 || !params.params || typeof params.params !== 'object' || Array.isArray(params.params)
      || params.request_id !== undefined && (typeof params.request_id !== 'string' || !params.request_id
        || params.request_id.length > 128 || params.request_id !== params.request_id.trim() || /[\x00-\x1f\x7f]/.test(params.request_id))
      || Buffer.byteLength(JSON.stringify(params)) > 40000) throw new Error('invalid reviewed capability request');
  } else if (method === 'worker.lookup') {
    if (keys.length !== 1 || keys[0] !== 'number' || !isWorkerNumber(params.number))
      throw new Error('invalid Worker number');
  } else if (method === 'manager.query' && !keys.length) {
    return;
  } else if (keys.length !== 1 || keys[0] !== 'id' || !Number.isSafeInteger(params.id) || params.id <= 0) {
    throw new Error('invalid management target');
  }
}

// Kept importable for unit tests; importing never opens a socket or starts a process.
export async function runManagementRPC(method, params, env = process.env) {
  const invocation = managementInvocation(env);
  validateManagementRPC(method, params);
  // The Node extension only imports protocol validation; transport runs in the fixed Bun child.
  const { RPCClient } = await import('../rpc/client.js');
  return new RPCClient(invocation.socket, 25).request(method, { ...params, _token: invocation.token });
}

if (import.meta.main) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 48000) throw new Error('management request too large');
    }
    const request = JSON.parse(input);
    if (!request || Object.keys(request).some(key => !['method', 'params'].includes(key))) throw new Error('invalid management request');
    const result = await runManagementRPC(request.method, request.params);
    const output = JSON.stringify({ result });
    if (Buffer.byteLength(output) > 256 * 1024) throw new Error('management response too large');
    process.stdout.write(output);
  } catch (error) {
    // Only code-owned query preflight diagnostics may cross this boundary. Never
    // expose arbitrary handler/auth errors, input values, paths or credentials.
    process.stdout.write(JSON.stringify(safeWorkerQueryError(error) ?? {
      error: '管理请求被拒绝或未确认完成；不能换身份或自动重试。',
      ...(Number.isInteger(error.code) ? { code: error.code } : {}) }));
    process.exitCode = 1;
  }
}
