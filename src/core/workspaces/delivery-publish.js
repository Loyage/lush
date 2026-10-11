import fs from 'node:fs';
import { check, LushError } from '../types.js';
import { CONVERGENCE_LIMITS } from '../convergence-contract.js';
import { convergenceOID as oid } from './delivery-objects.js';

export function convergenceWriteGuard(guard) {
  check(typeof guard === 'function', 'convergence requires a synchronous guard');
  const result = guard();
  if (result && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw new LushError('convergence guard must be synchronous');
  }
  check(result !== false, 'convergence cancelled before write');
}

function credentials(value) {
  check(value && oid(value.baseline) && oid(value.tree) && oid(value.commit)
    && typeof value.parent === 'string' && value.parent
    && (value.workspace === null || (typeof value.workspace === 'string' && value.workspace))
    && Number.isSafeInteger(value.run_id) && value.run_id > 0
    && Number.isSafeInteger(value.generation) && value.generation > 0
    && Array.isArray(value.members) && value.members.length > 0 && value.members.length <= CONVERGENCE_LIMITS.members,
  'invalid convergence publish receipt');
  const members = value.members.map(member => {
    check(member && Number.isSafeInteger(member.task_id) && member.task_id > 0
      && Number.isSafeInteger(member.delivery_id) && member.delivery_id > 0
      && typeof member.branch === 'string' && member.branch && member.branch !== value.parent && oid(member.source),
    'invalid convergence publish member');
    return Object.freeze({ task_id: member.task_id, delivery_id: member.delivery_id, branch: member.branch, source: member.source });
  });
  for (const key of ['task_id', 'delivery_id', 'branch']) check(new Set(members.map(member => member[key])).size === members.length,
    'duplicate convergence publish member');
  let evidence = null;
  if (value.evidence !== null && value.evidence !== undefined) {
    check(value.evidence && oid(value.evidence.commit)
      && value.evidence.ref === `refs/lush/convergence-evidence/${value.run_id}/${value.generation}`,
    'invalid convergence evidence identity');
    evidence = Object.freeze({ ref: value.evidence.ref, commit: value.evidence.commit });
  }
  return Object.freeze({ parent: value.parent, baseline: value.baseline, tree: value.tree, commit: value.commit,
    workspace: value.workspace, members: Object.freeze(members), run_id: value.run_id, generation: value.generation,
    ...(evidence ? { evidence } : {}) });
}

async function objects(workspaces, receipt, members = receipt.members) {
  const project = workspaces.config.project;
  await workspaces.git(project, 'check-ref-format', `refs/heads/${receipt.parent}`);
  check(await workspaces.git(project, 'show', '--no-patch', '--format=%H %T %P', receipt.commit)
    === `${receipt.commit} ${receipt.tree} ${receipt.baseline}`, 'convergence receipt is not the exact single-parent commit and tree');
  for (const member of members) {
    await workspaces.git(project, 'check-ref-format', `refs/heads/${member.branch}`);
    check(await workspaces.git(project, 'rev-parse', '--verify', `${member.source}^{commit}`) === member.source,
      'convergence receipt source is not an exact commit');
  }
  if (receipt.evidence) {
    check(await workspaces.git(project, 'show', '--no-patch', '--format=%H %T', receipt.evidence.commit)
      === `${receipt.evidence.commit} ${receipt.tree}`, 'convergence evidence must match the exact commit and final tree');
    check(await workspaces.isAncestor(project, receipt.baseline, receipt.evidence.commit),
      'convergence evidence does not preserve its baseline');
    for (const member of receipt.members) check(await workspaces.isAncestor(project, member.source, receipt.evidence.commit),
      'convergence evidence does not preserve every fixed source');
  }
}

/** Never adopt or dereference an unknown private ref; only the fixed run/generation identity is legal. */
async function evidenceRef(workspaces, receipt, required = false) {
  if (!receipt.evidence) return null;
  const { ref, commit } = receipt.evidence;
  const symbolic = await workspaces.git(workspaces.config.project, 'symbolic-ref', '--quiet', ref).catch(() => null);
  check(!symbolic, 'convergence evidence ref must not be symbolic');
  const current = await workspaces.git(workspaces.config.project, 'rev-parse', '--verify', ref).catch(() => null);
  check(current === null || current === commit, 'convergence evidence ref moved');
  check(!required || current === commit, 'convergence evidence ref is missing');
  return current;
}

function owners(workspaces, receipt) {
  const parent = workspaces.store.get("SELECT id FROM tasks WHERE branch=? AND task_kind IN ('main','owner','order','say','child')", receipt.parent);
  check(parent, 'convergence target has no Worker owner');
  for (const member of receipt.members) {
    const task = workspaces.store.task(member.task_id), record = workspaces.store.branch(member.branch);
    check(task.parent_id === parent.id && task.branch === member.branch && task.target_branch === receipt.parent
      && ['order','say','child'].includes(task.task_kind) && record?.task_id === task.id
      && record.status === 'active' && record.parent_relation === 'recorded' && record.parent === receipt.parent,
    'convergence member no longer belongs to the exact direct parent');
  }
  return parent;
}

async function refsAndCheckout(workspaces, receipt) {
  owners(workspaces, receipt);
  const project = workspaces.config.project;
  check(await workspaces.git(project, 'rev-parse', '--verify', `refs/heads/${receipt.parent}^{commit}`) === receipt.baseline,
    'convergence parent moved');
  for (const member of receipt.members) {
    check(await workspaces.git(project, 'rev-parse', '--verify', `refs/heads/${member.branch}^{commit}`) === member.source,
      'convergence source moved');
    const task = workspaces.store.task(member.task_id);
    const sourceWorkspace = await workspaces.workspaceForBranch(member.branch);
    if (task.workspace) {
      check(sourceWorkspace && fs.realpathSync(sourceWorkspace) === fs.realpathSync(task.workspace),
        'convergence source worktree identity changed');
      check(await workspaces.git(sourceWorkspace, 'symbolic-ref', '--quiet', 'HEAD') === `refs/heads/${member.branch}`
        && await workspaces.git(sourceWorkspace, 'rev-parse', 'HEAD') === member.source, 'convergence source checkout moved');
    } else check(sourceWorkspace === null, 'convergence source acquired an unregistered worktree');
    const state = await workspaces.branchState(member.branch);
    check(state.blockers.every(blocker => blocker === `task:#${member.task_id}`), 'unintegrated descendants block convergence publication');
  }
  check(await workspaces.workspaceForBranch(receipt.parent) === receipt.workspace, 'convergence parent worktree changed');
  await workspaces.assertCleanBranches([receipt.parent, ...receipt.members.map(member => member.branch)]);
  if (receipt.workspace) {
    await workspaces.clean(receipt.workspace);
    check(await workspaces.git(receipt.workspace, 'symbolic-ref', '--quiet', 'HEAD') === `refs/heads/${receipt.parent}`
      && await workspaces.git(receipt.workspace, 'rev-parse', 'HEAD') === receipt.baseline, 'convergence parent checkout moved');
  }
}

/** Lock sources, target and optional keeper before read-tree; atomically publish target plus evidence only. */
async function transaction(workspaces, receipt, guard, action) {
  const keeper = await evidenceRef(workspaces, receipt);
  const evidenceCommand = receipt.evidence ? `option no-deref\n${keeper === null ? 'create' : 'verify'} ${receipt.evidence.ref} ${receipt.evidence.commit}\n` : '';
  const proc = Bun.spawn(['git', '-C', workspaces.config.project, '-c', 'core.hooksPath=/dev/null',
    'update-ref', '-m', 'Lush convergence squash', '--stdin'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...workspaces.config.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const errors = new Response(proc.stderr).text(), reader = proc.stdout.getReader();
  let output = '', committed = false;
  const response = async expected => {
    while (!output.includes(expected)) {
      const chunk = await reader.read();
      if (chunk.done) { await errors; throw new LushError('convergence refs moved or locked'); }
      output += new TextDecoder().decode(chunk.value);
    }
  };
  try {
    proc.stdin.write(`start\n${receipt.members.map(member => `verify refs/heads/${member.branch} ${member.source}\n`).join('')}`
      + `update refs/heads/${receipt.parent} ${receipt.commit} ${receipt.baseline}\n${evidenceCommand}prepare\n`);
    await proc.stdin.flush(); await response('prepare: ok\n');
    await action(); convergenceWriteGuard(guard);
    proc.stdin.write('commit\n'); await proc.stdin.flush(); await response('commit: ok\n'); committed = true;
  } finally {
    try { if (!committed) proc.stdin.write('abort\n'); proc.stdin.end(); } catch { /* Git rejected the transaction. */ }
    while (!(await reader.read()).done) { /* release the serial gate only after protocol exit */ }
    await proc.exited; await errors;
  }
}

/** Infrastructure consumers prove the exact shared object/keeper without impersonating a source member. */
export async function assertConvergenceEvidenceObjects(workspaces, value) {
  const receipt = credentials(value);
  await objects(workspaces, receipt);
  await evidenceRef(workspaces, receipt, true);
  return receipt;
}

/** Exact multi-source provenance, not an equivalent-tree or patch-id inference. */
export function convergenceMemberReceipt(workspaces, task, event) {
  check(event?.convergence === true && Number.isSafeInteger(event.run_id) && event.run_id > 0
    && Number.isSafeInteger(event.generation) && event.generation > 0 && event.parent_id === task.parent_id
    && oid(event.source_commit) && oid(event.commit) && oid(event.tree), 'invalid convergence member receipt');
  const run = workspaces.store.get('SELECT parent_id,target_branch,state,generation,landing_receipt FROM delivery_runs WHERE id=?', event.run_id);
  check(run && run.parent_id === task.parent_id && run.target_branch === task.target_branch
    && run.state === 'integrated' && run.generation === event.generation, 'convergence member run is not settled');
  let receipt;
  try { receipt = credentials(JSON.parse(run.landing_receipt)); } catch { throw new LushError('convergence landing receipt is missing or invalid'); }
  check(receipt.run_id === event.run_id && receipt.generation === event.generation && receipt.parent === task.target_branch
    && receipt.commit === event.commit && receipt.tree === event.tree
    && receipt.members.some(member => member.task_id === task.id && member.branch === task.branch && member.source === event.source_commit),
  'convergence event does not match the exact member mapping');
  const record = workspaces.store.branch(task.branch);
  const parent = workspaces.store.get('SELECT branch FROM tasks WHERE id=?', task.parent_id);
  check(record?.task_id === task.id && record.parent === receipt.parent && record.parent_relation === 'recorded'
    && parent?.branch === receipt.parent, 'convergence member direct parent changed');
  return receipt;
}

/** Live delivery operations additionally verify the retained Git objects and evidence ref. */
export async function assertConvergenceMemberReceipt(workspaces, task, event) {
  const receipt = convergenceMemberReceipt(workspaces, task, event);
  // Another independently accepted member may no longer have a source ref/object.
  // This member needs its own source and the immutable exact shared landing identity.
  await objects(workspaces, receipt, receipt.members.filter(member => member.task_id === task.id));
  await evidenceRef(workspaces, receipt, true);
  return receipt;
}

export const methods = {
  async prepareConvergencePublishUnsafe({ parent, baseline, tree, members, message, run_id, generation, commit = null, evidence = null }) {
    parent = typeof parent === 'string' ? parent : parent?.branch;
    check(oid(baseline) && oid(tree) && typeof message === 'string' && message.trim() && message.length <= 65536,
      'convergence publication requires fixed objects and a bounded message');
    check(Array.isArray(members), 'convergence publication requires members');
    const normalized = members.map(member => ({ task_id: member.task_id, delivery_id: member.delivery_id,
      branch: member.source_branch ?? member.branch, source: member.source_commit ?? member.source }));
    // Validate the full structure before creating any objects, even if the caller supplies a commit.
    const provisional = credentials({ parent, baseline, tree, members: normalized, run_id, generation, evidence,
      workspace: null, commit: commit ?? baseline });
    const workspace = await this.workspaceForBranch(parent);
    await refsAndCheckout(this, { ...provisional, workspace });
    if (!commit) commit = await this.git(this.config.project, '-c', 'user.name=Lush', '-c', 'user.email=lush@localhost',
      'commit-tree', tree, '-p', baseline, '-m', message);
    const receipt = credentials({ ...provisional, workspace, commit });
    await objects(this, receipt); await evidenceRef(this, receipt);
    return receipt;
  },

  async applyConvergencePublishUnsafe(value, guard) {
    const receipt = credentials(value);
    check(typeof guard === 'function', 'convergence publication requires a synchronous guard');
    await objects(this, receipt); await refsAndCheckout(this, receipt);
    await this.trackRefWrite(`refs/heads/${receipt.parent}`, () => transaction(this, receipt, guard, async () => {
      await refsAndCheckout(this, receipt); convergenceWriteGuard(guard);
      if (receipt.workspace) {
        await this.git(receipt.workspace, 'read-tree', '-m', '-u', receipt.baseline, receipt.commit);
        check(await this.git(receipt.workspace, 'write-tree') === receipt.tree, 'convergence checkout staged another tree');
        await this.git(receipt.workspace, 'diff-files', '--quiet', '--ignore-submodules=none');
        check(!await this.git(receipt.workspace, 'ls-files', '--others', '--exclude-standard', '--', '.', ':(exclude).lush'),
          'convergence target became dirty during publication');
        check(await this.git(receipt.workspace, 'symbolic-ref', '--quiet', 'HEAD') === `refs/heads/${receipt.parent}`,
          'convergence target checkout moved during publication');
      }
      owners(this, receipt);
      await this.assertCleanBranches(receipt.members.map(member => member.branch));
    }), { before: receipt.baseline, after: receipt.commit });
    check(await this.verifyConvergencePublishUnsafe(receipt), 'convergence publication needs inspection; exact receipt/checkout not proven');
    return receipt;
  },

  /** Read-only recovery proof. Never retries a checkout or ref mutation. */
  async verifyConvergencePublishUnsafe(value) {
    try {
      const receipt = credentials(value); await objects(this, receipt); owners(this, receipt);
      const project = this.config.project;
      for (const member of receipt.members) check(await this.git(project, 'rev-parse', '--verify', `refs/heads/${member.branch}^{commit}`) === member.source,
        'convergence recovery source moved');
      await this.assertCleanBranches(receipt.members.map(member => member.branch));
      const head = await this.git(project, 'rev-parse', '--verify', `refs/heads/${receipt.parent}^{commit}`);
      check(await this.isAncestor(project, receipt.commit, head), 'exact convergence commit is not on target');
      check(await this.workspaceForBranch(receipt.parent) === receipt.workspace, 'convergence target worktree changed');
      await this.assertCleanBranches([receipt.parent]);
      if (receipt.workspace) {
        await this.clean(receipt.workspace);
        check(await this.git(receipt.workspace, 'symbolic-ref', '--quiet', 'HEAD') === `refs/heads/${receipt.parent}`
          && await this.git(receipt.workspace, 'rev-parse', 'HEAD') === head, 'convergence target checkout changed');
      }
      await evidenceRef(this, receipt, true);
      check(await this.git(project, 'rev-parse', '--verify', `refs/heads/${receipt.parent}^{commit}`) === head,
        'convergence target moved during verification');
      return true;
    } catch { return false; }
  },
};
