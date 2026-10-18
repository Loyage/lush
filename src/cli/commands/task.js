import { normalizeMergeConditions } from '../../core/merge-conditions.js';
import { check, TERMINAL } from '../../core/types.js';
import { resolveWorkerId } from '../worker-number.js';
import { option, exact } from '../args.js';
import { runWorkerHook, runWorkerCompletion } from './hooks.js';
import { printTree, printTranscript } from '../print.js';

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
        const tasks = value.slice(0, limit).map(({ id, worker_number, parent_id, role, status, integration, display_title, auto_title, goal }) => ({ id, worker_number: worker_number ?? null, parent_id, role, status, integration,
          display_title: display_title ?? null, auto_title: auto_title ?? null,
          goal: goal.replace(/\s+/g, ' ').slice(0, 160), goal_truncated: goal.length >= 160 }));
        value = { tasks, has_more: value.length > limit, next_after: tasks.at(-1)?.id ?? after,
          note: `短摘要；完整目标与结果用 ${ctx.executable ?? 'lushw'} worker inspect ID。` };
      }
    }
    else if (verb === 'rename') {
      check(!client.token, 'Worker titles are user only, not an agent operation');
      exact(args, 2);
      value = await client.request('worker.rename', { id: await resolveWorkerId(client, args[0]), title: args[1] });
    }
    else if (verb === 'hooks') {
      check(!client.token, 'Hooks configuration is user only, not an agent operation');
      exact(args, 1); value = await client.request('worker.hooks', { id: await resolveWorkerId(client, args[0]) });
    }
    else if (verb === 'merge-conditions' || verb === 'merge-after') {
      check(!client.token, 'merge conditions are user only; Valet must use manager.call');
      if (verb === 'merge-conditions') {
        exact(args, 1); value = await client.request('worker.merge_conditions', { id: await resolveWorkerId(client, args[0]) });
      } else {
        const revision = option(args, '--revision'), conditions = [];
        for (let index = 0; index < args.length;) {
          if (!['--after-settled','--after-merged'].includes(args[index])) { index++; continue; }
          const flag = args[index], worker = args[index + 1];
          check(worker && !worker.startsWith('--'), `${flag} requires a Worker`);
          conditions.push({ kind: flag === '--after-settled' ? 'worker_settled' : 'worker_merged', worker_id: await resolveWorkerId(client, worker) });
          args.splice(index, 2);
        }
        exact(args, 1);
        check(typeof revision === 'string' && revision.length > 0, 'merge-after requires --revision REV');
        value = await client.request('worker.merge_after', { id: await resolveWorkerId(client, args[0]), conditions: normalizeMergeConditions(conditions), expected_revision: revision });
      }
    }
    else if (verb === 'hook') { value = await runWorkerHook(args, client); }
    else if (verb === 'completion') { value = await runWorkerCompletion(args, client); }
    else if (verb === 'tree') {
      check(args.length <= 1, 'tree accepts an optional ID');
      const request = args.length ? { id: await resolveWorkerId(client, args[0]) } : {};
      if (!json) {
        // 树本身看不出真实调用与排队，所以顺带问一句 status，让"为什么没在跑"也有答案。
        const [tree, status] = await Promise.all([client.request('worker.tree', request), client.request('system.status')]);
        printTree(tree, status); return;
      }
      value = await client.request('worker.tree', request);
    }
    else if (verb === 'spawn') {
      const parent = option(args, '--parent');
      const name = option(args, '--name');
      exact(args, 1);
      value = await client.request('worker.spawn', { parent: await resolveWorkerId(client, parent), goal: args[0], ...(name ? { name } : {}) });
    } else if (verb === 'watch') {
      check(client.token == null, 'native watching is user only; agents must end their invocation');
      check(!json, 'native watching requires a real terminal; --json is not supported');
      const after = Number(option(args, '--after', '0')); exact(args, 1);
      check(Number.isSafeInteger(after) && after >= 0 && after < Number.MAX_SAFE_INTEGER, 'invalid transcript cursor');
      const taskId = await resolveWorkerId(client, args[0]);
      const task = await client.request('worker.inspect', { id: taskId });
      const watch = ctx.watchWorker ?? (await import('../native-watch.js')).watchWorker;
      await watch(client, taskId, { after, label: task.worker_number || `#${taskId}`, env: client.config?.env });
      return;
    } else if (verb === 'transcript') {
      check(!args.includes('--follow'), '纯文本跟随已移除；持续观看请使用 lush worker watch ID');
      const after = Number(option(args, '--after', '0')); exact(args, 1);
      const taskId = await resolveWorkerId(client, args[0]);
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
      check(['inspect','cancel','retry','interrupt','resume','merge','merge-all','auto-merge','accept','accept-preview','reopen','sync-parent','resolve-sync','clear-override','merge-cancel','cleanup','delete-preview','delete'].includes(verb), 'unknown worker command');
      if (verb === 'merge') {
        exact(args, 1);
        value = await client.request('worker.reserve', { id: await resolveWorkerId(client, args[0]), kind: 'merge' });
      } else if (verb === 'accept-preview' || verb === 'accept') {
        const force = args.includes('--force');
        if (force) args.splice(args.indexOf('--force'), 1);
        const confirm = args.includes('--confirm');
        if (confirm) args.splice(args.indexOf('--confirm'), 1);
        const revision = option(args, '--revision');
        exact(args, 1);
        if (verb === 'accept-preview' || force) check(!client.token, '强制验收仅允许用户显式操作');
        check(verb === 'accept-preview' ? !force && !confirm && revision === null
          : force ? confirm && typeof revision === 'string' && /^[0-9a-f]{64}$/.test(revision) : !confirm && revision === null,
        '先运行 worker accept-preview ID；强制验收需要 accept ID --force --confirm --revision REV');
        value = await client.request(verb === 'accept-preview' ? 'worker.accept_preview' : force ? 'worker.accept_force' : 'worker.accept',
          { id: await resolveWorkerId(client, args[0]), ...(force ? { revision, confirm: true } : {}) });
      } else if (verb === 'auto-merge') {
        exact(args, 2);
        check(['on','off'].includes(args[1]), 'auto-merge expects on or off');
        value = await client.request('worker.auto_merge', { id: await resolveWorkerId(client, args[0]), enabled: args[1] === 'on' });
      } else if (verb === 'merge-all') {
        exact(args, 1);
        value = await client.request('worker.reserve_all', { branch: args[0] });
      } else if (verb === 'sync-parent' || verb === 'resolve-sync' || verb === 'clear-override') {
        exact(args, 1);
        value = await client.request(`worker.${verb.replaceAll('-', '_')}`, { id: await resolveWorkerId(client, args[0]) });
      } else if (verb === 'merge-cancel') {
        exact(args, 1);
        value = await client.request('worker.unreserve', { id: await resolveWorkerId(client, args[0]) });
      } else if (verb === 'delete' || verb === 'delete-preview') {
        check(!client.token, 'Worker deletion is user only, not an agent operation');
        const force = args.includes('--force');
        if (force) args.splice(args.indexOf('--force'), 1);
        const confirm = args.includes('--confirm');
        if (confirm) args.splice(args.indexOf('--confirm'), 1);
        const revision = option(args, '--revision');
        exact(args, 1);
        check(verb === 'delete' ? confirm && typeof revision === 'string' && revision.length > 0 : !confirm && revision === null,
          'first run worker delete-preview ID; worker delete requires --confirm --revision REV');
        value = await client.request(verb === 'delete' ? 'worker.delete' : 'worker.delete_preview',
          { id: await resolveWorkerId(client, args[0]), ...(confirm ? { revision, confirm: true } : {}), ...(force ? { force: true } : {}) });
      } else if (verb === 'cleanup') {
        const keepBranch = args.includes('--keep-branch');
        if (keepBranch) args.splice(args.indexOf('--keep-branch'), 1);
        exact(args, 1); value = await client.request('worker.cleanup', { id: await resolveWorkerId(client, args[0]), keep_branch: keepBranch });
      } else { exact(args, 1); value = await client.request(`worker.${verb}`, { id: await resolveWorkerId(client, args[0]) }); }
    }
  }
  return value;
}
