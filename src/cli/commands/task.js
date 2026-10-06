import { check, TERMINAL } from '../../core/types.js';
import { resolveWorkerId } from '../worker-number.js';
import { option, exact } from '../args.js';
import { printTree, printLadder, printTimeline, printMergeMany, printTranscript, transcriptStepText, printUsage } from '../print.js';

/** `worker transcript --follow` 的默认轮询间隔；一处定义，测试与体验都按它来。 */
export const FOLLOW_INTERVAL_MS = 1500;
/** 每次向前读取与轮询的步骤上限；与兼容读面的 `MAX_STEPS` 一致。 */
const FOLLOW_LIMIT = 200;

/**
 * `worker transcript ID --follow`：先把已有记录按 `worker transcript` 的既有分页读出来打印，
 * 再用文档推荐的轮询端点 `worker.transcript_latest` 持续打印游标之后的新步骤，直到 `signal` 中止。
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
  // 1) 已有记录沿用兼容读面分页，输出与一次性的 `lush worker transcript ID` 完全一致。
  for (;;) {
    const page = await client.request('worker.transcript', { id: taskId, after: cursor, limit });
    sawFile = sawFile || page.files.length > 0;
    truncated = truncated || Boolean(page.truncated);
    if (!page.steps.length) break;
    for (const step of page.steps) print(transcriptStepText(step));
    cursor = page.steps.at(-1).seq;
    if (!page.has_more) break;
  }
  if (!sawFile) { note('(这个 Worker 还没有 pi 会话记录)\n'); return; }
  if (truncated) note('… 会话记录过大，已只读取前面一部分；跟随从最新记录继续，中间可能有未显示的步骤\n');
  note(`─ 以上是已有记录；正在跟随新步骤（每 ${Math.max(1, Math.round(interval / 1000))} 秒检查一次，Ctrl-C 退出）\n`);
  // 2) 跟随：轮询最新步骤，只打印 cursor 之后的新内容；步骤没到时安静等待。
  let notedTruncated = false;
  for (;;) {
    if (signal?.aborted) break;
    await sleep(interval);
    if (signal?.aborted) break;
    const page = await client.request('worker.transcript_latest', { id: taskId, after: cursor, before: 0, limit });
    if (page.truncated && !notedTruncated) { notedTruncated = true; note('… 会话中存在超过 16 MiB 的单行，该行无法读取\n'); }
    for (const step of page.steps) print(transcriptStepText(step));
    if (page.steps.length === limit) note('… 一次检查读到整页新步骤，中间可能还有未显示的记录；可用 `lush worker transcript ID` 查看完整现状\n');
    if (page.steps.length) cursor = page.next;
  }
  note('（已停止跟随）\n');
}

export async function run(command, args, ctx) {
  const { client, json } = ctx;
  let value;
  if (command === 'worker') {
    const verb = args.shift();
    if (verb === 'list') {
      const brief = args.includes('--brief');
      if (brief) args.splice(args.indexOf('--brief'), 1);
      const after = Number(option(args, '--after', '0')), limit = Number(option(args, '--limit', brief ? '30' : '200'));
      exact(args, 0);
      if (brief) check(Number.isInteger(limit) && limit > 0 && limit <= 200, '--brief limit must be 1..200');
      value = await client.request('worker.list', { after, limit: brief ? limit + 1 : limit });
      if (brief) {
        const tasks = value.slice(0, limit).map(({ id, worker_number, parent_id, role, status, integration, goal }) => ({ id, worker_number: worker_number ?? null, parent_id, role, status, integration,
          goal: goal.replace(/\s+/g, ' ').slice(0, 160), goal_truncated: goal.length >= 160 }));
        value = { tasks, has_more: value.length > limit, next_after: tasks.at(-1)?.id ?? after,
          note: '短摘要；完整目标与结果用 lush worker inspect ID。' };
      }
    }
    else if (verb === 'tree') {
      check(args.length <= 1, 'tree accepts an optional ID');
      const request = args.length ? { id: await resolveWorkerId(client, args[0]) } : {};
      if (!json) {
        // 树本身看不出并发槽与排队，所以顺带问一句 status，让"为什么没在跑"也有答案。
        const [tree, status] = await Promise.all([client.request('worker.tree', request), client.request('system.status')]);
        printTree(tree, status); return;
      }
      value = await client.request('worker.tree', request);
    }
    else if (verb === 'spawn') {
      const parent = option(args, '--parent', process.env.LUSH_TASK_ID);
      const name = option(args, '--name');
      exact(args, 1);
      value = await client.request('worker.spawn', { parent: await resolveWorkerId(client, parent), goal: args[0], ...(name ? { name } : {}) });
    } else if (verb === 'transcript') {
      const follow = args.includes('--follow');
      if (follow) args.splice(args.indexOf('--follow'), 1);
      const after = Number(option(args, '--after', '0')); exact(args, 1);
      if (follow) {
        check(!client.token, 'agents must end their invocation rather than follow; use `lush worker transcript ID`');
        check(!json, '--follow is a live human-readable stream; --json is not supported');
      }
      const taskId = await resolveWorkerId(client, args[0]);
      if (follow) {
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once('SIGINT', stop);
        try { await followTranscript(client, taskId, { after, signal: controller.signal }); }
        finally { process.off('SIGINT', stop); }
        return;
      }
      value = await client.request('worker.transcript', { id: taskId, after });
      if (!json) { printTranscript(value); return; }
    } else if (verb === 'message') { exact(args, 2); value = await client.request('worker.message', { id: await resolveWorkerId(client, args[0]), body: args[1] }); }
    else if (verb === 'history') {
      const after = Number(option(args, '--after', '0')); exact(args, 1);
      value = await client.request('worker.history', { id: await resolveWorkerId(client, args[0]), after });
    } else if (verb === 'wait') {
      check(!client.token, 'agents must end their invocation rather than wait; Lush wakes the parent automatically');
      exact(args, 1);
      const taskId = await resolveWorkerId(client, args[0]);
      do { value = await client.request('worker.inspect', { id: taskId }); if (!TERMINAL.has(value.status)) await Bun.sleep(300); }
      while (!TERMINAL.has(value.status));
      if (value.status !== 'completed') process.exitCode = 1;
    } else {
      check(['inspect','cancel','retry','interrupt','resume','integrate','reserve','reserve-all','auto-merge','resolve','accept','reopen','sync-parent','resolve-sync','clear-override','resolve-divergence','resolve-child-divergence','unreserve','approve-merge','cleanup','delete'].includes(verb), 'unknown worker command');
      if (verb === 'integrate') {
        exact(args, 2);
        value = await client.request('worker.integrate', { id: await resolveWorkerId(client, args[0]), commit: args[1] });
      } else if (verb === 'reserve') {
        exact(args, 2);
        value = await client.request('worker.reserve', { id: await resolveWorkerId(client, args[0]), kind: args[1] });
      } else if (verb === 'auto-merge') {
        exact(args, 2);
        check(['on','off'].includes(args[1]), 'auto-merge expects on or off');
        value = await client.request('worker.auto_merge', { id: await resolveWorkerId(client, args[0]), enabled: args[1] === 'on' });
      } else if (verb === 'reserve-all') {
        exact(args, 1);
        value = await client.request('worker.reserve_all', { branch: args[0] });
      } else if (verb === 'resolve-child-divergence') {
        exact(args, 1);
        value = await client.request('worker.resolve_child_divergence', { id: await resolveWorkerId(client, args[0]) });
      } else if (verb === 'resolve-divergence') {
        exact(args, 1);
        value = await client.request('worker.resolve_divergence', { id: await resolveWorkerId(client, args[0]) });
      } else if (verb === 'sync-parent' || verb === 'resolve-sync' || verb === 'clear-override') {
        exact(args, 1);
        value = await client.request(`worker.${verb.replaceAll('-', '_')}`, { id: await resolveWorkerId(client, args[0]) });
      } else if (verb === 'unreserve') {
        exact(args, 1);
        value = await client.request('worker.unreserve', { id: await resolveWorkerId(client, args[0]) });
      } else if (verb === 'approve-merge') {
        exact(args, 3);
        value = await client.request('worker.approve_merge', { id: await resolveWorkerId(client, args[0]), commit: args[1], baseline: args[2] });
      } else if (verb === 'delete') {
        check(!client.token, 'Worker deletion is user only, not an agent operation');
        const confirm = args.includes('--confirm');
        if (confirm) args.splice(args.indexOf('--confirm'), 1);
        const revision = option(args, '--revision');
        exact(args, 1);
        check(!revision || confirm, '--revision requires --confirm');
        check(!confirm || (typeof revision === 'string' && revision.length > 0),
          'first run worker delete ID to inspect resources; then confirm with --confirm --revision REV');
        value = await client.request(confirm ? 'worker.delete' : 'worker.delete_preview',
          { id: await resolveWorkerId(client, args[0]), ...(confirm ? { revision, confirm: true } : {}) });
      } else if (verb === 'cleanup') {
        const keepBranch = args.includes('--keep-branch');
        if (keepBranch) args.splice(args.indexOf('--keep-branch'), 1);
        exact(args, 1); value = await client.request('worker.cleanup', { id: await resolveWorkerId(client, args[0]), keep_branch: keepBranch });
      } else { exact(args, 1); value = await client.request(`worker.${verb}`, { id: await resolveWorkerId(client, args[0]) }); }
    }
  }
  return value;
}
