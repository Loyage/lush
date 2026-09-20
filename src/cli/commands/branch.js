import { check } from '../../core/types.js';
import { exact } from '../args.js';
import { printBranchTree, printBranchShow, printBranchImport, printBranchArchive } from '../print.js';

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
  } else if (verb === 'archive') {
    const discard = args.includes('--discard');
    if (discard) args.splice(args.indexOf('--discard'), 1);
    exact(args, 1);
    value = await client.request('branch.archive', { branch: args[0], discard });
    if (!json) { printBranchArchive(value); return; }
  } else {
    check(false, 'unknown branch command; use tree, show, import, merge, sync, catchup or archive');
  }
  return value;
}
