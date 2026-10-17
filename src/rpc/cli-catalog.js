import { CLI_EXECUTABLES, cliCommands } from '../cli/catalog.js';
import { AUTOMATION_CAPABILITIES } from '../core/hook-registration.js';
import { WORKER_QUERY_CAPABILITIES } from '../core/worker-query.js';
import { PARAMS, USER_ONLY, AGENT_ONLY } from './registry.js';
import { managementPolicy, managementAllowedAccess } from './management-policy.js';

const risks = {
  read: '只读学习／查询不执行写操作；目录可见不等于执行授权。',
  'local-read': '含本地读取或终端能力，不是可授予管家的文件／Shell 权限。',
  'local-write': '本地进程或文件变更；只供用户操作，无法通过项目权限目录授权。',
  write: '会修改配置或工作状态，仍须原权限、revision、冻结及生命周期安全门。',
  destructive: '可能永久丢弃代码或历史、回收资源；先核对精确范围，未知结果不得重放。',
  agent: '可能创建或唤醒 Agent，耗时并消耗 token；提交不等于实际执行或完成。',
};
/** No project facts, paths, settings or credentials. Project defaults are a separate user read. */
export function cliCatalog() {
  return { version: 1, source: 'builtin-cli', commands: CLI_EXECUTABLES.flatMap(executable => cliCommands(executable).map(entry => ({
    executable, command_path: entry.path,
    path: `${executable} ${entry.path}`, parent: entry.parent ? `${executable} ${entry.parent}` : null, name: entry.path.split(' ').at(-1),
    directory: entry.directory, operation: entry.operation, operations: [...entry.operations], description: entry.description,
    usage: entry.usage ?? `${executable} ${entry.path} <子命令>`, format: entry.format ?? `${executable} ${entry.path} <子命令>`, example: entry.example ?? null,
    risk: entry.directory ? '选择子命令查看实际调用与风险；目录本身不执行命令。' : [risks[entry.kind], entry.risk].filter(Boolean).join(' '),
    advanced: entry.advanced ?? '',
    rpc: entry.rpc.map(method => {
      const policy = managementPolicy(method);
      return { method, parameters: [...PARAMS[method]], ...(WORKER_QUERY_CAPABILITIES[method] ?? {}),
        ...(AUTOMATION_CAPABILITIES[method] ?? {}), base_access: policy.access,
        allowed_access: [...managementAllowedAccess(policy.access, method)], reason: policy.reason,
        audience: USER_ONLY.has(method) ? 'user' : AGENT_ONLY.has(method) ? 'agent' : 'user-and-agent' };
    }),
  }))) };
}
