import { check } from '../../core/types.js';
import { exact } from '../args.js';

/**
 * `lush agent packages …` 的子命令处理器。
 *
 * 由 Agent 命令父模块接入：`runPackages(args, { client, json })`，也兼容 `runPackages(args, client)`。
 * 只发送窄 RPC；管理接口全部用户专属，Agent token 直接被拒。安装/更新不在 CLI 做来源校验，
 * 由守护进程用同一份契约拒绝未固定远端来源。
 */
export async function runPackages(args, context = {}) {
  const client = context?.client ?? context;
  check(client && typeof client.request === 'function', 'agent packages requires a project client');
  check(!client.token, 'agents cannot change Agent configuration');
  const verb = args.shift() || 'list';
  let method, params = {};
  if (verb === 'list') { exact(args, 0); method = 'agent.packages.list'; }
  else if (verb === 'install') { exact(args, 1); method = 'agent.packages.install'; params = { source: args[0] }; }
  else if (verb === 'remove' || verb === 'update') { exact(args, 1); method = `agent.packages.${verb}`; params = { id: args[0] }; }
  else check(false, 'agent packages expects list, install SOURCE, remove ID or update ID');
  return client.request(method, params);
}
