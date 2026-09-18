import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../config.js';
import { UIClient } from '../ui/client.js';
import { daemon } from './daemon.js';
import { codeIdentity } from '../identity.js';
import { check, id, TERMINAL } from '../core/types.js';

export const HELP = `Lush — 项目级多 agent 开发

lush [--project PATH] [--json] <command>
  daemon start|stop|restart|status  一个项目一个进程
  status                          项目、agent、待合并改动
  doctor                          目录、工具链与代码版本
  say '你的想法'                   立即持久化并排入规划队列，不等待开发
  input list                      查看用户输入
  draft add '想法'                 先放进缓存，不规划
  draft list                      查看缓存（尚未提交）的输入
  draft rm ID                     丢掉一条缓存输入
  draft commit                    把缓存整体交给意图分析：一个 planner 拆成多个任务并建依赖
  task list [--after N] [--limit N] 分页任务列表（默认 200 条）
  task tree [ID]                  多级任务树
  task inspect ID                 结果、子任务、消息与工作区
  task history ID [--after N]      分页事件记录
  task spawn '目标' [--parent ID] [--role worker|coordinator|research] [--depends-on ID[:code|order]]
  task message ID '补充说明'       追加输入，不打断当前 invocation
  task cancel|retry ID            取消子树 / 明确重试失败任务
  task wait ID                    仅阻塞此客户端，不占 agent 槽
  task merge ID                   用户明确批准合并到原目标分支
  task cleanup ID                 安全回收 worktree（保留分支）
  notice list                     待决问题与答复
  notice post '问题' [--task ID] [--body '背景']
  notice answer ID '答复'
  notice dismiss ID
  web [PORT]                      本地 Web UI（默认 4318）

默认从当前目录向上发现项目；--project 或 LUSH_PROJECT 显式绑定。
状态固定保存在 <project>/.lush/，不再支持全局 LUSH_HOME。
实现任务需要已提交初始版本的 Git 仓库；主工作树应保持干净。
依赖：一个任务最多一条 code 依赖。code（默认）把上游分支当作本任务 worktree 的基线，
因此看得到上游未合并的改动，但必须先合并上游再合并本任务；order 只等上游结束，代码仍从 HEAD 开始。
依赖不能指向自己的祖先任务（祖先在等子孙结束，双方会互相等死）。
Agent 默认 pi；LUSH_PROVIDER=mock 可离线验证。`;

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  check(index + 1 < args.length && !args[index + 1].startsWith('--'), `${name} requires a value`);
  const value = args[index + 1]; args.splice(index, 2); return value;
}
function exact(args, n) { check(args.length === n, 'invalid arguments; run lush help'); }
function print(value, json) {
  if (json || !Array.isArray(value)) { console.log(JSON.stringify(value, null, 2)); return; }
  if (!value.length) { console.log('(empty)'); return; }
  for (const row of value) console.log(`${row.id ?? '-'}\t${row.status || row.role || ''}\t${(row.goal || row.content || row.title || JSON.stringify(row)).replaceAll('\n',' ').slice(0, 180)}`);
}
export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const projectPath = option(args, '--project');
  const json = args.includes('--json'); if (json) args.splice(args.indexOf('--json'), 1);
  if (!args.length || ['help','--help','-h'].includes(args[0])) { console.log(HELP); return; }
  const config = Config.fromEnv(process.env, process.cwd(), projectPath);
  const client = new UIClient(config, process.env.LUSH_AGENT_TOKEN || null);
  let command = args.shift(), value;
  if (command === 'web') {
    check(!client.token, 'agents cannot start web servers');
    check(args.length <= 1, 'web accepts one port');
    const { startWeb } = await import('../ui/web/server.js');
    const server = startWeb(config, Number(args[0] ?? 4318));
    console.log(`Lush ${config.project}\nhttp://127.0.0.1:${server.port}`); return;
  }
  if (command === 'daemon') {
    check(!client.token, 'agents cannot control daemons'); exact(args, 1); value = await daemon(config, args[0]);
  } else if (command === 'doctor') {
    exact(args, 0);
    value = { bun: Bun.version, project: config.project, home: config.home, socket: config.socket, provider: config.provider, ...codeIdentity() };
    try { value.daemon = await client.request('system.status'); value.code_match = value.daemon.fingerprint === value.fingerprint && value.daemon.code_dir === value.code_dir; }
    catch (error) { value.daemon = error.message; }
  } else if (command === 'status') { exact(args, 0); value = await client.request('system.status');
  } else if (command === 'say' || command === 'intent') {
    if (args[0] === 'submit') args.shift();
    exact(args, 1); value = await client.request('input.submit', { content: args[0] });
  } else if (command === 'input') {
    check(args.length === 1 && args[0] === 'list', 'use input list'); value = await client.request('input.list');
  } else if (command === 'draft') {
    const verb = args.shift();
    if (verb === 'add') { exact(args, 1); value = await client.request('draft.add', { content: args[0] }); }
    else if (verb === 'list') { exact(args, 0); value = await client.request('draft.list'); }
    else if (verb === 'rm' || verb === 'remove') { exact(args, 1); value = await client.request('draft.remove', { id: id(args[0]) }); }
    else if (verb === 'commit' || verb === 'submit') { exact(args, 0); value = await client.request('draft.commit'); }
    else throw new Error('unknown draft command; use add, list, rm or commit');
  } else if (command === 'task') {
    const verb = args.shift();
    if (verb === 'list') {
      const after = Number(option(args, '--after', '0')), limit = Number(option(args, '--limit', '200'));
      exact(args, 0); value = await client.request('task.list', { after, limit });
    }
    else if (verb === 'tree') { check(args.length <= 1, 'tree accepts an optional ID'); value = await client.request('task.tree', args.length ? { id: id(args[0]) } : {}); }
    else if (verb === 'spawn') {
      const parent = option(args, '--parent', process.env.LUSH_TASK_ID);
      const role = option(args, '--role', 'worker');
      const defaultKind = option(args, '--dep-kind', 'code');
      const deps = [];
      // Repeatable and comma-separated: --depends-on 7,9:order --depends-on 11
      for (let value$1 = option(args, '--depends-on'); value$1 !== null; value$1 = option(args, '--depends-on')) {
        for (const token of value$1.split(',').filter(Boolean)) {
          const [depId, kind = defaultKind] = token.split(':');
          deps.push({ id: id(depId), kind });
        }
      }
      exact(args, 1);
      value = await client.request('task.spawn', { parent: id(parent), role, goal: args[0], deps });
    } else if (verb === 'message') { exact(args, 2); value = await client.request('task.message', { id: id(args[0]), body: args[1] }); }
    else if (verb === 'history') {
      const after = Number(option(args, '--after', '0')); exact(args, 1);
      value = await client.request('task.history', { id: id(args[0]), after });
    } else if (verb === 'wait') {
      check(!client.token, 'agents must end their invocation rather than wait; Lush wakes the parent automatically');
      exact(args, 1);
      do { value = await client.request('task.inspect', { id: id(args[0]) }); if (!TERMINAL.has(value.status)) await Bun.sleep(300); }
      while (!TERMINAL.has(value.status));
      if (value.status !== 'completed') process.exitCode = 1;
    } else {
      check(['inspect','cancel','retry','merge','cleanup'].includes(verb), 'unknown task command'); exact(args, 1);
      value = await client.request(`task.${verb}`, { id: id(args[0]) });
    }
  } else if (command === 'notice') {
    const verb = args.shift();
    if (verb === 'list') { exact(args, 0); value = await client.request('notice.list'); }
    else if (verb === 'post') {
      const task = option(args, '--task', process.env.LUSH_TASK_ID), body = option(args, '--body', ''); exact(args, 1);
      value = await client.request('notice.post', { task: id(task), title: args[0], body });
    } else if (verb === 'answer') { exact(args, 2); value = await client.request('notice.answer', { id: id(args[0]), answer: args[1] }); }
    else if (verb === 'dismiss') { exact(args, 1); value = await client.request('notice.dismiss', { id: id(args[0]) }); }
    else throw new Error('unknown notice command');
  } else if (command === 'log') {
    exact(args, 0); console.log(fs.readFileSync(path.join(config.home, 'daemon.log'), 'utf8').split('\n').slice(-60).join('\n')); return;
  } else throw new Error(`unknown command: ${command}; run lush help`);
  if (value?.fingerprint) {
    const local = codeIdentity();
    if (value.fingerprint !== local.fingerprint || value.code_dir !== local.code_dir) console.error('lush: daemon runs different code; restart this project daemon');
  }
  print(value, json);
}
