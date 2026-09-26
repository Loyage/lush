import { check, id, TERMINAL } from '../../core/types.js';
import { option, exact } from '../args.js';
import { printTree, printLadder, printTimeline, printMergeMany, printTranscript, transcriptStepText, printUsage } from '../print.js';

/** `task transcript --follow` 的默认轮询间隔；一处定义，测试与体验都按它来。 */
export const FOLLOW_INTERVAL_MS = 1500;
/** 每次向前读取与轮询的步骤上限；与兼容读面的 `MAX_STEPS` 一致。 */
const FOLLOW_LIMIT = 200;

/**
 * `task transcript ID --follow`：先把已有记录按 `task transcript` 的既有分页读出来打印，
 * 再用文档推荐的轮询端点 `task.transcript_latest` 持续打印游标之后的新步骤，直到 `signal` 中止。
 *
 * 只读、不执行日志里的命令。`sleep` / `print` / `note` / `signal` 全部可注入，
 * 让跟随循环能在测试里推进而不必真的等待或等到进程被 Ctrl-C。
 */
export async function followTranscript(client, taskId, {
  after = 0, interval = FOLLOW_INTERVAL_MS, limit = FOLLOW_LIMIT, signal = null,
  print = text => process.stdout.write(text),
  note = text => process.stderr.write(text),
  sleep = ms => Bun.sleep(ms),
} = {}) {
  let cursor = after;
  let sawFile = false;
  let truncated = false;
  // 1) 已有记录沿用兼容读面分页，输出与一次性的 `lush task transcript ID` 完全一致。
  for (;;) {
    const page = await client.request('task.transcript', { id: taskId, after: cursor, limit });
    sawFile = sawFile || page.files.length > 0;
    truncated = truncated || Boolean(page.truncated);
    if (!page.steps.length) break;
    for (const step of page.steps) print(transcriptStepText(step));
    cursor = page.steps.at(-1).seq;
    if (!page.has_more) break;
  }
  if (!sawFile) { note('(这个任务还没有 pi 会话记录)\n'); return; }
  if (truncated) note('… 会话记录过大，已只读取前面一部分；跟随从最新记录继续，中间可能有未显示的步骤\n');
  note(`─ 以上是已有记录；正在跟随新步骤（每 ${Math.max(1, Math.round(interval / 1000))} 秒检查一次，Ctrl-C 退出）\n`);
  // 2) 跟随：轮询最新步骤，只打印 cursor 之后的新内容；步骤没到时安静等待。
  let notedTruncated = false;
  for (;;) {
    if (signal?.aborted) break;
    await sleep(interval);
    if (signal?.aborted) break;
    const page = await client.request('task.transcript_latest', { id: taskId, after: cursor, before: 0, limit });
    if (page.truncated && !notedTruncated) { notedTruncated = true; note('… 会话中存在超过 16 MiB 的单行，该行无法读取\n'); }
    for (const step of page.steps) print(transcriptStepText(step));
    if (page.steps.length === limit) note('… 一次检查读到整页新步骤，中间可能还有未显示的记录；可用 `lush task transcript ID` 查看完整现状\n');
    if (page.steps.length) cursor = page.next;
  }
  note('（已停止跟随）\n');
}

export async function run(command, args, ctx) {
  const { client, json } = ctx;
  let value;
  if (command === 'task') {
    const verb = args.shift();
    if (verb === 'list') {
      const brief = args.includes('--brief');
      if (brief) args.splice(args.indexOf('--brief'), 1);
      const after = Number(option(args, '--after', '0')), limit = Number(option(args, '--limit', brief ? '30' : '200'));
      exact(args, 0);
      if (brief) check(Number.isInteger(limit) && limit > 0 && limit <= 200, '--brief limit must be 1..200');
      value = await client.request('task.list', { after, limit: brief ? limit + 1 : limit });
      if (brief) {
        const tasks = value.slice(0, limit).map(({ id, parent_id, role, status, integration, goal }) => ({ id, parent_id, role, status, integration,
          goal: goal.replace(/\s+/g, ' ').slice(0, 160), goal_truncated: goal.length >= 160 }));
        value = { tasks, has_more: value.length > limit, next_after: tasks.at(-1)?.id ?? after,
          note: '短摘要；完整目标与结果用 task inspect ID。' };
      }
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
      const role = option(args, '--role');
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
      const follow = args.includes('--follow');
      if (follow) args.splice(args.indexOf('--follow'), 1);
      const after = Number(option(args, '--after', '0')); exact(args, 1);
      const taskId = id(args[0]);
      if (follow) {
        check(!client.token, 'agents must end their invocation rather than follow; use `lush task transcript ID`');
        check(!json, '--follow is a live human-readable stream; --json is not supported');
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once('SIGINT', stop);
        try { await followTranscript(client, taskId, { after, signal: controller.signal }); }
        finally { process.off('SIGINT', stop); }
        return;
      }
      value = await client.request('task.transcript', { id: taskId, after });
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
      check(['inspect','cancel','retry','merge','integrate','reserve','resolve','resolve-divergence','resolve-child-divergence','analyze','unreserve','approve-merge','cleanup','verify','delete','clear'].includes(verb), 'unknown task command');
      if (verb === 'clear') { exact(args, 0); value = await client.request('task.clear'); }
      else if (verb === 'integrate') {
        exact(args, 2);
        value = await client.request('task.integrate', { id: id(args[0]), commit: args[1] });
      } else if (verb === 'reserve') {
        exact(args, 2);
        value = await client.request('task.reserve', { id: id(args[0]), kind: args[1] });
      } else if (verb === 'analyze') {
        exact(args, 2);
        value = await client.request('task.analyze', { id: id(args[0]), question: args[1] });
      } else if (verb === 'resolve-child-divergence') {
        exact(args, 1);
        value = await client.request('task.resolve_child_divergence', { id: id(args[0]) });
      } else if (verb === 'resolve-divergence') {
        exact(args, 1);
        value = await client.request('task.resolve_divergence', { id: id(args[0]) });
      } else if (verb === 'unreserve') {
        exact(args, 1);
        value = await client.request('task.unreserve', { id: id(args[0]) });
      } else if (verb === 'approve-merge') {
        exact(args, 3);
        value = await client.request('task.approve_merge', { id: id(args[0]), commit: args[1], baseline: args[2] });
      } else if (verb === 'merge') {
        // 一个 id 保持原有单任务输出语义；多个 id 走批量合并。
        check(args.length >= 1, 'merge needs at least one task id');
        const ids = args.map(value$1 => id(value$1));
        if (ids.length === 1) value = await client.request('task.merge', { id: ids[0] });
        else {
          value = await client.request('task.merge_many', { ids });
          if (!json) { printMergeMany(value); return; }
        }
      }
      else if (verb === 'cleanup') {
        const keepBranch = args.includes('--keep-branch');
        if (keepBranch) args.splice(args.indexOf('--keep-branch'), 1);
        exact(args, 1); value = await client.request('task.cleanup', { id: id(args[0]), keep_branch: keepBranch });
      } else { exact(args, 1); value = await client.request(`task.${verb}`, { id: id(args[0]) }); }
    }
  }
  return value;
}
