import { managementInvocation } from '../agent/management-rpc.js';
import { PROJECT_ADMINISTRATOR_RPC, validateProjectAdministratorTool } from './project-tool-protocol.js';

export async function runProjectAdministratorRequest(value, env = process.env, request = null) {
  validateProjectAdministratorTool(value);
  const invocation = managementInvocation(env);
  const context = JSON.parse(env.LUSH_RUNTIME_CONTEXT);
  if (context.management_authorization?.mode !== 'administrator' || context.management_authorization.scope !== 'current_project'
    || context.management_authorization.project !== env.LUSH_PROJECT) throw new Error('current project administrator invocation required');
  const params = { ...value, _token: invocation.token };
  if (request) return request(PROJECT_ADMINISTRATOR_RPC, params);
  const { RPCClient } = await import('../rpc/client.js');
  return new RPCClient(invocation.socket,25).request(PROJECT_ADMINISTRATOR_RPC,params);
}
if (import.meta.main) {
  try {
    const source = await Bun.stdin.text();
    if (Buffer.byteLength(source) > 40000) throw new Error('native administrator input limit');
    const result = await runProjectAdministratorRequest(JSON.parse(source));
    const output = JSON.stringify({ ok:true,result });
    if (Buffer.byteLength(output) > 128000) throw new Error('native administrator output limit');
    process.stdout.write(output);
  } catch { process.stdout.write(JSON.stringify({ ok:false,error:'项目管理员调用未确认完成；保留原收据，不换身份或自动重放。' })); process.exitCode = 1; }
}
