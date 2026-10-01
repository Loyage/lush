import fs from 'node:fs';
import { check, id, TERMINAL } from '../types.js';

const bookingOf = task => task.reservation ? JSON.parse(task.reservation) : null;

/** A completed runtime queue has no Agent inbox. Keep its settled sources' diagnostics as history. */
function acceptanceUnreadMessage(project, task) {
  const idleQueue = task.task_kind === 'merge' && task.name === 'merge'
    && task.status === 'completed' && !task.branch;
  return project.store.get(`SELECT m.id FROM messages m WHERE m.task_id=? AND m.consumed=0
    AND NOT (? AND m.sender_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM tasks source WHERE source.id=m.sender_id
        AND source.status IN ('completed','failed','cancelled'))
      AND EXISTS (SELECT 1 FROM events e WHERE e.task_id=m.sender_id
        AND e.type='task.reparented_for_merge'
        AND json_extract(e.data,'$.to')=? AND json_extract(e.data,'$.from')=?))
    ORDER BY m.id LIMIT 1`, task.id, idleQueue ? 1 : 0, task.id, task.parent_id);
}

export function assertTaskNotSyncing(project, taskId) {
  check(!project.taskSyncBusy?.has(taskId), 'Task parent sync is in flight; wait for its safe point');
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
  const seen = new Set([task.id]);
  let parentId = bookingOf(task)?.parent_id ?? task.parent_id;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = project.store.task(parentId);
    // A reusable runtime queue can be idle; its original parent is the actual owner.
    check(parent.task_kind === 'merge' || !TERMINAL.has(parent.status),
      `parent has ended (ancestor Task #${parent.id}); reopen or retry the ancestor first`);
    parentId = parent.parent_id;
  }
}

/** Receipts live in Events, not in the single mutable reservation slot. */
export function consumeIntegratedReservation(project, task, reason) {
  const previous = bookingOf(task);
  if (previous?.status !== 'integrated' && !(task.task_kind === 'child'
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
  const head = task.head_commit;
  check(head && task.branch && task.target_branch, 'Task has no inspectable delivery branch');
  const parent = await project.workspaces.git(project.config.project, 'rev-parse', '--verify', `refs/heads/${task.target_branch}^{commit}`);
  const event = project.store.get("SELECT data FROM events WHERE task_id=? AND type='task.merge_integrated' ORDER BY id DESC LIMIT 1", task.id);
  const receipt = event ? JSON.parse(event.data) : bookingOf(task);
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

/** Shared bounded read projection. One query per 200 Tasks, four indexed latest-event seeks each. */
export function iterationViews(store, tasks) {
  const result = new Map(tasks.map(task => [task.id, { accepted: false, parent_sync_conflict: null }]));
  for (let offset = 0; offset < tasks.length; offset += 200) {
    const batch = tasks.slice(offset, offset + 200);
    const latest = new Map();
    const rows = store.all(`WITH targets(task_id) AS (VALUES ${batch.map(() => '(?)').join(',')}),
      kinds(type) AS (VALUES ('task.accepted'),('task.reopened'),('task.parent_sync_conflict'),('task.parent_synced'))
      SELECT targets.task_id,kinds.type,e.id,e.data FROM targets CROSS JOIN kinds JOIN events e ON e.id=(
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
      result.set(task.id, { accepted, parent_sync_conflict: conflict });
    }
  }
  return result;
}

export default {
  /** Users accept their goals; a live delegator may confirm only its delivered direct child. */
  async acceptTask(taskId, actor = null) {
    this.assertWritable('accept a task');
    const invocation = actor === null ? null : this.running.get(id(actor));
    const authorize = task => {
      if (actor === null) return;
      const parent = this.store.task(id(actor));
      const run = this.running.get(parent.id);
      check(parent.status === 'running' && run && run === invocation && !run.parked && !run.controller.signal.aborted,
        'parent Agent is no longer active');
      check(['say', 'child'].includes(parent.task_kind) && task.task_kind === 'child' && task.parent_id === parent.id,
        'agents may confirm only their own direct child, never a user-created say');
      assertTaskAncestorsOpen(this, task);
      check(['awaiting_acceptance', 'completed'].includes(task.status), 'child must be delivered before parent confirmation');
    };
    authorize(this.store.task(id(taskId)));
    assertTaskNotSyncing(this, id(taskId));
    return this.workspaces.exclusive(async () => {
      let task = this.store.task(id(taskId));
      check(['say', 'child'].includes(task.task_kind), 'only say/child Tasks can be accepted');
      authorize(task);
      assertTaskNotSyncing(this, task.id);
      if (task.status === 'completed') return task;
      check(['waiting', 'awaiting_acceptance'].includes(task.status), 'Task must be idle before acceptance');
      const subtree = this.subtreeTasks(task.id);
      check(subtree.every(row => !this.running.has(row.id) && !this.workspaces.busy.has(row.id)), 'Agent or cleanup is still in flight');
      check(subtree.slice(1).every(row => TERMINAL.has(row.status)), 'accept or end descendants before accepting their parent');
      for (const row of subtree) {
        const booking = bookingOf(row);
        assertTaskNotSyncing(this, row.id);
        check(!booking || ['integrated', 'completed', 'withdrawn'].includes(booking.status)
          || (booking.status === 'pending' && taskSyncDeliveryPaused(this, row.id)), 'delivery is still in flight or reserved');
        check(!acceptanceUnreadMessage(this, row), `Task #${row.id}: unread input must be processed before acceptance`);
        check(!this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open' LIMIT 1", row.id), 'open decisions block acceptance');
        if (row.branch) {
          const record = this.store.branch(row.branch);
          if (row.id !== task.id && TERMINAL.has(row.status) && ['archived', 'deleted'].includes(record?.status)) continue;
          this.assertBranchWritable(row.branch, 'accept it');
          check(record?.status === 'active' && (row.id !== task.id || (row.workspace && fs.existsSync(row.workspace))),
            'Task branch/worktree is archived or missing');
          if (row.workspace) await this.workspaces.finish(row);
          else {
            const head = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${row.branch}^{commit}`);
            check(head === row.head_commit, `descendant Task #${row.id} branch moved`);
            const workspace = await this.workspaces.workspaceForBranch(row.branch);
            if (workspace) await this.workspaces.clean(workspace);
          }
          const state = await taskDeliveryState(this, this.store.task(row.id));
          check(state !== 'pending', `Task #${row.id} has undelivered changes`);
          this.store.update(row.id, { integration: state });
        }
      }
      task = this.store.task(task.id);
      authorize(task);
      check(['waiting', 'awaiting_acceptance'].includes(task.status), 'Task changed during acceptance');
      for (const row of this.subtreeTasks(task.id)) {
        check(row.id === task.id || TERMINAL.has(row.status), 'descendant changed during acceptance');
        check(!this.running.has(row.id) && !acceptanceUnreadMessage(this, row),
          `Task #${row.id}: new input arrived during acceptance`);
        assertTaskNotSyncing(this, row.id);
        check(!this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open' LIMIT 1", row.id), 'open decisions block acceptance');
        check(!bookingOf(row) || ['integrated', 'completed', 'withdrawn'].includes(bookingOf(row).status)
          || (bookingOf(row).status === 'pending' && taskSyncDeliveryPaused(this, row.id)), 'delivery changed during acceptance');
      }
      this.store.transaction(() => {
        const booking = bookingOf(task);
        if (booking?.status === 'pending') this.store.event(task.id, 'task.unreserved', { reservation: booking, reason: 'accepted after parent sync' });
        this.store.update(task.id, { status: 'completed', error: null, retry_profile: null,
          ...(booking?.status === 'pending' ? { reservation: null } : {}) });
        this.store.armAgent(task.id, null);
        this.store.event(task.id, 'task.accepted', { head_commit: task.head_commit, integration: task.integration,
          accepted_by: actor === null ? 'user' : 'parent', parent_id: actor });
      });
      return this.store.task(task.id);
    });
  },

  /** Explicit historical recovery; never starts a provider or recreates an archived ref. */
  async reopenTask(taskId) {
    this.assertWritable('reopen a task');
    assertTaskNotSyncing(this, id(taskId));
    return this.workspaces.exclusive(async () => {
      const task = this.store.task(id(taskId));
      assertTaskNotSyncing(this, task.id);
      check(['say', 'child'].includes(task.task_kind) && task.status === 'completed', 'only completed say/child Tasks can be reopened');
      assertTaskAncestorsOpen(this, task);
      check(!this.running.has(task.id) && !this.workspaces.busy.has(task.id), 'Agent or cleanup is still in flight');
      check(task.branch && task.workspace && fs.existsSync(task.workspace)
        && this.store.branch(task.branch)?.status === 'active', 'archived or missing branches cannot be reopened');
      check(!this.store.get("SELECT id FROM events WHERE task_id=? AND type='task.accepted' LIMIT 1", task.id),
        'explicitly accepted Tasks cannot be reopened; start a new Task');
      check(task.integration === 'merged', 'only historical completed/merged Tasks can be reopened');
      this.assertBranchWritable(task.branch, 'reopen it');
      const booking = bookingOf(task);
      check(!booking || ['integrated', 'completed', 'withdrawn'].includes(booking.status), 'outstanding delivery blocks reopen');
      const head = await this.workspaces.git(task.workspace, 'rev-parse', 'HEAD');
      check(head === task.head_commit, 'Task branch moved; inspect before reopening');
      await this.workspaces.finish(task);
      const integration = await taskDeliveryState(this, this.store.task(task.id));
      check(integration !== 'pending', 'historical Task has undelivered changes; inspect before reopening');
      this.store.transaction(() => {
        this.store.update(task.id, { status: 'awaiting_acceptance', integration, error: null,
          iteration_base_commit: task.iteration_base_commit ?? head, retry_profile: null });
        this.store.armAgent(task.id, null);
        this.store.event(task.id, 'task.reopened', { head_commit: head, previous_status: task.status });
      });
      return this.store.task(task.id);
    });
  },
};
