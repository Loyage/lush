import { check } from '../../core/types.js';
import { exact } from '../args.js';
import { printBranchTree, printBranchShow, printBranchImport, printBranchArchive, printBranchSummary, printMergeAllPlan, printMergeAllResult, printMergeCancel } from '../print.js';

/** branch：分支谱系（谁从谁创建出来），与任务树、commit graph 都是不同维度。 */
export async function run(command, args, ctx) {
  const { client, json } = ctx;
  let value;
  const verb = args.shift();
  if (verb === 'tree') {
    const verbose = args.includes('--verbose');
    if (verbose) args.splice(args.indexOf('--verbose'), 1);
    exact(args, 0);
    value = await client.request('branch.tree');
    if (!json) { printBranchTree(value, { verbose }); return; }
  } else if (verb === 'show') {
    exact(args, 1);
    value = await client.request('branch.show', { branch: args[0] });
    if (!json) { printBranchShow(value); return; }
  } else if (verb === 'import') {
    exact(args, 0);
    value = await client.request('branch.import');
    if (!json) { printBranchImport(value); return; }
  } else if (verb === 'merge') {
    exact(args, 1);
    value = await client.request('branch.merge', { branch: args[0] });
  } else if (verb === 'sync') {
    exact(args, 1);
    value = await client.request('branch.sync', { branch: args[0] });
  } else if (verb === 'catchup') {
    exact(args, 1);
    value = await client.request('branch.catchup', { branch: args[0] });
  } else if (verb === 'merge-plan') {
    exact(args, 1);
    value = await client.request('branch.merge_plan', { branch: args[0] });
    if (!json) { printMergeAllPlan(value); return; }
  } else if (verb === 'merge-all') {
    exact(args, 1);
    value = await client.request('branch.merge_all', { branch: args[0] });
    if (!json) { printMergeAllResult(value); return; }
  } else if (verb === 'merge-cancel') {
    exact(args, 1);
    value = await client.request('branch.merge_cancel', { branch: args[0] });
    if (!json) { printMergeCancel(value); return; }
  } else if (verb === 'archive') {
    const discard = args.includes('--discard');
    if (discard) args.splice(args.indexOf('--discard'), 1);
    exact(args, 1);
    value = await client.request('branch.archive', { branch: args[0], discard });
    if (!json) { printBranchArchive(value); return; }
  } else if (verb === 'summary') {
    // 两种形式：`branch summary "一句话"` 写自己的分支；`branch summary BRANCH "一句话"` 点名分支（用户）。
    check(args.length === 1 || args.length === 2, 'usage: lush branch summary "一句话" | lush branch summary BRANCH "一句话"');
    const [summary, branch] = args.length === 2 ? [args[1], args[0]] : [args[0], null];
    value = await client.request('branch.summary', branch === null ? { summary } : { branch, summary });
    if (!json) { printBranchSummary(value); return; }
  } else {
    check(false, 'unknown branch command; use tree, show, import, merge, sync, catchup, merge-plan, merge-all, merge-cancel, archive or summary');
  }
  return value;
}
