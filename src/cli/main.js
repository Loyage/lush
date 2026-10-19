import { Config } from '../config.js';
import { UIClient } from '../ui/client.js';
import { codeIdentity } from '../identity.js';
import { check } from '../core/types.js';
import { option, print } from './args.js';
import { HELP } from './help.js';
import { COMMAND_MODULES, CLI_COMMANDS, cliHelp, commandExecutables, CLI_EXECUTABLES, LUSHW_PATHS } from './catalog.js';
import { launcherWebConfig } from '../host/registry.js';
import * as system from './commands/system.js';
import * as intent from './commands/intent.js';
import * as worker from './commands/task.js';
import * as context from './commands/context.js';
import * as notice from './commands/notice.js';
import * as question from './commands/question.js';
import * as branch from './commands/branch.js';
import * as agent from './commands/agent.js';
import * as config from './commands/config.js';
import * as hooks from './commands/hooks.js';
import * as skills from './commands/skills.js';
import * as valet from './commands/valet.js';
import * as input from './commands/input.js';

export { HELP };

/* ---------- 命令分发表 ----------
 * 每个处理器签名 run(command, args, ctx)，ctx = { client, json }；
 * 返回 undefined 表示「命令自己已经打印过」，主流程不再 print，也不做 fingerprint 提醒。
 */
const COMMANDS = new Map();
const modules = { system, intent, worker, context, notice, question, branch, agent, config, hooks, skills, valet, input };
for (const [key, names] of Object.entries(COMMAND_MODULES)) {
  const module = modules[key];
  for (const name of names) {
    check(!COMMANDS.has(name), `duplicate command handler: ${name}`);
    check(typeof module.run === 'function', `command module for '${name}' does not export run`);
    COMMANDS.set(name, module.run);
  }
}

export async function main(argv = process.argv.slice(2), { executable = 'lush', management = null, output = null } = {}) {
  check(CLI_EXECUTABLES.includes(executable), 'unknown CLI executable');
  const args = [...argv];
  const emit = value => output ? output(value) : print(value, json);
  const projectPath = option(args, '--project');
  const json = args.includes('--json'); if (json) args.splice(args.indexOf('--json'), 1);
  // --help / -h 在任意位置都只印帮助：子命令会把裸 --help 当成必填正文落库（spec add / branch summary / notice post 等）。
  // 必须在构造 Config / UIClient 之前返回，保证不解析命令、不发任何 RPC、不做 fingerprint 提醒。
  if (!args.length || ['help','--help','-h'].includes(args[0]) || args.includes('--help') || args.includes('-h')) {
    const helpArgs = (args[0] === 'help' ? args.slice(1) : args).filter(arg => !['--help', '-h'].includes(arg));
    const topic = args[0] === 'help' ? helpArgs.join(' ') : CLI_COMMANDS
      .filter(item => item.path.split(' ').every((part, index) => helpArgs[index] === part))
      .sort((a, b) => b.path.length - a.path.length)[0]?.path ?? helpArgs[0] ?? '';
    const help = cliHelp(executable, topic);
    if (output) output({ help }); else console.log(help);
    return;
  }
  check(args[0] !== 'runner', 'Runner execution nodes are retired; only local execution is supported');
  check(!args.some(arg => arg === '--runner-node' || arg.startsWith('--runner-node=')), '--runner-node is retired; new Workers always execute locally');
  // Resolve the longest registered leaf before project discovery or any handler
  // side effect. The executable is supplied by the fixed bin, never by argv.
  const entry = CLI_COMMANDS.filter(item => !item.directory && item.path.split(' ').every((part, index) => args[index] === part))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (entry && !commandExecutables(entry).includes(executable)) {
    throw new Error(`${executable} ${entry.path} is not available; use ${commandExecutables(entry)[0]} ${entry.path}`);
  }
  if (entry && process.env.LUSH_AGENT_TOKEN && !management && !LUSHW_PATHS.has(entry.path)) {
    throw new Error(`${executable} ${entry.path} is a management command; development Agent invocations must use lushw`);
  }
  const root = args[0];
  const rootAvailable = CLI_COMMANDS.some(item => !item.directory && item.path.split(' ')[0] === root && commandExecutables(item).includes(executable));
  if (!rootAvailable) {
    const elsewhere = CLI_COMMANDS.find(item => !item.directory && item.path.split(' ')[0] === root);
    if (elsewhere) throw new Error(`${executable} ${root} is not available; use ${commandExecutables(elsewhere)[0]} ${root}`);
    throw new Error(`unknown command: ${root}; run ${executable} help`);
  }
  check(entry, `unknown ${root} command; run ${executable} help`);
  // Only the fixed management bridge supplies this context. Gate before any handler,
  // project discovery, file access, service control or user-identity client creation.
  if (management) management.assertCommand(entry, args);
  let command = args.shift();
  if (command === 'host') {
    if (!['start', 'stop', 'restart', 'status'].includes(args[0])) {
      throw new Error(`host requires start|stop|restart|status; run ${executable} help`);
    }
    command = `host:${args.shift()}`;
  }
  const handler = COMMANDS.get(command);
  if (!handler) throw new Error(`unknown command: ${command}; run ${executable} help`);
  const invoke = async context => {
    try { return await handler(command, args, context); }
    catch (error) {
      // Keep the original failure and exit semantics; help is local and never replays a request.
      if (error instanceof Error && !management) error.message += `\n用法：${entry.usage.replace(/^lush(?=\s|$)/, executable)}\n帮助：${executable} help ${entry.path}（只读，不会重试；请求结果未知时不要重放）`;
      throw error;
    }
  };
  // Guides and question construction return before project discovery, settings, sockets
  // or credentials. Questions read only explicit files and return JSON, never project state.
  if (command === 'skills' || command === 'question') {
    const value = await invoke({ json, executable });
    if (value !== undefined) emit(value);
    return;
  }
  if (management) {
    const value = await invoke({ client: management.client, json: true, executable, management: true });
    if (value !== undefined) emit(value);
    return;
  }
  if (executable === 'lushw') check(Boolean(process.env.LUSH_AGENT_TOKEN || process.env.LUSH_CLI_TRIAL), 'lushw data commands require an active Worker invocation');
  const globalWeb = command.startsWith('host:') && !projectPath && !process.env.LUSH_PROJECT;
  const selectedConfig = globalWeb ? launcherWebConfig(process.env) : Config.fromEnv(process.env, process.cwd(), projectPath);
  const client = globalWeb
    ? { config: selectedConfig, token: process.env.LUSH_AGENT_TOKEN || null }
    : new UIClient(selectedConfig, process.env.LUSH_AGENT_TOKEN || null);
  const value = await invoke({ client, json, executable, userContext: !client.token && Boolean(process.env.LUSH_CLI_TRIAL) });
  if (value === undefined) return;
  if (value?.fingerprint) {
    const local = codeIdentity();
    if (value.fingerprint !== local.fingerprint || value.code_dir !== local.code_dir) {
      const project = value.project || selectedConfig.project;
      console.error(`${executable}: 项目 ${project} 的 daemon 与当前磁盘代码不一致；确认没有活动 invocation 后运行 bun run daemon-restart --project ${JSON.stringify(project)}`);
    }
  }
  emit(value);
}
