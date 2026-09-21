import { check, id, TERMINAL } from '../../core/types.js';
import { option, exact } from '../args.js';
import { printTree, printLadder, printTimeline, printMergeMany, printTranscript, printUsage } from '../print.js';

export async function run(command, args, ctx) {
  const { client, json } = ctx;
  let value;
  if (command === 'task') {
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
      check(['inspect','cancel','retry','merge','cleanup','verify','delete','clear'].includes(verb), 'unknown task command');
      if (verb === 'clear') { exact(args, 0); value = await client.request('task.clear'); }
      else if (verb === 'merge') {
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
