import fs from 'node:fs';
import { acceptManagementWorker } from './management-acceptance.js';
import { managementAcceptanceFacts } from './management-data.js';
import { assertLocalWorker } from './execution-retired.js';
import { forceAcceptanceScope, assertForceAcceptanceMessages } from './acceptance-force.js';
import { assertManagementCodeExecution } from './management-code.js';
import { check, id, TERMINAL } from '../types.js';
import { workerLabel } from '../worker-number.js';
import { descendantsOf } from '../genealogy.js';
import { convergenceResourceReason, convergenceHelperDeliveryState } from '../convergence-resources.js';
import { assertConvergenceMemberReceipt } from '../workspaces/delivery-publish.js';

const bookingOf = task => task.reservation ? JSON.parse(task.reservation) : null;

/** A completed runtime queue has no Agent inbox. Keep its settled sources' diagnostics as history. */
function acceptanceUnreadMessage(project, task, acceptingIds = new Set(), skippedIds = []) {
  const idleQueue = task.task_kind === 'merge' && task.name === 'merge'
    && task.status === 'completed' && !task.branch;
  return project.store.get(`SELECT m.id FROM messages m WHERE m.task_id=? AND m.consumed=0
    AND m.id NOT IN (SELECT value FROM json_each(?))
    AND NOT (? AND m.sender_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM tasks source WHERE source.id=m.sender_id
        AND (source.status IN ('completed','failed','cancelled')
          OR (source.status='awaiting_acceptance' AND source.id IN (SELECT value FROM json_each(?)))))
      AND EXISTS (SELECT 1 FROM events e WHERE e.task_id=m.sender_id
        AND e.type='task.reparented_for_merge'
        AND json_extract(e.data,'$.to')=? AND json_extract(e.data,'$.from')=?))
    ORDER BY m.id LIMIT 1`, task.id, JSON.stringify(skippedIds), idleQueue ? 1 : 0, idleQueue ? JSON.stringify([...acceptingIds]) : '[]', task.id, task.parent_id);
}

export function assertTaskNotSyncing(project, taskId) {
  assertLocalWorker(project, taskId);
  check(!project.workerDeleteIds?.has(taskId), 'Worker deletion is in progress; wait for cleanup');
  check(!project.taskSyncBusy?.has(taskId), 'Worker parent sync is in flight; wait for its safe point');
}

/** Resource mutations must not overtake accepted Shell work. Inbox/resume may still queue input. */
export function assertTaskNoCommand(project, taskId) {
  check(!project.commandHookRunning?.has(taskId), 'Worker shortcut command is pending or running; wait for its safe point');
  const task = project.store.task(taskId);
  if (task.task_kind === 'integration') { const reason = convergenceResourceReason(project, task); check(!reason, reason); }
}

/** Explicit parent sync is not delivery approval. Persist the pause in existing audit facts. */
export function taskSyncDeliveryPaused(project, taskId) {
  const hold = project.store.get(`SELECT max(id) AS id FROM events WHERE task_id=?
    AND type IN ('task.parent_synced','task.sync_resolution_requested')`, taskId)?.id ?? 0;
  const resumed = project.store.get("SELECT max(id) AS id FROM events WHERE task_id=? AND type='task.delivery_resumed'", taskId)?.id ?? 0;
  return hold > resumed;
}

export function resumeTaskDelivery(project, taskId, reason) {
  if (taskSyncDeliveryPaused(project, taskId)) project.store.event(taskId, 'task.delivery_resumed', { reason });
}

/** Accepted/cancelled ancestors must never acquire active descendants again. */
export function assertTaskAncestorsOpen(project, task) {
  assertLocalWorker(project, task.id);
  const seen = new Set([task.id]);
  let parentId = bookingOf(task)?.parent_id ?? task.parent_id;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    // This gate is also used by safe inbox read projections; no runtime profile is needed.
    const parent = project.store.get('SELECT id,worker_number,parent_id,task_kind,status FROM tasks WHERE id=?', parentId);
    check(parent, `task #${parentId} not found`);
    assertLocalWorker(project, parent.id);
    // A reusable runtime queue can be idle; its original parent is the actual owner.
    check(parent.task_kind === 'merge' || !TERMINAL.has(parent.status),
      `parent has ended (ancestor Worker ${workerLabel(parent)}); reopen or retry the ancestor first`);
    parentId = parent.parent_id;
  }
}

/** Receipts live in Events, not in the single mutable reservation slot. */
export function consumeIntegratedReservation(project, task, reason) {
  const previous = bookingOf(task);
  if (previous?.status !== 'integrated' && !(['order','child'].includes(task.task_kind)
    && task.status === 'awaiting_acceptance' && !previous)) return false;
  const settings = task.auto_merge ? JSON.parse(task.auto_merge) : null;
  const automatic = settings ? settings.enabled === true : task.task_kind === 'child';
  project.store.update(task.id, { reservation: automatic
    ? JSON.stringify({ version: 2, kind: 'merge', status: 'pending',
      ...(settings?.enabled ? { auto_merge: true } : {}), created_at: new Date().toISOString() }) : null });
  project.store.event(task.id, 'task.iteration_started', { reason, previous_reservation: previous });
  return true;
}

/** Read fixed-commit delivery evidence; mutation-sensitive callers hold the Git lock. */
export async function taskDeliveryState(project, task) {
  if (task.task_kind === 'integration') return convergenceHelperDeliveryState(project, task);
  const head = task.head_commit;
  check(head && task.branch && task.target_branch, 'Worker has no inspectable delivery branch');
  const parent = await project.workspaces.git(project.config.project, 'rev-parse', '--verify', `refs/heads/${task.target_branch}^{commit}`);
  const event = project.store.get("SELECT data FROM events WHERE task_id=? AND type='task.merge_integrated' ORDER BY id DESC LIMIT 1", task.id);
  const receipt = event ? JSON.parse(event.data) : bookingOf(task);
  if (receipt?.convergence === true) {
    try { await assertConvergenceMemberReceipt(project.workspaces, task, receipt); }
    catch { return 'pending'; } // Lost/drifted batch evidence is not a delivered source, even with an equivalent tree.
  } else if (bookingOf(task)?.version === 3 && bookingOf(task)?.status === 'integrated') return 'pending';
  const source = receipt?.source_commit ?? receipt?.commit;
  const landed = receipt?.source_commit ? receipt.commit : receipt?.landed_commit;
  const landedSurvives = landed && await project.workspaces.isAncestor(project.config.project, landed, parent);
  if (source === head && landedSurvives) return 'merged';
  if (!task.iteration_base_commit && head === task.base_commit) return 'none';
  if (await project.workspaces.isAncestor(project.config.project, head, parent)) return 'merged';
  const base = task.iteration_base_commit ?? task.base_commit;
  if (base) {
    const tree = await project.workspaces.git(project.config.project, 'rev-parse', `${head}^{tree}`);
    const baseTree = await project.workspaces.git(project.config.project, 'rev-parse', `${base}^{tree}`);
    if (tree === baseTree) {
      if (!task.iteration_base_commit) return 'none';
      if (await project.workspaces.isAncestor(project.config.project, base, parent)) return 'merged';
      if (landedSurvives && source
        && tree === await project.workspaces.git(project.config.project, 'rev-parse', `${source}^{tree}`)) return 'merged';
      // The target lost its delivery/sync baseline; equal local trees are not proof of landing.
      return 'pending';
    }
  }
  return 'pending';
}

/** Shared bounded read projection. One query per 200 Tasks, indexed latest-event seeks each. */
export function iterationViews(store, tasks) {
  const result = new Map(tasks.map(task => [task.id, { accepted: false, parent_sync_conflict: null, acceptance_recovery: false }]));
  for (let offset = 0; offset < tasks.length; offset += 200) {
    const batch = tasks.slice(offset, offset + 200);
    const latest = new Map();
    const rows = store.all(`WITH targets(task_id) AS (VALUES ${batch.map(() => '(?)').join(',')}),
      kinds(type) AS (VALUES ('task.accepted'),('task.reopened'),('task.parent_sync_conflict'),('task.parent_synced'),
        ('task.acceptance_started'),('task.acceptance_reclaimed'),('task.iteration_started'),('retry'))
      SELECT targets.task_id,kinds.type,e.id,e.data,current.status AS current_status,current.task_kind AS current_kind,
        current.branch AS current_branch,current.head_commit AS current_head_commit
      FROM targets JOIN tasks current ON current.id=targets.task_id CROSS JOIN kinds JOIN events e ON e.id=(
        SELECT id FROM events INDEXED BY events_task_type_id
        WHERE task_id=targets.task_id AND type=kinds.type ORDER BY id DESC LIMIT 1
      )`, ...batch.map(task => task.id));
    for (const row of rows) {
      const events = latest.get(row.task_id) ?? {};
      events[row.type] = row; latest.set(row.task_id, events);
    }
    for (const task of batch) {
      const events = latest.get(task.id) ?? {};
      const accepted = task.status === 'completed' && (events['task.accepted']?.id ?? 0) > (events['task.reopened']?.id ?? 0);
      let conflict = null;
      const diagnostic = events['task.parent_sync_conflict'];
      if (diagnostic && diagnostic.id > (events['task.parent_synced']?.id ?? 0)) {
        let data = {};
        try { data = JSON.parse(diagnostic.data) ?? {}; } catch { /* Preserve a visible invalid diagnostic. */ }
        conflict = {
          source_commit: typeof data.source_commit === 'string' ? data.source_commit.slice(0, 128) : null,
          parent_commit: typeof data.parent_commit === 'string' ? data.parent_commit.slice(0, 128) : null,
          reason: typeof data.reason === 'string' ? data.reason.slice(0, 4000) : '父分支同步冲突诊断需检查',
        };
      }
      // The fixed unfinished receipt is the only recovery affordance. Missing paths
      // or an archived root are not evidence, and completed side effects supersede it.
      const start = events['task.acceptance_started'];
      const boundary = Math.max(...['task.accepted', 'task.acceptance_reclaimed', 'task.reopened', 'task.iteration_started', 'retry']
        .map(type => events[type]?.id ?? 0));
      let recovery = false;
      if (start && start.id > boundary && ['order', 'say', 'child'].includes(start.current_kind)
        && ['waiting', 'awaiting_acceptance', 'completed'].includes(start.current_status)) {
        try {
          const receipt = JSON.parse(start.data);
          recovery = typeof start.current_head_commit === 'string' && receipt?.head_commit === start.current_head_commit
            && receipt.tips?.[start.current_branch] === start.current_head_commit
            && Array.isArray(receipt.branches) && receipt.branches.includes(start.current_branch)
            && Array.isArray(receipt.task_ids) && receipt.task_ids.includes(task.id);
        } catch { /* Corrupt history cannot authorize a recovery action. */ }
      }
      result.set(task.id, task.task_kind === 'management'
        ? { ...managementAcceptanceFacts(store, task, events), parent_sync_conflict: null }
        : { accepted, parent_sync_conflict: conflict, acceptance_recovery: recovery });
    }
  }
  return result;
}

/** Only uninterrupted child delegation chains participate; independent orders need their own acceptance. */
function acceptanceChildren(rows, rootId) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const delegated = row => {
    const seen = new Set();
    while (row.id !== rootId) {
      if (row.task_kind !== 'child' || seen.has(row.id)) return false;
      seen.add(row.id); row = byId.get(row.parent_id);
      if (!row) return false;
    }
    return true;
  };
  return rows.filter(row => row.id !== rootId && row.status === 'awaiting_acceptance' && delegated(row));
}

/** A partial parent batch must be resumed at its root, never split into child acceptances. */
export function assertNoPartialParentAcceptance(project, taskId) {
  const partial = project.store.get(`WITH RECURSIVE ancestors(id,parent_id) AS (
    SELECT id,parent_id FROM tasks WHERE id=?
    UNION SELECT t.id,t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.parent_id
  ) SELECT e.task_id FROM ancestors a JOIN events e ON e.task_id=a.id AND e.type='task.acceptance_started'
    WHERE e.task_id<>?
    AND EXISTS (SELECT 1 FROM json_each(e.data,'$.accepting_task_ids') participant WHERE participant.value=?)
    AND NOT EXISTS (SELECT 1 FROM events settled WHERE settled.task_id=e.task_id AND settled.id>e.id
      AND settled.type IN ('task.accepted','task.acceptance_reclaimed','task.iteration_started','task.reopened','retry'))
    AND (EXISTS (SELECT 1 FROM events receipt,json_each(receipt.data,'$.outcomes') outcome
      WHERE receipt.task_id=e.task_id AND receipt.type IN ('branch.archive','branch.archive.outcome')
      AND json_extract(receipt.data,'$.acceptance_execution')=e.id
      AND (json_extract(outcome.value,'$.worktree')='removed' OR json_extract(outcome.value,'$.ref')='deleted'))
      )
    ORDER BY e.id DESC LIMIT 1`, taskId, taskId, taskId);
  check(!partial, `partial parent acceptance must resume at its root Worker ${partial ? workerLabel(project.store.task(partial.task_id)) : ''}`);
}

const acceptanceIdentity = row => ({ id: row.id, parent_id: row.parent_id, task_kind: row.task_kind,
  status: row.status, branch: row.branch, target_branch: row.target_branch });
const sameIdentity = (row, fixed) => Object.entries(fixed).every(([key, value]) => row[key] === value);

export default {
  /** Acceptance authorizes clean resource reclamation; historical records remain readable. */
  async acceptTask(taskId, actor = null, options = {}) {
    return this.dispatchAutomationOperation('accept_worker', taskId, { actor, options });
  },

  async acceptWorkerOperation(taskId, actor = null, options = {}) {
    this.assertWritable('accept a worker');
    if (this.store.task(id(taskId)).task_kind === 'management') return acceptManagementWorker(this, id(taskId), actor, options);
    check(options.revision === undefined || options.force === true, 'acceptance confirmation parameters apply only to Valet or explicit force acceptance');
    check(options.confirm === undefined || options.force === true, 'acceptance confirmation parameters apply only to Valet or explicit force acceptance');
    const forced = options.force === true || options.forcePreview === true;
    check(!forced || (actor === null && !options.completion && !options.managementReceipt), '强制验收仅允许用户显式操作');
    if (options.force === true) check(options.confirm === true && typeof options.revision === 'string'
      && /^[0-9a-f]{64}$/.test(options.revision), '强制验收需要预检 revision 和 confirm=true');
    const waitCheck = (condition, message) => {
      if (!condition && options.completion) { const error = new Error(message); error.acceptance_wait = true; throw error; }
      check(condition, message);
    };
    const invocation = actor === null ? null : this.running.get(id(actor));
    const authorize = task => {
      if (options.completion) this.assertCompletionClaim(task.id, options.completion, options.completion.phase ?? 'accept');
      if (actor === null) return;
      if (options.managementReceipt !== undefined) {
        assertManagementCodeExecution(this, actor, options.managementReceipt, 'worker.accept', { id: task.id });
        check(['order','child'].includes(task.task_kind), 'Valet acceptance requires a development Worker');
        assertTaskAncestorsOpen(this, task);
        return;
      }
      const parent = this.store.task(id(actor));
      const run = this.running.get(parent.id);
      check(parent.status === 'running' && run && run === invocation && !run.parked && !run.controller.signal.aborted,
        'parent Agent is no longer active');
      check(['order', 'child'].includes(parent.task_kind) && task.task_kind === 'child' && task.parent_id === parent.id,
        'agents may confirm only their own direct child, never a user-created order');
      assertTaskAncestorsOpen(this, task);
      check(['awaiting_acceptance', 'completed'].includes(task.status), 'child must be delivered before parent confirmation');
    };
    authorize(this.store.task(id(taskId)));
    assertNoPartialParentAcceptance(this, id(taskId));
    assertTaskNotSyncing(this, id(taskId));
    for (const row of this.subtreeTasks(id(taskId))) {
      assertTaskNoCommand(this, row.id);
      check(!this.acceptanceBusy?.has(row.id), 'Worker acceptance is already in flight');
    }
    return this.workspaces.exclusive(async () => {
      let task = this.store.task(id(taskId));
      check(['order', 'child'].includes(task.task_kind), 'only order/child Workers can be accepted');
      authorize(task);
      assertNoPartialParentAcceptance(this, task.id);
      check(!this.acceptanceBusy?.has(task.id), 'Worker acceptance is already in flight');
      assertTaskNotSyncing(this, task.id); assertTaskNoCommand(this, task.id);
      const historical = task.status === 'completed' && this.store.get("SELECT id FROM events WHERE task_id=? AND type='task.accepted' LIMIT 1", task.id);
      if (!forced && historical && this.subtreeTasks(task.id).every(row => TERMINAL.has(row.status)
        && !this.running.has(row.id) && !this.workspaces.busy.has(row.id))
        && [task.branch, ...descendantsOf(this.store.branches(), task.branch)]
        .every(branch => ['archived', 'deleted'].includes(this.store.branch(branch)?.status))) {
        await this.reclaimConvergenceAfterAcceptanceUnsafe([task.id]);
        return task;
      }
      check(['waiting', 'awaiting_acceptance'].includes(task.status) || historical, 'Worker must be idle before acceptance');
      const previous = this.store.get("SELECT id,data FROM events WHERE task_id=? AND type='task.acceptance_started' ORDER BY id DESC LIMIT 1", task.id);
      let attempt = previous ? { id: previous.id, ...JSON.parse(previous.data) } : null;
      const recovered = new Map();
      if (attempt) for (const event of this.store.all("SELECT data FROM events WHERE task_id=? AND type IN ('branch.archive','branch.archive.outcome') AND json_extract(data,'$.acceptance_execution')=? ORDER BY id", task.id, attempt.id)) {
        for (const outcome of JSON.parse(event.data).outcomes ?? []) recovered.set(outcome.branch, outcome);
      }
      // A known preflight failure with every original resource intact may start afresh.
      // Missing resources without exact outcomes remain blocked, never guessed successful.
      if (attempt && [...recovered.values()].every(outcome => outcome.worktree !== 'removed' && outcome.ref !== 'deleted')
        && attempt.branches.every(branch => this.store.branch(branch)?.status === 'active')
        && task.workspace && fs.existsSync(task.workspace)) { attempt = null; recovered.clear(); }
      if (attempt) check(attempt.head_commit === task.head_commit, 'acceptance recovery commit changed; inspect resource records');
      const subtree = this.subtreeTasks(task.id);
      const forceScope = forced ? forceAcceptanceScope(this, task, subtree) : null;
      if (forced) {
        check(forceScope.skipped.length > 0, '没有可跳过的终态 Worker 系统通知；请使用普通验收');
        if (options.force === true) check(forceScope.preview.revision === options.revision, '强制验收范围已变化；请重新预检并确认');
      }
      const skippedIds = forceScope?.skipped.map(message => message.id) ?? [];
      const unread = row => acceptanceUnreadMessage(this, row, acceptingIds, skippedIds);
      waitCheck(subtree.every(row => !this.running.has(row.id) && !this.workspaces.busy.has(row.id)), 'Agent or cleanup is still in flight');
      const children = acceptanceChildren(subtree, task.id);
      const acceptingIds = new Set([task.id, ...children.map(row => row.id)]);
      for (const helper of this.convergenceAcceptanceHelpers(subtree, acceptingIds)) acceptingIds.add(helper.id);
      const identities = new Map(subtree.map(row => [row.id, acceptanceIdentity(row)]));
      waitCheck(subtree.slice(1).every(row => TERMINAL.has(row.status) || acceptingIds.has(row.id)),
        'accept or end descendants before accepting their parent; only delivered child delegation chains can be accepted together');
      if (attempt) {
        const fixedIds = attempt.accepting_task_ids ?? [task.id];
        check(fixedIds.length === acceptingIds.size && fixedIds.every(rowId => acceptingIds.has(rowId)),
          'acceptance recovery participants changed; inspect resource records');
        check(attempt.task_ids.length === subtree.length && subtree.every(row => attempt.task_ids.includes(row.id)),
          'acceptance recovery descendants changed');
        if (attempt.rows) check(subtree.every(row => sameIdentity(row, attempt.rows.find(fixed => fixed.id === row.id) ?? { id: null })),
          'acceptance recovery Worker changed; inspect resource records');
      }
      for (const child of children) check(child.branch && child.head_commit, 'delivered child has no inspectable resource identity');
      for (const row of subtree) {
        const booking = bookingOf(row);
        assertLocalWorker(this, row.id);
        assertTaskNotSyncing(this, row.id); assertTaskNoCommand(this, row.id);
        waitCheck(!booking || ['integrated', 'completed', 'withdrawn'].includes(booking.status)
          || (booking.status === 'pending' && taskSyncDeliveryPaused(this, row.id)), 'delivery is still in flight or reserved');
        waitCheck(!this.pendingAppendEmission(row.id), `Worker ${workerLabel(row)}: mounted append input must be dispatched or cancelled before acceptance`);
        waitCheck(!unread(row), `Worker ${workerLabel(row)}: unread input must be processed before acceptance`);
        waitCheck(!this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open' LIMIT 1", row.id), 'open decisions block acceptance');
        if (row.branch) {
          const record = this.store.branch(row.branch);
          if (['archived', 'deleted'].includes(record?.status)) {
            if (row.id !== task.id && TERMINAL.has(row.status)) continue;
            const outcome = recovered.get(row.branch);
            check((outcome?.reason === null || outcome?.ref === 'deleted') && attempt?.tips[row.branch] === row.head_commit,
              'Worker resources are missing without an exact acceptance receipt; inspect before recovery');
            check(!await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${row.branch}^{commit}`).catch(() => null),
              'acceptance recovery branch was recreated; preserve and inspect it');
            continue;
          }
          waitCheck(!this.branchFreeze(row.branch), 'Worker branch is frozen; wait for its safe point');
          this.assertBranchWritable(row.branch, 'accept it');
          if (recovered.get(row.branch)?.ref === 'deleted' && attempt?.tips[row.branch] === row.head_commit) {
            const remainingRef = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${row.branch}^{commit}`).catch(() => null);
            check(!remainingRef, 'acceptance recovery branch was recreated; preserve and inspect it');
            continue;
          }
          const removed = recovered.get(row.branch)?.worktree === 'removed' && attempt?.tips[row.branch] === row.head_commit;
          check(record?.status === 'active' && (!acceptingIds.has(row.id) || removed || (row.workspace && fs.existsSync(row.workspace))),
            'Worker branch/worktree is archived or missing');
          if (row.workspace) {
            try {
              if (forced) {
                await this.workspaces.clean(row.workspace);
                check(await this.workspaces.git(row.workspace, 'symbolic-ref', '--short', 'HEAD') === row.branch,
                  'agent changed the worker branch; restore it before retrying');
                check(await this.workspaces.git(row.workspace, 'rev-parse', 'HEAD') === row.head_commit,
                  'Worker branch moved; inspect before acceptance');
              } else await this.workspaces.finish(row);
            }
            catch (error) {
              if (options.completion && await this.workspaces.git(row.workspace, 'status', '--porcelain').catch(() => '')) error.acceptance_wait = true;
              throw error;
            }
          } else {
            const head = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${row.branch}^{commit}`);
            check(head === row.head_commit, `descendant Worker ${workerLabel(row)} branch moved`);
            const workspace = await this.workspaces.workspaceForBranch(row.branch);
            if (workspace) await this.workspaces.clean(workspace);
          }
          const currentRow = this.store.task(row.id);
          const parentReclaimed = attempt?.tips[row.branch] === currentRow.head_commit
            && recovered.get(row.target_branch)?.ref === 'deleted';
          const state = parentReclaimed ? currentRow.integration : await taskDeliveryState(this, currentRow);
          check(state !== 'pending', `Worker ${workerLabel(row)} has undelivered changes`);
          if (!options.forcePreview && row.task_kind !== 'integration') this.store.update(row.id, { integration: state });
        }
      }
      task = this.store.task(task.id);
      authorize(task);
      check(['waiting', 'awaiting_acceptance'].includes(task.status) || historical, 'Worker changed during acceptance');
      for (const row of this.subtreeTasks(task.id)) {
        check(identities.has(row.id) && sameIdentity(row, identities.get(row.id)), 'descendant changed during acceptance');
        check(!this.running.has(row.id) && !unread(row),
          `Worker ${workerLabel(row)}: new input arrived during acceptance`);
        assertTaskNotSyncing(this, row.id); assertTaskNoCommand(this, row.id);
        check(!this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open' LIMIT 1", row.id), 'open decisions block acceptance');
        check(!bookingOf(row) || ['integrated', 'completed', 'withdrawn'].includes(bookingOf(row).status)
          || (bookingOf(row).status === 'pending' && taskSyncDeliveryPaused(this, row.id)), 'delivery changed during acceptance');
      }
      const branches = [task.branch, ...descendantsOf(this.store.branches(), task.branch)];
      const active = branches.filter(branch => this.store.branch(branch)?.status === 'active');
      const tips = attempt?.tips ?? {};
      for (const branch of active) {
        const owners = this.store.all('SELECT id,head_commit FROM tasks WHERE branch=? ORDER BY id', branch);
        check(owners.length && owners.every(owner => subtree.some(row => row.id === owner.id)), 'acceptance branch subtree has unrelated resource owners');
        const head = owners.at(-1).head_commit;
        check(head && (!attempt || tips[branch] === head), 'acceptance recovery source changed; inspect before continuing');
        tips[branch] = head;
      }
      if (forced) {
        assertForceAcceptanceMessages(this, forceScope.skipped);
        check(forceAcceptanceScope(this, task, this.subtreeTasks(task.id)).preview.revision === forceScope.preview.revision,
          '强制验收范围已变化；请重新预检并确认');
        check(this.branchResourceUsers(active).every(resourceId => {
          const row = this.store.task(resourceId);
          return (acceptingIds.has(row.id) || TERMINAL.has(row.status)) && !this.running.has(row.id)
            && !this.commandHookRunning?.has(row.id) && !this.workspaces.busy.has(row.id);
        }), 'acceptance resource users changed');
        await this.workspaces.archiveBranchesUnsafe(active, { expectedTips: new Map(active.map(branch => [branch, tips[branch]])), preflight_only: true });
        assertForceAcceptanceMessages(this, forceScope.skipped);
        check(forceAcceptanceScope(this, task, this.subtreeTasks(task.id)).preview.revision === forceScope.preview.revision,
          '强制验收范围已变化；请重新预检并确认');
        if (options.forcePreview) return forceScope.preview;
      }
      const started = attempt ?? { id: this.store.event(task.id, 'task.acceptance_started', {
        head_commit: task.head_commit, tips, branches, task_ids: subtree.map(row => row.id), integration: task.integration,
        accepting_task_ids: [...acceptingIds], rows: subtree.map(row => ({ ...identities.get(row.id),
          head_commit: this.store.task(row.id).head_commit, integration: this.store.task(row.id).integration })),
      }), head_commit: task.head_commit, tips, branches, task_ids: subtree.map(row => row.id) };
      if (forced) this.store.event(task.id, 'task.acceptance_forced', { acceptance_execution: started.id,
        revision: options.revision, skipped_messages: forceScope.skipped.map(({ body, ...message }) => message),
        notifications: forceScope.preview.notifications, accepted_by: 'user' });
      const fixedRows = attempt?.rows ?? subtree.map(row => ({ ...identities.get(row.id),
        head_commit: this.store.task(row.id).head_commit, integration: this.store.task(row.id).integration }));
      const guard = () => {
        const current = this.store.task(task.id);
        authorize(current);
        if (forced) assertForceAcceptanceMessages(this, forceScope.skipped);
        check(current.head_commit === started.head_commit && current.status === task.status, 'Worker changed during resource reclamation');
        const names = [current.branch, ...descendantsOf(this.store.branches(), current.branch)];
        check(names.length === started.branches.length && names.every(name => started.branches.includes(name)), 'acceptance branch subtree changed');
        const rows = this.subtreeTasks(task.id);
        check(rows.length === started.task_ids.length && rows.every(row => started.task_ids.includes(row.id)), 'acceptance descendants changed');
        for (const row of rows) {
          check(sameIdentity(row, fixedRows.find(fixed => fixed.id === row.id) ?? { id: null }), 'descendant changed during acceptance');
          check(!this.running.has(row.id) && !this.workspaces.busy.has(row.id), 'Agent or cleanup is still in flight');
          assertTaskNotSyncing(this, row.id); assertTaskNoCommand(this, row.id);
          check(!unread(row), `Worker ${workerLabel(row)}: new input arrived during acceptance`);
          check(!this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open' LIMIT 1", row.id), 'open decisions block acceptance');
          const booking = bookingOf(row);
          check(!booking || ['integrated', 'completed', 'withdrawn'].includes(booking.status)
            || (booking.status === 'pending' && taskSyncDeliveryPaused(this, row.id)), 'delivery changed during acceptance');
          waitCheck(!this.pendingAppendEmission(row.id), `Worker ${workerLabel(row)}: mounted append input must be dispatched or cancelled before acceptance`);
          if (row.branch) this.assertBranchWritable(row.branch, 'accept it');
        }
        check(this.branchResourceUsers(active).every(resourceId => {
          const row = this.store.task(resourceId);
          return (acceptingIds.has(row.id) || TERMINAL.has(row.status)) && !this.running.has(row.id)
            && !this.commandHookRunning?.has(row.id) && !this.workspaces.busy.has(row.id);
        }), 'acceptance resource users changed');
      };
      guard();
      // Completion submission is not execution: claim the deletion only after
      // the ordinary Git/input/descendant preflight has passed. Waiting can resume;
      // once resource effects start, failed/unknown actions must not replay.
      options.beginCompletion?.();
      guard();
      this.acceptanceBusy ??= new Set();
      for (const row of subtree) this.acceptanceBusy.add(row.id);
      const perform = async () => {
        try {
          const result = await this.archiveBranch(task.branch, { acceptance: { id: started.id, task_id: task.id, task_ids: acceptingIds, tips, guard, completion: options.completion, git_gate: true,
            deletedRefs: new Set([...recovered].filter(([, outcome]) => outcome.ref === 'deleted').map(([branch]) => branch)),
          } });
          check(!result.failed.length && !result.remaining.length, 'acceptance resource reclamation incomplete; inspect branch.archive and retry worker.accept explicitly');
          guard();
        } catch (error) {
          this.store.event(task.id, 'task.acceptance_failed', { acceptance_execution: started.id, reason: 'Resource reclamation incomplete; inspect branch.archive before explicitly retrying worker.accept' });
          throw error;
        } finally {
          for (const row of subtree) this.acceptanceBusy.delete(row.id);
        }
        // Settle all successful participants together, only after the complete resource tree is reclaimed.
        // Failed/cancelled/historical descendants keep their original outcomes and acceptance facts.
        this.store.transaction(() => {
          for (const rowId of acceptingIds) {
            const row = this.store.task(rowId), booking = bookingOf(row);
            if (booking?.status === 'pending') this.store.event(row.id, 'task.unreserved', { reservation: booking, reason: 'accepted after parent sync' });
            this.store.update(row.id, { status: 'completed', error: null,
              ...(booking?.status === 'pending' ? { reservation: null } : {}) });
            this.store.armAgent(row.id, null);
            this.store.event(row.id, row.task_kind === 'integration' ? 'convergence.helper_reclaimed'
              : row.id === task.id && historical ? 'task.acceptance_reclaimed' : 'task.accepted', {
              head_commit: row.head_commit, integration: row.integration,
              accepted_by: actor === null ? 'user' : 'parent', parent_id: actor, resources_reclaimed: true,
              acceptance_execution: started.id,
              ...(row.id !== task.id ? { via: 'parent_acceptance', acceptance_root_id: task.id, delegator_id: row.parent_id } : {}),
              ...(options.completion ? { via: row.id === task.id ? 'completion_hook' : 'parent_acceptance',
                completion_execution: options.completion.id, authorization: options.completion.authorization,
                round: options.completion.round } : {}) });
          }
        });
        for (const rowId of acceptingIds) {
          if (this.store.task(rowId).task_kind === 'integration') continue;
          if (rowId !== task.id || !historical) this.emitTaskHook(rowId, 'worker.accepted');
          this.scheduleTaskCompletion(rowId);
        }
        await this.reclaimConvergenceAfterAcceptanceUnsafe([...acceptingIds]);
        return this.store.task(task.id);
      };
      return perform();
    });
  },

  /** Explicit historical recovery; never starts a provider or recreates an archived ref. */
  async reopenTask(taskId) {
    this.assertWritable('reopen a worker');
    assertTaskNotSyncing(this, id(taskId)); assertTaskNoCommand(this, id(taskId));
    assertLocalWorker(this, id(taskId));
    return this.workspaces.exclusive(async () => {
      const task = this.store.task(id(taskId));
      assertTaskNotSyncing(this, task.id); assertTaskNoCommand(this, task.id);
      check(['order', 'child'].includes(task.task_kind) && task.status === 'completed', 'only completed order/child Workers can be reopened');
      assertTaskAncestorsOpen(this, task);
      check(!this.running.has(task.id) && !this.workspaces.busy.has(task.id), 'Agent or cleanup is still in flight');
      check(!this.store.get("SELECT id FROM events WHERE task_id=? AND type='task.accepted' LIMIT 1", task.id),
        'explicitly accepted Workers cannot be reopened; start a new Worker');
      check(task.branch && task.workspace && fs.existsSync(task.workspace)
        && this.store.branch(task.branch)?.status === 'active', 'archived or missing branches cannot be reopened');
      check(task.integration === 'merged', 'only historical completed/merged Workers can be reopened');
      this.assertBranchWritable(task.branch, 'reopen it');
      const booking = bookingOf(task);
      check(!booking || ['integrated', 'completed', 'withdrawn'].includes(booking.status), 'outstanding delivery blocks reopen');
      const head = await this.workspaces.git(task.workspace, 'rev-parse', 'HEAD');
      check(head === task.head_commit, 'Worker branch moved; inspect before reopening');
      await this.workspaces.finish(task);
      const integration = await taskDeliveryState(this, this.store.task(task.id));
      check(integration !== 'pending', 'historical Worker has undelivered changes; inspect before reopening');
      this.store.transaction(() => {
        this.store.update(task.id, { status: 'awaiting_acceptance', integration, error: null,
          iteration_base_commit: task.iteration_base_commit ?? head });
        this.store.armAgent(task.id, null);
        const event = this.store.event(task.id, 'task.reopened', { head_commit: head, previous_status: task.status });
        this.notifyAcceptanceEntry(task.id, event);
      });
      return this.store.task(task.id);
    });
  },
};
