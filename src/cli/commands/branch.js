import { check } from '../../core/types.js';
import { exact, option } from '../args.js';
import { takeOptions } from '../command-options.js';
import { printBranchTree, printBranchShow, printBranchArchive } from '../print.js';

/** branch：分支谱系（谁从谁创建出来），与 Worker 树、commit graph 都是不同维度。 */
export async function run(command, args, ctx) {
  const { client, json } = ctx;
  let value;
  const verb = args.shift();
  if (['history','versions'].includes(verb)) {
    const params = takeOptions(args, verb === 'versions' ? { cursor: 'string', limit: 'number', delivery: 'number' } : { cursor: 'string', limit: 'number' }); exact(args, 0);
    return client.request(verb === 'versions' ? 'branch.version_graph' : 'branch.history', params);
  }
  if (verb === 'graph') { exact(args, 0); return client.request('graph.get'); }
  if (verb === 'merge-all') { exact(args, 1); return client.request('worker.reserve_all', { branch: convergenceBranch(args[0]) }); }
  if (verb === 'legacy-convergence') return runConvergence(args, client);
  if (verb === 'integrate') return runIntegrate(args, client);
  check(['tree','show','bind','archive'].includes(verb), 'unknown branch command; run lush help branch');
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
  } else if (verb === 'bind') {
    exact(args, 2);
    value = await client.request('branch.bind', { branch: args[0], commit: args[1] });
  } else if (verb === 'archive') {
    const discard = args.includes('--discard');
    if (discard) args.splice(args.indexOf('--discard'), 1);
    // G-04 续办：根已归档但子树里还有未完成的后代时，显式继续剩余部分。
    const continuing = args.includes('--continue');
    if (continuing) args.splice(args.indexOf('--continue'), 1);
    exact(args, 1);
    value = await client.request('branch.archive', { branch: args[0], discard, continue: continuing });
    if (!json) { printBranchArchive(value); return; }
  }
  return value;
}

async function runIntegrate(args, client) {
  check(!client.token || client.management, 'branch integrate requires user or trusted management identity');
  const verb = args.shift();
  check(['preview','start','show','cancel','retry'].includes(verb), 'branch integrate requires preview|start|show|cancel|retry');
  const writes = ['start','cancel','retry'].includes(verb);
  const expected_revision = writes ? readConvergenceRevision(args, 'branch integrate preview/show') : null;
  exact(args, 1);
  if (verb === 'preview' || verb === 'start') {
    const branch = convergenceBranch(args[0]);
    return client.request(verb === 'preview' ? 'branch.integrate_plan' : 'branch.integrate_start', writes ? { branch, expected_revision } : { branch });
  }
  const id = convergenceNumber(args[0], 'integration id');
  return client.request(verb === 'show' ? 'branch.integration' : `branch.integrate_${verb}`,
    writes ? { id, expected_revision } : { id });
}

function readConvergenceRevision(args, source = 'branch legacy-convergence show/history') {
  const revision = option(args, '--revision');
  check(typeof revision === 'string' && revision.length > 0 && revision.length <= 256
    && revision === revision.trim() && !/[\x00-\x1f\x7f]/.test(revision),
  `first read ${source}, then provide --revision REV`);
  return revision;
}
function convergenceBranch(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim()
    && !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{')
    && !value.includes('//') && !value.startsWith('/') && !value.startsWith('-') && !value.startsWith('refs/')
    && !value.endsWith('/') && !value.endsWith('.') && value !== '@'
    && !/^[0-9a-f]{40,64}$/i.test(value)
    && value.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock')),
  'branch must be an exact local branch name, not a ref expression');
  return value;
}
function convergenceNumber(value, label, max = Number.MAX_SAFE_INTEGER) {
  check(typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
    && Number(value) <= max, `${label} must be a positive integer${max === 50 ? ' up to 50' : ''}`);
  return Number(value);
}
async function runConvergence(args, client) {
  check(!client.token || client.management, 'branch legacy-convergence requires user or trusted management identity');
  const verb = args.shift();
  check(['list','show','defaults','history','retry'].includes(verb), 'branch legacy-convergence requires list|show|defaults|history|retry; retired writes are unavailable');
  if (verb === 'defaults') { exact(args, 0); return client.request('branch.convergence_defaults'); }
  if (verb === 'list') { exact(args, 0); return client.request('branch.convergence_list'); }
  if (verb === 'show') { exact(args, 1); return client.request('branch.convergence', { branch: convergenceBranch(args[0]) }); }
  if (verb === 'history') {
    const before = option(args, '--before'), limit = option(args, '--limit'); exact(args, 1);
    const params = { branch: convergenceBranch(args[0]) };
    if (before !== null) params.before = convergenceNumber(before, 'before');
    if (limit !== null) params.limit = convergenceNumber(limit, 'limit', 50);
    return client.request('branch.convergence_runs', params);
  }
  const expected_revision = readConvergenceRevision(args); exact(args, 1);
  return client.request('branch.convergence_retry', { id: convergenceNumber(args[0], 'run id'), expected_revision });
}
