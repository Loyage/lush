import { Config } from '../config.js';
import { UIClient } from '../ui/client.js';
import { codeIdentity } from '../identity.js';
import { check } from '../core/types.js';
import { HELP } from './help.js';
import { COMMAND_MODULES, CLI_COMMANDS, cliHelp, cliHelpDocument, commandExecutables, CLI_EXECUTABLES, LUSHW_PATHS } from './catalog.js';
import { parseCLI, validateCLIParameters, cliParameterError } from './parser.js';
import { isOptionIndex } from './args.js';
import { migrationHint, legacyOptionHint } from './migrations.js';
import { resultEnvelope, humanResult } from './output.js';
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
  let parsed, entry, requested = false, handlerEntered = false;
  try {
    parsed = parseCLI(argv, CLI_COMMANDS);
    const { args, project: projectPath, json } = parsed;
    // Only fixed trusted entry points choose a view. No --role/environment identity override.
    const view = management ? 'valet' : executable === 'lushw' ? process.env.LUSH_CLI_TRIAL && !process.env.LUSH_AGENT_TOKEN ? 'worker-user' : 'worker' : 'user';
    const emitHelp = helpArgs => {
      const value = json ? cliHelpDocument(executable, helpArgs, { view }) : cliHelp(executable, helpArgs, { view });
      if (output) output(json ? value : { help: value });
      else console.log(typeof value === 'string' ? value : JSON.stringify(value));
    };
    if (parsed.help) { emitHelp(parsed.helpArgs); return; }
    entry = parsed.entry;
    if (!entry) {
      const directory = CLI_COMMANDS.find(item => item.directory && isOptionIndex(args, args.length - 1) && item.path === args.join(' '));
      if (directory) { emitHelp(directory.path.split(' ')); return; }
      const migration = migrationHint(args);
      if (migration) throw cliParameterError(`旧入口 ${migration.path} 已移除；${migration.replacement}。仅迁移提示，未执行替代操作。`);
      throw cliParameterError(`unknown command; run ${executable} help --search ${JSON.stringify(args[0] ?? '')}`);
    }
    if (!commandExecutables(entry).includes(executable)) throw cliParameterError(`${executable} ${entry.path} is not available; use ${commandExecutables(entry)[0]} help ${entry.path}`);
    if (process.env.LUSH_AGENT_TOKEN && !management && !LUSHW_PATHS.has(entry.path)) {
      throw Object.assign(new Error(`${executable} ${entry.path} is a management command; development Agent invocations must use lushw`), { exitCode: 3, execution: 'not_started' });
    }
    const legacy = legacyOptionHint(args, entry);
    if (legacy) throw cliParameterError(legacy);
    validateCLIParameters(args, entry);
    // Static bridge admission is before discovery, files, service effects and user clients.
    if (management) management.assertCommand(entry, args);
    let command = args.shift();
    if (command === 'host') command = `host:${args.shift()}`;
    const handler = COMMANDS.get(command);
    if (!handler) throw cliParameterError(`unknown command: ${command}; run ${executable} help`);
    const warnings = entry.path === 'worker list' && !args.includes('--view')
      ? ['升级提示：worker list 默认 recent（活动项＋有界历史尾部）；旧完整枚举请显式 --view all。'] : [];
    const emit = value => {
      const result = json ? resultEnvelope(value, entry, warnings) : value;
      if (output) output(result);
      else if (json || command === 'question') console.log(JSON.stringify(result));
      else {
        for (const warning of warnings) console.error(warning);
        console.log(humanResult(value, entry));
      }
    };
    const invoke = async ctx => {
      const client = ctx.client && { ...ctx.client, config: ctx.client.config, token: ctx.client.token, management: ctx.client.management,
        requestId: ctx.client.requestId, request: async (...params) => { requested = true; return ctx.client.request(...params); } };
      handlerEntered = true;
      return handler(command, args, { ...ctx, ...(client ? { client } : {}), json, executable });
    };
    if (command === 'skills' || command === 'question') {
      const value = await invoke({}); if (value !== undefined) emit(value); return;
    }
    if (management) {
      const value = await invoke({ client: management.client, management: true }); if (value !== undefined) emit(value); return;
    }
    if (executable === 'lushw' && !process.env.LUSH_AGENT_TOKEN && !process.env.LUSH_CLI_TRIAL)
      throw Object.assign(new Error('lushw data commands require an active Worker invocation'), { exitCode: 3, execution: 'not_started' });
    const globalWeb = command.startsWith('host:') && !projectPath && !process.env.LUSH_PROJECT;
    const selectedConfig = globalWeb ? launcherWebConfig(process.env) : Config.fromEnv(process.env, process.cwd(), projectPath);
    const client = globalWeb ? { config: selectedConfig, token: process.env.LUSH_AGENT_TOKEN || null }
      : new UIClient(selectedConfig, process.env.LUSH_AGENT_TOKEN || null);
    const value = await invoke({ client, userContext: !client.token && Boolean(process.env.LUSH_CLI_TRIAL) });
    if (value === undefined) return;
    if (value?.fingerprint) {
      const local = codeIdentity();
      if (value.fingerprint !== local.fingerprint || value.code_dir !== local.code_dir)
        console.error(`${executable}: 项目 ${value.project || selectedConfig.project} 的 daemon 与磁盘代码不一致；请用户在安全空闲点分别更新 daemon 与 Host，不能自动重启。`);
    }
    emit(value);
  } catch (error) {
    if (error instanceof Error) {
      if (!error.execution) error.execution = (requested && entry?.operation === 'write' || handlerEntered && entry?.kind === 'local-write')
        ? 'unknown' : requested ? 'not_applicable' : 'not_started';
      if (error.execution === 'unknown' && !error.exitCode) error.exitCode = 5;
      if (!requested && !error.exitCode) error.exitCode = 2;
      error.cliJSON = parsed?.json ?? argv.slice(0, argv.indexOf('--') < 0 ? argv.length : argv.indexOf('--')).includes('--json');
      error.help = `${executable} help${entry ? ` ${entry.path}` : ''}`;
      if (!management) error.message += `\n帮助：${error.help}（只读；未知副作用不重放）`;
    }
    throw error;
  }
}
