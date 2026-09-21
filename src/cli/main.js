import { Config } from '../config.js';
import { UIClient } from '../ui/client.js';
import { codeIdentity } from '../identity.js';
import { check } from '../core/types.js';
import { option, print } from './args.js';
import { HELP } from './help.js';
import * as system from './commands/system.js';
import * as intent from './commands/intent.js';
import * as draft from './commands/draft.js';
import * as task from './commands/task.js';
import * as spec from './commands/spec.js';
import * as plan from './commands/plan.js';
import * as notice from './commands/notice.js';
import * as branch from './commands/branch.js';
import * as candidate from './commands/candidate.js';
import * as agent from './commands/agent.js';

export { HELP };

/* ---------- 命令分发表 ----------
 * 每个处理器签名 run(command, args, ctx)，ctx = { client, json }；
 * 返回 undefined 表示「命令自己已经打印过」，主流程不再 print，也不做 fingerprint 提醒。
 */
const COMMANDS = new Map();
for (const [module, names] of [
  [system, ['daemon', 'status', 'doctor', 'log', 'web', 'web-restart', 'web-stop', 'web-status']],
  [intent, ['say', 'intent', 'input']],
  [draft, ['draft']],
  [task, ['task']],
  [spec, ['spec']],
  [plan, ['plan']],
  [notice, ['notice']],
  [branch, ['branch']],
  [candidate, ['candidate']],
  [agent, ['agent']],
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
  if (!args.length || ['help','--help','-h'].includes(args[0])) { console.log(HELP); return; }
  const config = Config.fromEnv(process.env, process.cwd(), projectPath);
  const client = new UIClient(config, process.env.LUSH_AGENT_TOKEN || null);
  const command = args.shift();
  const handler = COMMANDS.get(command);
  if (!handler) throw new Error(`unknown command: ${command}; run lush help`);
  const value = await handler(command, args, { client, json });
  if (value === undefined) return;
  if (value?.fingerprint) {
    const local = codeIdentity();
    if (value.fingerprint !== local.fingerprint || value.code_dir !== local.code_dir) console.error('lush: daemon runs different code; restart this project daemon');
  }
  print(value, json);
}
