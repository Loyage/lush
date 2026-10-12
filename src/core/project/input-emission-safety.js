import fs from 'node:fs';
import { check, id } from '../types.js';
import { workerLabel } from '../worker-number.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing } from './iteration.js';
import { inputEmission, inputOptions, saveEmission, canReleaseInputExclusive } from './input-emission-data.js';

export function roundEvent(project, taskId) {
  return project.store.get(`SELECT max(id) AS id FROM events WHERE task_id=? AND
    (type IN ('task.iteration_started','retry','task.reopened','invocation.started') OR
      (type='message' AND json_extract(data,'$.sender') IS NULL))`, taskId)?.id ?? 0;
}
function lastDelivery(project, taskId, after = 0) {
  const row = project.store.get("SELECT id,data FROM events WHERE task_id=? AND type='task.merge_integrated' AND id>? ORDER BY id DESC LIMIT 1", taskId, after);
  return row ? { id: row.id, ...JSON.parse(row.data) } : null;
}

export default {
  assertAppendInputTarget(taskId) {
    const task = this.store.task(id(taskId));
    check(['order','child'].includes(task.task_kind) && !['completed','failed','cancelled'].includes(task.status), 'append target has ended or does not support development input');
    assertTaskAncestorsOpen(this, task);
    check(!this.acceptanceBusy?.has(task.id) && (!task.branch || this.store.branch(task.branch)?.status === 'active'), 'append target is being reclaimed or archived');
    return task;
  },

  inputRoot(taskOrId) {
    let task = typeof taskOrId === 'object' ? taskOrId : this.store.task(taskOrId);
    const seen = new Set();
    while (task.parent_id && !seen.has(task.id)) { seen.add(task.id); task = this.store.task(task.parent_id); }
    check(['main','owner'].includes(task.task_kind), 'input target has no bound branch root');
    return task;
  },

  inputSubtree(rootId) {
    return this.store.all(`WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT t.id FROM tasks t JOIN tree ON t.parent_id=tree.id)
      SELECT t.* FROM tasks t JOIN tree ON tree.id=t.id
      WHERE NOT (t.status IN ('completed','cancelled') AND (t.workspace IS NULL OR EXISTS
        (SELECT 1 FROM branches b WHERE b.branch=t.branch AND b.status IN ('archived','deleted'))))
      ORDER BY t.id LIMIT 1002`, rootId);
  },

  inputProjectWork() {
    return this.store.all(`SELECT t.* FROM tasks t WHERE NOT (t.status IN ('completed','cancelled') AND
      (t.workspace IS NULL OR EXISTS (SELECT 1 FROM branches b WHERE b.branch=t.branch AND b.status IN ('archived','deleted'))))
      ORDER BY t.id LIMIT 1002`);
  },

  pendingAppendEmission(taskId) {
    return this.store.get(`SELECT id FROM drafts WHERE json_extract(input_options,'$.mode')='append'
      AND json_extract(input_options,'$.target_id')=? AND json_extract(emission,'$.state')
      IN ('waiting_conditions','queued','dispatching','unknown') ORDER BY id LIMIT 1`, taskId);
  },

  inputWorkerBusyReason(task) {
    if (this.running.has(task.id) || ['queued','running','awaiting','paused','failed'].includes(task.status) || task.interrupt_state)
      return `${workerLabel(task)} 尚未静息（${task.status}）`;
    if (this.commandHookRunning?.has(task.id) || this.taskSyncBusy?.has(task.id) || this.taskMergeBusy?.has(task.id)
      || this.acceptanceBusy?.has(task.id) || this.workspaces.busy.has(task.id) || this.activeTaskMerge(task.id)) return `${workerLabel(task)} 有在途操作`;
    if (this.questionPending(task.id)) return `${workerLabel(task)} 有待决问题`;
    if (this.hasActionableMessages(task.id) || this.taskInputQueue(task).buffered) return `${workerLabel(task)} 有未处理输入`;
    const booking = task.reservation ? JSON.parse(task.reservation) : null;
    if (booking && ['requested','executing','resolving','blocked','suspended'].includes(booking.status)) return `${workerLabel(task)} 交付尚未收口`;
    return null;
  },

  inputWorkerSettled(task, snapshot = 0) {
    if (!['waiting','awaiting_acceptance','completed'].includes(task.status) || this.inputWorkerBusyReason(task)) return false;
    if (this.store.children(task.id).some(child => ['order','child','integration'].includes(child.task_kind)
      && !['awaiting_acceptance','completed','cancelled'].includes(child.status))) return false;
    const after = Math.max(snapshot, roundEvent(this, task.id));
    return Boolean(this.store.get(`SELECT id FROM events WHERE task_id=? AND id>?
      AND type IN ('task.idle','task.delivered','task.merge_integrated','task.accepted') LIMIT 1`, task.id, after));
  },

  async inputWorkspaceClean(task) {
    if (!task.workspace || !fs.existsSync(task.workspace)) return !task.workspace || ['archived','deleted'].includes(this.store.branch(task.branch)?.status);
    try {
      if ((await this.workspaces.git(task.workspace, 'status', '--porcelain')).length) return false;
      if (!['completed','cancelled'].includes(task.status) && task.head_commit
        && await this.workspaces.git(task.workspace, 'rev-parse', '--verify', 'HEAD') !== task.head_commit) return false;
      return true;
    }
    catch { return false; }
  },

  /** Follow exact squash receipts across delegation levels, not source SHA ancestry alone. */
  async inputWorkerMergedToMain(task, snapshot = 0, rootId = null) {
    if (!this.inputWorkerSettled(task, snapshot) || !task.head_commit || !await this.inputWorkspaceClean(task)) return false;
    const main = rootId ? this.store.get('SELECT * FROM tasks WHERE id=?', rootId)
      : this.store.get("SELECT * FROM tasks WHERE task_kind='main' AND branch='main'");
    if (!main) return false;
    let source = task, commit = task.head_commit, lower = Math.max(snapshot, roundEvent(this, task.id));
    const seen = new Set();
    while (source.id !== main.id && !seen.has(source.id)) {
      seen.add(source.id);
      const receipt = lastDelivery(this, source.id, lower);
      if (!receipt || (receipt.source_commit ?? receipt.commit) !== commit || !receipt.commit) return false;
      const parent = this.store.get('SELECT * FROM tasks WHERE id=?', receipt.parent_id ?? source.parent_id);
      if (!parent?.branch) return false;
      if (parent.id === main.id) {
        let parentHead;
        try { parentHead = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${parent.branch}^{commit}`); }
        catch { return false; }
        return this.workspaces.isAncestor(this.config.project, receipt.commit, parentHead);
      }
      // The parent's later squash must contain the precise child's landing. Never borrow
      // an old parent delivery whose fixed source predates that landing. Its retained
      // source object remains authoritative even after the parent worktree/ref is archived.
      const upward = lastDelivery(this, parent.id, receipt.id);
      if (!upward?.source_commit || !await this.workspaces.isAncestor(this.config.project, receipt.commit, upward.source_commit)) return false;
      source = parent; commit = upward.source_commit; lower = receipt.id;
    }
    return false;
  },

  /** Synchronous state proof, repeated at the actual Git creation boundary. */
  inputQuietStateReason(rootId, exceptId = null, projectWide = false) {
    const tasks = projectWide ? this.inputProjectWork() : this.inputSubtree(rootId);
    if (tasks.length > 1000) return '目标开发树过大，无法安全确认静息';
    for (const task of tasks) {
      if (task.id === exceptId) continue;
      if (['main','owner'].includes(task.task_kind)) {
        if (this.running.has(task.id) || this.activeTaskMerge(task.id) || this.branchFreeze(task.branch)
          || this.commandHookRunning?.has(task.id) || this.taskSyncBusy?.has(task.id)) return '父分支仍有在途操作';
        continue;
      }
      if (task.task_kind === 'integration') {
        if (!['completed','cancelled'].includes(task.status) || this.running.has(task.id)) return '整合工作尚未结算';
        continue;
      }
      if (!['order','child'].includes(task.task_kind)) continue;
      if (['cancelled','completed'].includes(task.status)) {
        if (this.running.has(task.id) || this.taskSyncBusy?.has(task.id) || this.commandHookRunning?.has(task.id)
          || this.workspaces.busy.has(task.id) || this.acceptanceBusy?.has(task.id)) return `${workerLabel(task)} 仍在收尾`;
        continue;
      }
      const busy = this.inputWorkerBusyReason(task);
      if (busy) return busy;
      if (!this.inputWorkerSettled(task)) return `${workerLabel(task)} 工作尚未安全交付`;
      const round = roundEvent(this, task.id), delivery = lastDelivery(this, task.id, round);
      const idle = this.store.get("SELECT data FROM events WHERE task_id=? AND type IN ('task.idle','task.delivered') AND id>? ORDER BY id DESC LIMIT 1", task.id, round);
      const noCode = idle && task.head_commit && task.head_commit === (task.iteration_base_commit ?? task.base_commit);
      if (!delivery && !noCode) return `${workerLabel(task)} 本轮成果尚未合并`;
    }
    return null;
  },

  async inputParentQuiet(rootId, exceptId = null, projectWide = false) {
    let reason = this.inputQuietStateReason(rootId, exceptId, projectWide);
    if (reason) return reason;
    for (const task of projectWide ? this.inputProjectWork() : this.inputSubtree(rootId)) {
      if (task.id === exceptId || !['order','child'].includes(task.task_kind)) continue;
      if (!await this.inputWorkspaceClean(task)) return `${workerLabel(task)} 留有未处理的脏现场`;
      if (['cancelled','completed'].includes(task.status)) continue;
      const receipt = lastDelivery(this, task.id, roundEvent(this, task.id));
      if (receipt && !await this.inputWorkerMergedToMain(task, 0, this.inputRoot(task).id)) return `${workerLabel(task)} 成果尚未到目标根分支`;
    }
    return this.inputQuietStateReason(rootId, exceptId, projectWide);
  },

  activeInputExclusive() {
    const rows = this.store.all("SELECT * FROM drafts WHERE emission IS NOT NULL AND json_extract(emission,'$.exclusive_active')=1 ORDER BY id LIMIT 2");
    return rows.map(draft => ({ draft_id: draft.id, ...inputEmission(draft) }));
  },

  inputExclusiveReason(taskOrParentId, ownDraftId = null) {
    const taskId = typeof taskOrParentId === 'object' ? taskOrParentId.id : taskOrParentId;
    for (const exclusive of this.activeInputExclusive()) {
      if (exclusive.draft_id === ownDraftId) continue;
      if (exclusive.worker_id && this.inputSubtree(exclusive.worker_id).some(task => task.id === taskId)) continue;
      return `独占开发 ${exclusive.worker_number ?? (exclusive.worker_id ? `#${exclusive.worker_id}` : `草稿 #${exclusive.draft_id}`)} 尚未交付收口`;
    }
    return null;
  },

  inputCreationReason(parentId, draftId = null) {
    const parent = this.assertInputParent(parentId);
    assertTaskNotSyncing(this, parent.id);
    const exclusive = this.inputExclusiveReason(parent.id, draftId);
    if (exclusive) return exclusive;
    if (this.running.has(parent.id) || ['running','queued','paused','awaiting'].includes(parent.status)
      || this.commandHookRunning?.has(parent.id) || this.taskMergeBusy?.has(parent.id)
      || this.activeTaskMerge(parent.id) || this.branchFreeze(parent.branch) || this.questionPending(parent.id)) return '父 Worker 正忙，等待可创建安全点';
    return null;
  },

  releaseInputExclusive(draftId, revision) {
    this.assertWritable('release exclusive development');
    return this.store.transaction(() => {
      const draft = this.store.draft(id(draftId));
      check(draft.revision === revision, 'draft changed; reload its latest revision');
      const state = inputEmission(draft);
      check(inputOptions(draft).exclusive && state?.exclusive_active === true, 'input has no active exclusive reservation');
      check(canReleaseInputExclusive(state), 'input dispatch is in flight or not releasable; wait for its receipt');
      state.exclusive_active = false; state.exclusive_released = true;
      saveEmission(this, draft.id, state);
      this.store.event(draft.parent_id, 'input.exclusive_released', { draft_id: draft.id, worker_id: state.worker_id ?? null });
      this.kick(); this.scheduleInputEmissions();
      return this.inputEmissionResult(draft.id);
    });
  },
};
