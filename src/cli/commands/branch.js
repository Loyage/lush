import { check } from '../../core/types.js';
import { exact } from '../args.js';
import { printBranchTree, printBranchShow } from '../print.js';

/** Branch lineage and ordinary serial merge requests, not integration workflows. */
export async function run(command, args, { client, json }) {
  check(command === 'branch', 'unknown branch command');
  const verb = args.shift();
  if (verb === 'merge-all') {
    exact(args, 1);
    return client.request('worker.reserve_all', { branch: localBranch(args[0]) });
  }
  check(['tree','show'].includes(verb), 'unknown branch command; run lush help branch');
  if (verb === 'tree') {
    const verbose = args.includes('--verbose');
    if (verbose) args.splice(args.indexOf('--verbose'), 1);
    exact(args, 0);
    const value = await client.request('branch.tree');
    if (!json) { printBranchTree(value, { verbose }); return; }
    return value;
  }
  exact(args, 1);
  const value = await client.request('branch.show', { branch: args[0] });
  if (!json) { printBranchShow(value); return; }
  return value;
}

function localBranch(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim()
    && !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{')
    && !value.includes('//') && !value.startsWith('/') && !value.startsWith('-') && !value.startsWith('refs/')
    && !value.endsWith('/') && !value.endsWith('.') && value !== '@'
    && !/^[0-9a-f]{40,64}$/i.test(value)
    && value.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock')),
  'branch must be an exact local branch name, not a ref expression');
  return value;
}
