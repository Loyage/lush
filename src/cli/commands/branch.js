import { check } from '../../core/types.js';
import { exact, option } from '../args.js';
import { printBranchTree, printBranchShow, printBranchImport, printBranchArchive, printBranchSummary, printMergeAllPlan, printMergeAllResult, printMergeCancel, printOrchestratePlan, printOrchestrateResult, printOrchestrateCancel } from '../print.js';

/** branch：分支谱系（谁从谁创建出来），与 Worker 树、commit graph 都是不同维度。 */
export async function run(command, args, ctx) {
  const { client, json } = ctx;
  let value;
  const verb = args.shift();
  if (verb === 'convergence') return runConvergence(args, client);
  check(['tree','show','bind','archive'].includes(verb), 'unknown branch command; use tree, show, bind, archive or convergence');
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
  } else if (verb === 'bind') {
    exact(args, 2);
    value = await client.request('branch.bind', { branch: args[0], commit: args[1] });
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
  } else if (verb === 'orchestrate-plan') {
    exact(args, 1);
    value = await client.request('branch.orchestrate_plan', { branch: args[0] });
    if (!json) { printOrchestratePlan(value); return; }
  } else if (verb === 'orchestrate') {
    exact(args, 1);
    value = await client.request('branch.orchestrate', { branch: args[0] });
    if (!json) { printOrchestrateResult(value); return; }
  } else if (verb === 'orchestrate-cancel') {
    exact(args, 1);
    value = await client.request('branch.orchestrate_cancel', { branch: args[0] });
    if (!json) { printOrchestrateCancel(value); return; }
  } else if (verb === 'archive') {
    const discard = args.includes('--discard');
    if (discard) args.splice(args.indexOf('--discard'), 1);
    // G-04 续办：根已归档但子树里还有未完成的后代时，显式继续剩余部分。
    const continuing = args.includes('--continue');
    if (continuing) args.splice(args.indexOf('--continue'), 1);
    exact(args, 1);
    value = await client.request('branch.archive', { branch: args[0], discard, continue: continuing });
    if (!json) { printBranchArchive(value); return; }
  } else if (verb === 'summary') {
    // 两种形式：`branch summary "一句话"` 写自己的分支；`branch summary BRANCH "一句话"` 点名分支（用户）。
    check(args.length === 1 || args.length === 2, 'usage: lush branch summary "一句话" | lush branch summary BRANCH "一句话"');
    const [summary, branch] = args.length === 2 ? [args[1], args[0]] : [args[0], null];
    value = await client.request('branch.summary', branch === null ? { summary } : { branch, summary });
    if (!json) { printBranchSummary(value); return; }
  } else {
    check(false, 'unknown branch command; use tree, show, import, bind, merge, sync, catchup, merge-plan, merge-all, merge-cancel, orchestrate-plan, orchestrate, orchestrate-cancel, archive or summary');
  }
  return value;
}

function readConvergenceRevision(args) {
  const revision = option(args, '--revision');
  check(typeof revision === 'string' && revision.length > 0 && revision.length <= 256
    && revision === revision.trim() && !/[\x00-\x1f\x7f]/.test(revision),
  'first read branch convergence show/runs, then provide --revision REV');
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
function commandId(value) {
  check(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value), 'invalid command id');
  return value;
}
async function runConvergence(args, client) {
  check(!client.token, 'branch convergence is user only, not an agent operation');
  const verb = args.shift();
  check(['list','show','on','off','mount','remove','defaults','runs','retry'].includes(verb), 'branch convergence requires list|show|on|off|mount|remove|defaults|runs|retry; run lush help');
  if (verb === 'defaults') {
    const action = args.shift();
    if (action === 'show') { exact(args, 0); return client.request('branch.convergence_defaults'); }
    check(action === 'set', 'branch convergence defaults requires show|set');
    const expected_revision = readConvergenceRevision(args);
    const mounted = option(args, '--mounted'), enabled = option(args, '--enabled'); exact(args, 0);
    check(['true','false'].includes(mounted) && ['true','false'].includes(enabled), '--mounted and --enabled must be true|false');
    return client.request('branch.convergence_defaults_set', { mounted: mounted === 'true', enabled: enabled === 'true', expected_revision });
  }
  if (verb === 'list') { exact(args, 0); return client.request('branch.convergence_list'); }
  if (verb === 'show') { exact(args, 1); return client.request('branch.convergence', { branch: convergenceBranch(args[0]) }); }
  if (verb === 'runs') {
    const before = option(args, '--before'), limit = option(args, '--limit'); exact(args, 1);
    const params = { branch: convergenceBranch(args[0]) };
    if (before !== null) params.before = convergenceNumber(before, 'before');
    if (limit !== null) params.limit = convergenceNumber(limit, 'limit', 50);
    return client.request('branch.convergence_runs', params);
  }
  const expected_revision = readConvergenceRevision(args);
  if (verb === 'retry') {
    exact(args, 1);
    return client.request('branch.convergence_retry', { id: convergenceNumber(args[0], 'run id'), expected_revision });
  }
  if (verb === 'on') {
    const command = option(args, '--command'), version = option(args, '--version'); exact(args, 1);
    check((command === null) === (version === null), 'provide both --command and --version for a legacy reference');
    return client.request('branch.convergence_set', { branch: convergenceBranch(args[0]), enabled: true,
      ...(command === null ? {} : { validation: { command_id: commandId(command), command_version: convergenceNumber(version, 'command version') } }), expected_revision });
  }
  exact(args, 1);
  const branch = convergenceBranch(args[0]);
  if (verb === 'remove')
    return client.request('branch.convergence_set', { branch, mounted: false, enabled: false, expected_revision });
  const current = await client.request('branch.convergence', { branch });
  check(current?.branch === branch && current.revision === expected_revision, 'branch convergence revision changed; reload before editing');
  if (verb === 'mount')
    return client.request('branch.convergence_set', { branch, mounted: true, enabled: current.enabled === true, expected_revision });
  check(current.validation === null || current.validation && typeof current.validation === 'object', 'invalid branch convergence validation read');
  const validation = current.validation === null ? null : {
    command_id: commandId(current.validation.command_id),
    command_version: convergenceNumber(String(current.validation.command_version), 'command version'),
  };
  return client.request('branch.convergence_set', { branch, enabled: false, validation, expected_revision,
    ...(typeof current.mounted === 'boolean' ? { mounted: current.mounted } : {}) });
}
