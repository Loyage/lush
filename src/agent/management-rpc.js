/** Trusted Bun-only bridge for Pi's Node extension. Never a user-identity RPC client. */
import path from 'node:path';
import { RPCClient } from '../rpc/client.js';

export const MANAGEMENT_RPC_METHODS = Object.freeze(['manager.query', 'manager.start', 'manager.retry', 'worker.lookup']);

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
  if (method === 'worker.lookup') {
    if (keys.length !== 1 || keys[0] !== 'number' || typeof params.number !== 'string' || !/^W[1-9]\d*(?:-[1-9]\d*)*$/.test(params.number))
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
  return new RPCClient(invocation.socket, 25).request(method, { ...params, _token: invocation.token });
}

if (import.meta.main) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 4096) throw new Error('management request too large');
    }
    const request = JSON.parse(input);
    if (!request || Object.keys(request).some(key => !['method', 'params'].includes(key))) throw new Error('invalid management request');
    const result = await runManagementRPC(request.method, request.params);
    const output = JSON.stringify({ result });
    if (Buffer.byteLength(output) > 256 * 1024) throw new Error('management response too large');
    process.stdout.write(output);
  } catch (error) {
    // No raw transport/auth errors or request data enter the model or session transcript.
    process.stdout.write(JSON.stringify({ error: '管理请求被拒绝或未确认完成；不能换身份或自动重试。',
      ...(Number.isInteger(error.code) ? { code: error.code } : {}) }));
    process.exitCode = 1;
  }
}
