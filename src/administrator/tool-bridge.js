import { RPCClient } from '../rpc/client.js';
import { validateAdministratorToolRequest } from './tool-protocol.js';
import { ADMINISTRATOR_RPC } from './runtime-protocol.js';

/** Fixed helper only receives the invocation token; no user control or delegation key. */
export async function requestAdministratorTool(value, env = process.env, request = null) {
  const tool = validateAdministratorToolRequest(value);
  if (typeof env.LUSH_ADMIN_SOCKET !== 'string' || !env.LUSH_ADMIN_SOCKET.startsWith('/') || typeof env.LUSH_ADMIN_TOKEN !== 'string' || !env.LUSH_ADMIN_TOKEN.length) throw new Error('administrator invocation required');
  const call = { token: env.LUSH_ADMIN_TOKEN, operation: tool.operation, params: tool.params };
  const result = request ? await request(ADMINISTRATOR_RPC.toolCall, call) : await new RPCClient(env.LUSH_ADMIN_SOCKET, 30).request(ADMINISTRATOR_RPC.toolCall, call);
  return result;
}
if (import.meta.main) {
  try {
    const source = await Bun.stdin.text();
    if (Buffer.byteLength(source) > 131072) throw new Error('input limit');
    const result = await requestAdministratorTool(JSON.parse(source));
    const response = JSON.stringify({ ok: true, result });
    if (Buffer.byteLength(response) > 512000) throw new Error('output limit');
    process.stdout.write(response);
  } catch { process.stdout.write(JSON.stringify({ ok: false, error: 'administrator tool result unconfirmed; inspect receipt, do not replay' })); process.exitCode = 1; }
}
