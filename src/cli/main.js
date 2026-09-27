import { Config } from '../config.js';
import { UIClient } from '../ui/client.js';
import { codeIdentity } from '../identity.js';
import { check } from '../core/types.js';
import { option, print } from './args.js';
import { HELP } from './help.js';
import { launcherWebConfig } from '../host/registry.js';
import * as system from './commands/system.js';
import * as intent from './commands/intent.js';
import * as ap from './commands/ap.js';
import * as progress from './commands/progress.js';
import * as notice from './commands/notice.js';
import * as branch from './commands/branch.js';
import * as agent from './commands/agent.js';
import * as config from './commands/config.js';

export { HELP };

/* ---------- 命令分发表 ----------
 * 每个处理器签名 run(command, args, ctx)，ctx = { client, json }；
 * 返回 undefined 表示「命令自己已经打印过」，主流程不再 print，也不做 fingerprint 提醒。
 */
const COMMANDS = new Map();
for (const [module, names] of [
  [system, ['daemon', 'status', 'doctor', 'log', 'host', 'host-restart', 'host-stop', 'host-status']],
  [intent, ['say']],
  [ap, ['ap']],
  [progress, ['progress']],
  [notice, ['notice']],
  [branch, ['branch']],
  [agent, ['agent']],
  [config, ['config']],
]) {
  for (const name of names) {
    check(!COMMANDS.has(name), `duplicate command handler: ${name}`);
    check(typeof module.run === 'function', `command module for '${name}' does not export run`);
    COMMANDS.set(name, module.run);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const projectPath = option(args, '--project');
  const json = args.includes('--json'); if (json) args.splice(args.indexOf('--json'), 1);
  // --help / -h 在任意位置都只印帮助：子命令会把裸 --help 当成必填正文落库（spec add / branch summary / notice post 等）。
  // 必须在构造 Config / UIClient 之前返回，保证不解析命令、不发任何 RPC、不做 fingerprint 提醒。
  if (!args.length || ['help','--help','-h'].includes(args[0]) || args.includes('--help') || args.includes('-h')) {
    console.log(HELP); return;
  }
  const command = args.shift();
  const globalWeb = ['host', 'host-restart', 'host-stop', 'host-status'].includes(command) && !projectPath && !process.env.LUSH_PROJECT;
  const selectedConfig = globalWeb ? launcherWebConfig(process.env) : Config.fromEnv(process.env, process.cwd(), projectPath);
  const client = globalWeb
    ? { config: selectedConfig, token: process.env.LUSH_AGENT_TOKEN || null }
    : new UIClient(selectedConfig, process.env.LUSH_AGENT_TOKEN || null);
  const handler = COMMANDS.get(command);
  if (!handler) throw new Error(`unknown command: ${command}; run lush help`);
  const value = await handler(command, args, { client, json });
  if (value === undefined) return;
  if (value?.fingerprint) {
    const local = codeIdentity();
    if (value.fingerprint !== local.fingerprint || value.code_dir !== local.code_dir) {
      const project = value.project || selectedConfig.project;
      console.error(`lush: 项目 ${project} 的 daemon 与当前磁盘代码不一致；确认没有活动 invocation 后运行 bun run daemon-restart --project ${JSON.stringify(project)}`);
    }
  }
  print(value, json);
}
