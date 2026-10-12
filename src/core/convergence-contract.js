import { createHash } from 'node:crypto';
import { check } from './types.js';

/** Internal Runtime contract for W205. No RPC/CLI mutation is defined by this module. */
export const CONVERGENCE_LIMITS = Object.freeze({
  members: 8,
  preparation_concurrency: 4,
  validation_timeout_ms: 1200000,
  validation_output_bytes: 8388608,
  repair_attempts: 2,
  baseline_attempts: 3,
});

export const CONVERGENCE_STATES = Object.freeze([
  'preparing', 'resolving', 'awaiting', 'validating', 'ready', 'landing',
  'integrated', 'failed', 'blocked', 'withdrawn', 'stale',
]);
export const CONVERGENCE_COUNT_STATES = Object.freeze([
  'preparing', 'resolving', 'awaiting', 'validating', 'ready', 'landing', 'failed', 'blocked',
]);
export const CONVERGENCE_POLICY_PREFIX = 'branch_convergence:';

export function convergenceRevision(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function convergenceJSON(value, fallback = null) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

/** Missing mode is legacy command verification, never implicit permission to skip it. */
export function convergenceVerificationMode(mode, validation) {
  check(mode === undefined || mode === 'command' || mode === 'agent', 'invalid convergence verification mode');
  if (mode === 'agent') {
    check(validation === null || validation === 'null', 'agent convergence requires explicit validation:null');
    return 'agent';
  }
  const reference = convergenceJSON(validation, false);
  check(reference && typeof reference.command_id === 'string' && Number.isSafeInteger(reference.command_version)
    && reference.command_version > 0, 'legacy convergence requires a fixed validation command');
  return 'command';
}

export function convergenceBooking(task) {
  const booking = convergenceJSON(task?.reservation);
  return booking?.version === 3 && booking.kind === 'merge' ? booking : null;
}

/*
 * INTERNAL PARTITION CONTRACT (fixed before delegating implementation).
 * Public Project/API shapes remain docs/engineering/merge-convergence-implementation.md.
 *
 * Storage partition owns Store/schema and project/convergence-policy.js (default methods).
 * Parent Runtime owns Project registration and calls these Store methods:
 *   createDeliveryRun({parent_id,target_branch,baseline,validation,members,data?})
 *   deliveryRun(id)
 *   updateDeliveryRun(id, patch, expectedGeneration = null)
 *   deliveryRuns(parentId, states = null, limit = 50)
 *   deliveryMembers(runId, activeOnly = false)
 *   releaseDeliveryMembers(runId, taskId = null)
 *   createDeliveryNode({run_id,generation,node_key,state?,data,result?,helper_id?})
 *   deliveryNode(id)
 *   updateDeliveryNode(id, patch, expectedGeneration = null)
 *
 * Rows contain SQLite scalars, and JSON columns stay encoded like other Store rows.
 * Run columns: id,parent_id,target_branch,state,generation,baseline,candidate_commit,
 *   candidate_tree,validation,validation_result,landing_receipt,integration_worker_id,
 *   data,error,created_at,updated_at.
 * Member columns: run_id,task_id,delivery_id,enqueue_seq,source_branch,source_commit,
 *   base_commit,ordinal,active. Unique active task_id; (run_id,delivery_id) is identity.
 * Node columns: id,run_id,generation,node_key,state,data,result,helper_id,created_at,updated_at.
 * Unique (run_id,generation,node_key). All creation+claims are DB transactions.
 * createDeliveryRun takes 1..8 members with those member fields, assigns ordinal,
 * rejects any already-active task claim; caller transaction also updates reservations.
 * Update patches are strict column white lists, reject a stale generation, and return rows.
 * No Store method changes a source ref or fabricates integration/acceptance facts.
 *
 * Policy partition implements branchConvergence/List/setBranchConvergence and
 * branchConvergenceRuns. Parent Runtime provides retryBranchConvergence and
 * scheduleConvergence(parentId). Internal synchronous convergencePolicy(branch)
 * returns {version:1,enabled:false,validation:null,generation:0} when absent.
 * Run safe views read the columns above, members, and current helper/task metadata.
 * Revisions include actual policy/run identity; queries are read-only.
 *
 * Git partition owns ONLY new workspaces/delivery-objects.js, delivery-publish.js,
 * delivery-validation.js, plus workspaces/merge.js and task-sync.js receipt adaptation.
 * Parent Runtime registers the new Workspaces methods and supplies runtime guards:
 *   mergeConvergenceObjects({base=null,left,right,message,parents=null})
 *      -> {conflict,tree,commit,base,left,right,conflicts:[]}
 * Pure fixed-object work, no ref/index/worktree changes. On conflict, commit is an
 * immutable conflict-marker tree seed with both fixed inputs as parents; the helper
 * edits only its registered private worktree. For non-conflict, parents is respected.
 *   prepareConvergencePublishUnsafe({parent,baseline,tree,members,message,run_id,generation,commit=null})
 *      -> {parent,baseline,tree,commit,workspace,members,run_id,generation}
 * Members in receipt: {task_id,branch,source,delivery_id}. Commit is exact single-parent
 * baseline+tree; if supplied must be this exact object. This receipt does NOT assert
 * a member source tree equals the batch output. Caller owns Git exclusive queue.
 *   applyConvergencePublishUnsafe(receipt, synchronousGuard)
 *   verifyConvergencePublishUnsafe(receipt) -> boolean
 * Publishing locks/verifies every source ref and CAS-updates only the parent. Partial
 * checkout writes remain evidence; recovery proves exact object/target/checkout,
 * never repeats unknown effects. Caller persists receipt before any target mutation.
 *   createConvergenceValidationUnsafe({id,generation,commit}) -> checkout
 *      checkout = {id,generation,commit,path,ref}; persisted registration before Git.
 *   runConvergenceValidation(checkout, command, synchronousGuard, options={})
 *      -> safe command result (state/status/exit_code/reason/output_bytes flags), no output
 * Run in isolated registered checkout; no Git queue across Shell. Validate identities,
 * exact commit/cleanliness and authorization guard immediately before spawn and after.
 * Strip invocation/provider/Git override env as commandEnvironment does. Bounded timeout,
 * output and process-group cleanup. options supports test bounds and AbortSignal.
 *   removeConvergenceValidationUnsafe(checkout)
 * Remove only exact registered clean worktree/ref with compare-and-delete. No force/reset.
 *
 * Agent partition owns project/convergence-workers.js, scheduling.js, context.js,
 * workspaces/worktree.js, agent Prompt/provider guards as necessary, but NOT
 * lifecycle.js, branch-freeze.js, Store/schema, Project/Workspaces assembly or merge queue.
 * It provides:
 *   createConvergenceIntegration(runId,nodeId) -> helper Task
 *   convergenceIntegrationReady(task) -> boolean
 *   convergenceIntegrationContext(task) -> safe fixed context
 *   completeConvergenceIntegration(taskId, invocationRunId) -> result
 *   onConvergenceIntegrationExit(taskId)
 * Create only internally. Freeze inheritedRunProfile(parent), fork a new task_kind
 * integration worktree at node.data.seed_commit, target the true parent branch, record
 * immutable task Event convergence.integration_created with run/node/generation and
 * fixed input commitments. No ordinary child auto-merge or old merge identity.
 * Node.data fields include {base,left,right,seed_commit,member_ids,reason}; ordinary
 * invocationContext exposes fixed members safely, not full profiles/auth/command output.
 * Complete validates live run/node/generation/helper and both fixed inputs survive;
 * node.result becomes JSON {tree,commit,via:'integration'}, node.state ready.
 * Helper status awaiting_acceptance; it does NOT claim a member or the helper entered main.
 * Run becomes preparing; notify scheduleConvergence(parent_id) after actual exit.
 * Failed/waiting-question helpers mark run failed/awaiting and release preparation slots.
 * Stale generation cannot advance anything. Scheduler admission, ensure, completion,
 * cleanup and model prompt must recognize this type and never fall back to canonical cwd.
 * Parent Runtime handles cancellation/recovery/acceptance/shared-resource gates in
 * lifecycle.js and iteration.js after integrating the partition.
 *
 * Reservation protocol 3 retains source status requested/executing/resolving/blocked/
 * suspended/integrated for shared safety projection; its run/node state is separate.
 * Queued/preparing/validating/resolving v3 sources freeze only their own branch;
 * only actual applying/unknown parent effects freeze the parent. Parent Runtime
 * adapts shared freezes, input queue, lifecycle and old/new writer mutual exclusion.
 *
 * All partitions run complete专项/affected regression using temporary repos and mocks.
 * W205-1 runs Runtime cross-partition integration; final全量 belongs to top-level W205.
 */
