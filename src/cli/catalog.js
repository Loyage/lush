// Code-owned CommandSpec catalogue. Parser, offline help, static bridge admission,
// Web learning and Worker CLI preview consume these same declarations.
import { defineCommands } from './command-spec.js';
import { syntaxParameters } from './parser.js';
import { catalogueVersion, describeHelp, renderHelp } from './discovery.js';
import { COMMANDS as WORKER_SYSTEM_COMMANDS } from './specs/worker-system.js';
import { COMMANDS as AGENT_CONFIG_COMMANDS } from './specs/agent-config.js';
import { COMMANDS as AUTOMATION_VALET_COMMANDS } from './specs/automation-valet.js';
import { COMMANDS as INPUT_CONTEXT_COMMANDS } from './specs/input-context.js';

export const COMMAND_MODULES = Object.freeze({
  system: ['daemon', 'status', 'project', 'doctor', 'host:start', 'host:stop', 'host:restart', 'host:status'],
  input: ['input'], intent: ['order'], worker: ['worker'], context: ['self','parent','children'],
  notice: ['notice'], question: ['question'], branch: ['branch'], agent: ['agent'], config: ['config'],
  hooks: ['automation'], skills: ['skills'], valet: ['valet'],
});
const HELP_COMMANDS = defineCommands(add => add('help', '[PATH...] [--search TEXT | --all] [--limit N] [--cursor CURSOR]',
  '离线分层帮助、固定文档搜索与工作流；不发现项目、不发送 RPC。', 'worker merge request', [], 'local-read',
  'help workflow [TOPIC] 是固定只读文档，不是业务命令。--json 显式输出同源 CLI 机器契约；默认紧凑文本。-- 后正文不触发帮助。', {
    parameters: { positionals: [{ name: 'PATH', type: 'string', required: false, variadic: true }], options: {
      '--search': { type: 'string', arity: 1, description: '只搜索随代码发布的名称、用途、场景和关键词。' },
      '--all': { type: 'boolean', arity: 0 }, '--limit': { type: 'integer', arity: 1, minimum: 1, maximum: 100, default: 30 },
      '--cursor': { type: 'string', arity: 1, description: '上页实际游标，绑定目录版本、可信视图和查询。' },
    }, mutuallyExclusive: [['--search','--all']], rules: ['workflow 与 search/all 互斥；limit/cursor 只用于有界索引。'] },
    sources: ['无需实时项目事实；目标、revision 和授权仍须在执行前从真实读面取得。'],
    preconditions: ['视图来自固定入口、真实 Valet bridge 或 Web 用户上下文 lease，不接受 --role。'],
    effects: { operation: 'read', scope: 'offline', network: false, invokes_agent: false },
    recovery: '同版本静态用法可复用；版本变化只使相关知识失效，不重发之前的写操作。',
  }));
const directoryHints = {
  worker: '持久工作记录、沟通与生命周期。', 'worker merge': '本轮一次合并意图与诊断，不是持久开关。',
  'worker automation': '实际挂载与自动授权，不是项目注册目录。', 'worker config': '单工作下一次运行覆盖。',
  'worker sync': '用户显式父同步与冲突修复。',
  input: '已发送原话与未发送意图。', 'input draft': '保存、授权和撤销可靠条件发射，保存不授权。',
  notice: '决策与非阻塞告知，明确区分发布、答复和已读。',
  branch: '分支谱系、详情与普通批量合并请求。',
  automation: '项目自动化定义、注册与固定版本；不隐式挂载或运行。',
  valet: '受控收据、管家上下文与真实自身事务；通用 W/V 查询仍用 worker。',
  agent: '执行软件、模型候选与托管来源，不是设备策略。',
  config: '设备策略；设备作用域不等于执行授权。',
  project: '当前项目维护与用量诊断，不跨项目。', daemon: '项目后台本地生命周期与受控停止请求。',
  host: '本地 Web 工作台生命周期，不等于项目后台。',
  self: 'invocation 绑定自身，不接受自身 ID。', parent: '服务端确定的直接父 Worker。',
  children: '真实直接 child，独立执行且不等待轮询。', question: '离线准备与校验问卷，不发布。',
  skills: '固定随代码指南，不读取设备开启状态。',
};
const commandEntries = [...HELP_COMMANDS, ...WORKER_SYSTEM_COMMANDS, ...INPUT_CONTEXT_COMMANDS,
  ...AUTOMATION_VALET_COMMANDS, ...AGENT_CONFIG_COMMANDS];
if (new Set(commandEntries.map(entry => entry.path)).size !== commandEntries.length) throw new Error('duplicate CLI command path');
if (new Set(commandEntries.map(entry => entry.id)).size !== commandEntries.length) throw new Error('duplicate CLI command ID');
const commandDirectories = new Map();
for (const entry of commandEntries) {
  const parts = entry.path.split(' ');
  for (let index = 1; index < parts.length; index++) {
    const path = parts.slice(0, index).join(' ');
    commandDirectories.set(path, { path, directory: true, description: directoryHints[path] ?? `按需查看 ${path} 的直接动作与子组。` });
  }
}
export const CLI_OPERATIONS = Object.freeze(['read', 'write']);
const operationFor = entry => ['read', 'local-read'].includes(entry.kind) ? 'read' : 'write';
export const CLI_COMMANDS = Object.freeze([...commandDirectories.values(), ...commandEntries].map(entry => Object.freeze({
  ...entry, id: entry.id ?? entry.path.replaceAll(' ', '.'),
  parameters: entry.directory ? undefined : syntaxParameters(entry),
  user_context_rpc: entry.user_context_rpc ?? null, operation: entry.directory ? null : operationFor(entry),
  format: entry.usage?.replace(/\s*\[[^\]]*\]/g, ''),
  parent: entry.path.includes(' ') ? entry.path.slice(0, entry.path.lastIndexOf(' ')) : null,
  rpc: Object.freeze([...new Set(entry.rpc ?? [])]),
})));
export const LUSHW_PATHS = new Set(CLI_COMMANDS.filter(entry => !entry.directory &&
  (/^(self|parent|children|question|skills) /.test(entry.path) || entry.path === 'help')).map(entry => entry.path));
export const SHARED_CLI_PATHS = new Set(['help']);
export const LUSHW_METHODS = new Set(CLI_COMMANDS.filter(entry => LUSHW_PATHS.has(entry.path)).flatMap(entry => entry.rpc));
export const CLI_EXECUTABLES = Object.freeze(['lush', 'lushw']);
export function commandExecutables(entry) {
  if (SHARED_CLI_PATHS.has(entry.path)) return CLI_EXECUTABLES;
  return LUSHW_PATHS.has(entry.path) ? ['lushw'] : ['lush'];
}

/** Static reviewed handler boundary; never caches live RPC policy or target admission. */
export function managementCLICommandPolicy(entry) {
  if (entry.path === 'help') return { available: true, reason: '离线只读帮助，不发现项目、不调用 RPC、不授予执行权限。' };
  const local = !commandExecutables(entry).includes('lush') || entry.kind?.startsWith('local-')
    || Array.isArray(entry.identities) && !entry.identities.includes('valet')
    || Array.isArray(entry.applicability) && !entry.applicability.includes('valet')
    || !entry.rpc?.length;
  return { available: !local, reason: local ? '需真实用户、本地资源或有效开发 invocation；不向管家开放私有材料、文件、认证与本地进程控制。'
    : '固定当前项目与 management 身份；仍需最新逐项权限、明确范围及原安全门。' };
}
export function safeManagementCLICommand(value, method) {
  const entry = typeof value === 'string' ? CLI_COMMANDS.find(item => !item.directory && item.path === value) : null;
  return entry && entry.rpc.includes(method) && commandExecutables(entry).includes('lush') ? entry.path : null;
}
export function cliCommands(executable = 'lush', { view = executable === 'lushw' ? 'worker' : 'user' } = {}) {
  if (!CLI_EXECUTABLES.includes(executable)) throw new Error('unknown CLI executable');
  const leaves = CLI_COMMANDS.filter(entry => !entry.directory && commandExecutables(entry).includes(executable)
    && (view !== 'valet' || managementCLICommandPolicy(entry).available)
    && (view !== 'worker-user' || entry.path === 'help' || Boolean(entry.user_context_rpc)));
  const paths = new Set(leaves.flatMap(entry => entry.path.split(' ').map((_part, index, parts) => parts.slice(0, index + 1).join(' '))));
  return CLI_COMMANDS.filter(entry => paths.has(entry.path)).map(entry => {
    const qualify = value => value?.replace(/^lush(?=\s|$)/, executable);
    const operations = entry.directory ? CLI_OPERATIONS.filter(operation => leaves.some(leaf => leaf.path.startsWith(`${entry.path} `) && leaf.operation === operation)) : [entry.operation];
    return Object.freeze({ ...entry, executable, management_cli: managementCLICommandPolicy(entry), operations: Object.freeze(operations),
      usage: qualify(entry.usage), format: qualify(entry.format), example: qualify(entry.example) });
  });
}
export const CLI_CATALOG_VERSION = catalogueVersion(CLI_COMMANDS, { executables: CLI_EXECUTABLES,
  views: ['user','valet','worker','worker-user'], local_policy_version: 2 });
export function cliHelpDocument(executable = 'lush', args = [], { view = executable === 'lushw' ? 'worker' : 'user' } = {}) {
  return describeHelp({ commands: cliCommands(executable, { view }), allCommands: cliCommands(executable), executable, view, catalog_version: CLI_CATALOG_VERSION }, args);
}
export function cliHelp(executable = 'lush', topic = '', options = {}) {
  return renderHelp(cliHelpDocument(executable, Array.isArray(topic) ? topic : topic.split(' ').filter(Boolean), options), executable);
}
