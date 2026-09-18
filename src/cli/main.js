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
  input list                      查看用户输入（含 develop/explain 判定）
  input flow [TASK_ID] develop|explain  记录这条输入走哪条流程（agent 省略 TASK_ID 时用自己的任务）
  draft add '想法'                 先放进缓存，不规划
  draft list                      查看缓存（尚未提交）的输入
  draft rm ID                     丢掉一条缓存输入
  draft commit                    把缓存整体交给意图分析：一个 planner 拆成多个任务并建依赖
  task list [--after N] [--limit N] 分页任务列表（默认 200 条）
  task tree [ID]                  多级任务树：依赖（⛓ 基线 / ⏳ 顺序）与兄弟间的并行关系
  task ladder                     合并阶梯：未合并分支之间谁必须先进目标分支、谁已经被别的分支带进来
  task timeline [--limit N]       并行时间轴：每个任务什么时候真的在跑，排队是在等依赖、等槽还是等子任务
  task inspect ID                 结果、agent、子任务、消息与工作区
  task history ID [--after N]      分页事件记录
  task transcript ID [--after N]   只读查看 agent 的思考、工具调用与工具输出（来自 pi 会话记录）
  task usage ID                   只读查看这个 agent 的模型、上下文占用与累计花费（同一批会话记录）
  task spawn '目标' [--parent ID] [--role worker|coordinator|research] [--name short-kebab-name] [--depends-on ID[:code|order]] [--spec SPEC_ID]
      --name 是任务的英文短名，决定 worktree 目录与分支 <id>-<name>；省略时按 goal 里的英文词回退。
      --spec 把这次 spawn 与拆解队列里的 spec 关联（scheduler 必须给）。
  spec list [--status pending|planned|dropped]  查看拆解队列（spec 是等 scheduler 编排的条目，task 才是真实任务）
  spec add '目标与验收标准' [--role worker|coordinator|research] [--name short-kebab-name] [--depends-on SPEC_ID[:code|order]]
      planner 专用：把拆解结果写进队列，不直接建任务。
  spec drop ID [--note '原因']      scheduler/planner 明确放弃一条 spec
  task message ID '补充说明'       追加输入，不打断当前 invocation
  task cancel|retry ID            取消子树 / 明确重试失败任务
  task wait ID                    仅阻塞此客户端，不占 agent 槽
  task merge ID                   用户明确批准合并到原目标分支；内容冲突不会变成报错，而是开一个解冲突任务并提问，
                                  解决前同一目标分支上的其它合并被冻结（答复／忽略那条 notice 即可继续）
  task verify ID                  为一个已完成的 worker 派只读 verifier：演示 worktree 结果并对照目标分支
  task cleanup ID [--keep-branch] 安全回收 worktree 与任务分支（--keep-branch 只回收 worktree）
  task clear                      删除全部已结束任务及 inputs/drafts/notices/events；有活动任务时拒绝
                                  同时按 cleanup 的安全门回收 worktree/分支，回收不掉的保留在磁盘上并列出原因
                                  分支名带着旧 task id，所以 id 不复用
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
  for (const row of value) {
    const flow = Object.hasOwn(row, 'flow') && row.flow ? `\t${row.flow}` : '';
    console.log(`${row.id ?? '-'}\t${row.status || row.role || ''}${flow}\t${(row.goal || row.content || row.title || JSON.stringify(row)).replaceAll('\n',' ').slice(0, 180)}`);
  }
}
function printTranscript(page) {
  if (!page.steps.length) { console.log(page.files.length ? '(会话记录里没有可显示的步骤)' : '(这个任务还没有 pi 会话记录)'); return; }
  for (const step of page.steps) console.log(`[${step.seq}] ${step.kind}\t${step.title}${step.at ? `\t${step.at}` : ''}\n${step.body}\n`);
  if (page.has_more) console.error(`… 还有更多步骤；用 --after ${page.next} 继续`);
  if (page.truncated) console.error('… 会话记录过大，只读取了前面一部分');
}
function printUsage(usage) {
  if (!usage.files.length) { console.log('(这个任务还没有 pi 会话记录)'); return; }
  const model = usage.model ? [usage.model.provider, usage.model.model_id].filter(Boolean).join('/') : '—';
  const t = usage.totals;
  console.log(`模型\t${model}${usage.thinking_level ? ` · 思考等级 ${usage.thinking_level}` : ''}`);
  console.log(`上下文\t${usage.context_tokens} tokens（最近一次请求）`);
  console.log(`累计\t输入 ${t.input} · 输出 ${t.output} · 缓存读 ${t.cache_read} · 缓存写 ${t.cache_write} · 推理 ${t.reasoning}`);
  console.log(`花费\t$${t.cost.toFixed(6)}（${usage.requests} 次模型请求）`);
  console.log(`会话\t${usage.files.length} 个文件${usage.compacted ? ` · 上下文压缩 ${usage.compacted} 次` : ''}`);
  if (usage.truncated) console.error('… 会话记录过大，统计只覆盖前面一部分');
}
/* ---------- 并行/串行关系：任务树、合并阶梯、时间轴 ---------- */
const DEP_MARK = { code: '⛓', order: '⏳' };
const DEP_WORD = { code: '基线', order: '顺序' };
const WAIT_LABEL = { dep: '等依赖', children: '等子任务', user: '等你决定', slot: '等并发槽', setup: '没跑起来就结束' };
const INTEGRATION_WORD = { pending: '待合并', review: '待复查', merging: '合并中', merged: '已合并', conflict: '冲突待处理', superseded: '已作废' };
const oneLine = (value, max = 60) => String(value ?? '').replace(/\s+/g, ' ').slice(0, max);
const indent = depth => '  '.repeat(depth);
const settled = dep => TERMINAL.has(dep.status);
function depLabels(task) {
  return (task.deps || []).map(dep => `${DEP_MARK[dep.kind] || ''}#${dep.id}${DEP_WORD[dep.kind] || ''}${settled(dep) ? '' : '·等'}`).join(' ');
}
/** 此刻为什么没在干活；和 Web 树里那行是同一套说法。 */
function whyText(task, children = []) {
  const waiting = (task.deps || []).filter(dep => !settled(dep));
  if (task.status === 'running') return '在跑（占 1 个并发槽）';
  if (task.status === 'queued') return waiting.length ? `排队：等 ${waiting.map(dep => `#${dep.id}`).join('、')}` : '排队：等并发槽';
  if (task.status === 'waiting') return `等子任务（${children.filter(child => child.status === 'running').length} 个在跑）`;
  if (task.status === 'awaiting') return '等你决定';
  if (task.status === 'completed' && task.integration === 'conflict') return '合并冲突：等你决定要不要开解冲突任务';
  if (task.status === 'completed' && ['pending', 'review'].includes(task.integration)) return '等你批准合并';
  return null;
}
/** 兄弟之间无依赖＝可以同时跑；有依赖＝串成链。 */
function siblingChain(children) {
  const ids = new Set(children.map(child => child.id));
  const inner = new Map(children.map(child => [child.id, (child.deps || []).filter(dep => ids.has(dep.id))]));
  const level = new Map();
  const depth = (taskId, seen = new Set()) => {
    if (level.has(taskId)) return level.get(taskId);
    if (seen.has(taskId)) return 0;
    seen.add(taskId);
    const upstreams = inner.get(taskId) || [];
    const value = upstreams.length ? 1 + Math.max(...upstreams.map(dep => depth(dep.id, seen))) : 0;
    level.set(taskId, value); return value;
  };
  for (const child of children) depth(child.id);
  const levels = new Map();
  for (const child of children) { const at = level.get(child.id); if (!levels.has(at)) levels.set(at, []); levels.get(at).push(child.id); }
  return [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group.sort((a, b) => a - b));
}
function printTree(value, status) {
  const roots = Array.isArray(value) ? value : [value];
  const flat = [];
  const collect = node => { flat.push(node); for (const child of node.children || []) collect(child); };
  roots.forEach(collect);
  const ready = flat.filter(task => task.status === 'queued' && !(task.deps || []).some(dep => !settled(dep))).length;
  console.log(`并发上限 ${status?.concurrency ?? '?'} · ${status?.agents?.length ?? '?'} 个在跑 · ${ready} 个在等槽 · ${flat.length} 个任务`);
  console.log('⛓ = 分支基线（必须先合上游）  ⏳ = 只等上游结束  ‖ = 兄弟之间无依赖，可同时跑');
  const walk = (node, depth) => {
    const children = node.children || [];
    if (children.length > 1) {
      const chain = siblingChain(children).map(group => group.length > 1 ? `{${group.map(taskId => `#${taskId}`).join(' ‖ ')}}` : `#${group[0]}`).join(' → ');
      console.log(`${indent(depth + 1)}‖ ${chain}（并列的可同时跑）`);
    }
    const meta = [depLabels(node), INTEGRATION_WORD[node.integration] || '', whyText(node, children)].filter(Boolean).join(' · ');
    console.log(`${indent(depth)}#${node.id} ${node.role} ${node.status}${meta ? `  ${meta}` : ''}  ${oneLine(node.goal)}`);
    for (const child of children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
}
function printLadder(ladder) {
  if (!ladder.nodes.length) { console.log(`没有待合并的分支（目标分支 ${ladder.target_branch ?? '—'}）。`); return; }
  console.log(`合并阶梯 → ${ladder.target_branch}${ladder.truncated ? '（只列出前 50 个）' : ''}`);
  for (const node of ladder.nodes) {
    console.log(`${indent(node.level)}L${node.level} #${node.id} ${node.role} ${node.branch}${node.covered_by.length ? `  ⚠ 已被 #${node.covered_by.join('、')} 带进来：合后者即可` : ''}`);
    for (const dep of node.deps) console.log(`${indent(node.level + 1)}${dep.kind === 'code' ? '⛓ 必须先合' : '⏳ 只等结束'} #${dep.id} ${dep.branch ?? ''}${dep.merged ? '（已合并）' : ''}${dep.kind === 'order' && dep.contains ? '（它的提交已经在下游里）' : ''}`);
  }
  const first = ladder.nodes.filter(node => node.level === 0 && !node.covered_by.length).map(node => node.id);
  if (first.length) console.log(`先合 ${first.map(taskId => `#${taskId}`).join('、')}；命令：lush task merge <id>`);
}
function printTimeline(page) {
  const start = Date.parse(page.start), end = Date.parse(page.end), span = Math.max(end - start, 1);
  const width = Math.max(24, Math.min((process.stdout.columns || 100) - 34, 96));
  const cell = at => Math.max(0, Math.min(width, Math.round(((at - start) / span) * width)));
  const stamp = at => new Date(at).toTimeString().slice(0, 8);
  console.log(`${stamp(start)} → ${stamp(end)} · 并发上限 ${page.concurrency}${page.clamped ? ' · 窗口已截断' : ''}${page.truncated ? ' · 更早的任务未列出' : ''}`);
  for (const task of page.tasks) {
    const track = Array(width).fill('·');
    // 只看得到方格的变化：毫秒级的调度延迟不画，也不进"在等什么"的说明。
    const visible = task.segments.filter(segment => segment.kind === 'run' || segment.reason === 'setup' || cell(Date.parse(segment.end)) > cell(Date.parse(segment.start)));
    for (const segment of visible) {
      const from = cell(Date.parse(segment.start)), to = Math.max(from + 1, cell(Date.parse(segment.end)));
      for (let index = from; index < to && index < width; index += 1) track[index] = segment.kind === 'run' ? '█' : '▒';
    }
    const waits = [...new Set(visible.filter(segment => segment.kind === 'wait' && segment.reason).map(segment => WAIT_LABEL[segment.reason] || segment.reason))];
    console.log(`#${String(task.id).padEnd(3)} ${task.role.padEnd(11)} ${track.join('')} ${waits.join('/')}${task.segments.some(segment => segment.open) ? ' ←进行中' : ''}`);
  }
  console.log('█ = 真的在跑（invocation 区间）  ▒ = 排队  · = 任务已结束');
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
    const verb = args.shift();
    if (verb === 'list') { exact(args, 0); value = await client.request('input.list'); }
    else if (verb === 'flow') {
      check(args.length === 1 || args.length === 2, 'use input flow [TASK_ID] develop|explain');
      const flow = args.length === 2 ? args[1] : args[0];
      const task = args.length === 2 ? args[0] : process.env.LUSH_TASK_ID;
      value = await client.request('input.flow', task ? { id: id(task), flow } : { flow });
    } else throw new Error('unknown input command; use list or flow');
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
    else if (verb === 'tree') {
      check(args.length <= 1, 'tree accepts an optional ID');
      const request = args.length ? { id: id(args[0]) } : {};
      if (!json) {
        // 树本身看不出并发槽与排队，所以顺带问一句 status，让"为什么没在跑"也有答案。
        const [tree, status] = await Promise.all([client.request('task.tree', request), client.request('system.status')]);
        printTree(tree, status); return;
      }
      value = await client.request('task.tree', request);
    }
    else if (verb === 'ladder') { exact(args, 0); value = await client.request('task.ladder'); if (!json) { printLadder(value); return; } }
    else if (verb === 'timeline') {
      const limit = option(args, '--limit'); exact(args, 0);
      value = await client.request('system.timeline', limit ? { limit: Number(limit) } : {});
      if (!json) { printTimeline(value); return; }
    }
    else if (verb === 'spawn') {
      const parent = option(args, '--parent', process.env.LUSH_TASK_ID);
      const role = option(args, '--role', 'worker');
      const name = option(args, '--name');
      const spec = option(args, '--spec');
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
      value = await client.request('task.spawn', { parent: id(parent), role, goal: args[0], deps, name, spec: spec === null ? null : id(spec) });
    } else if (verb === 'transcript') {
      const after = Number(option(args, '--after', '0')); exact(args, 1);
      value = await client.request('task.transcript', { id: id(args[0]), after });
      if (!json) { printTranscript(value); return; }
    } else if (verb === 'usage') {
      exact(args, 1);
      value = await client.request('task.usage', { id: id(args[0]) });
      if (!json) { printUsage(value); return; }
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
      check(['inspect','cancel','retry','merge','cleanup','verify','clear'].includes(verb), 'unknown task command');
      if (verb === 'clear') { exact(args, 0); value = await client.request('task.clear'); }
      else if (verb === 'cleanup') {
        const keepBranch = args.includes('--keep-branch');
        if (keepBranch) args.splice(args.indexOf('--keep-branch'), 1);
        exact(args, 1); value = await client.request('task.cleanup', { id: id(args[0]), keep_branch: keepBranch });
      } else { exact(args, 1); value = await client.request(`task.${verb}`, { id: id(args[0]) }); }
    }
  } else if (command === 'spec') {
    const verb = args.shift();
    if (verb === 'list') {
      const status = option(args, '--status');
      if (status) check(['pending','planned','dropped'].includes(status), '--status must be pending, planned or dropped');
      exact(args, 0);
      value = await client.request('spec.list');
      if (status) value = value.filter(row => row.status === status);
    } else if (verb === 'add') {
      const role = option(args, '--role');
      const name = option(args, '--name');
      const defaultKind = option(args, '--dep-kind', 'code');
      const deps = [];
      // Repeatable and comma-separated, like task spawn: --depends-on 7,9:order --depends-on 11
      for (let raw = option(args, '--depends-on'); raw !== null; raw = option(args, '--depends-on')) {
        for (const token of raw.split(',').filter(Boolean)) {
          const [specId, kind = defaultKind] = token.split(':');
          deps.push({ spec: id(specId), kind });
        }
      }
      exact(args, 1);
      value = await client.request('spec.add', { goal: args[0], role, name, deps });
    } else if (verb === 'drop') {
      const note = option(args, '--note');
      exact(args, 1);
      value = await client.request('spec.drop', { id: id(args[0]), note });
    } else throw new Error('unknown spec command; use list, add or drop');
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
