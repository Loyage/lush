import { check, id } from '../types.js';
import { assertLocalWorker } from './execution-retired.js';
import { HOOK_ACTIONS, hookRevision } from '../hooks.js';

const booking = task => task.reservation ? JSON.parse(task.reservation) : null;
const round = (project, taskId) => project.store.get("SELECT max(id) AS id FROM events WHERE task_id=? AND type IN ('task.iteration_started','task.reopened','retry')", taskId)?.id ?? 0;
const validStatus = value => ['submitted','waiting','running','succeeded','failed','unknown'].includes(value) ? value : 'unknown';
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
const safeFailure = tool => tool === 'accept_worker' ? '验收未完成；请检查输入、调用和资源回收记录。'
  : tool === 'integrate_deliveries' ? '交付处理未完成；请检查固定交付与发布记录。' : '合并请求未完成；请检查交付记录。';
const statusOf = request => request.status === 'integrated' ? 'succeeded' : request.status === 'blocked' ? 'unknown'
  : request.status === 'suspended' ? 'waiting' : ['executing','resolving'].includes(request.status) ? 'running'
  : request.status === 'requested' ? 'submitted' : 'waiting';

/** Internal system tools only. The catalogue describes the very tools dispatched here;
 * it grants no RPC/Agent authority and cannot install builtin-only actions. */
export default {
  dispatchAutomationOperation(tool, workerId, context = {}) {
    if (this.cliMutation && (context.automatic || tool === 'integrate_deliveries')) {
      if (tool === 'integrate_deliveries')
        (context.engine === 'converge' ? this.convergenceWakePending ??= new Set() : this.taskMergeWakePending ??= new Set()).add(workerId);
      return false;
    }
    const entry = HOOK_ACTIONS.find(action => action.type === tool);
    check(entry?.execution === 'operation', 'unsupported automation operation');
    const task = this.store.task(id(workerId));
    if (tool !== 'integrate_deliveries' && !context.automatic) assertLocalWorker(this, task.id);
    if (this.store.executionRetired(task.id)) return false;
    if (tool === 'request_merge') return context.automatic
      ? this.settleQueuedMergeOperation(task.id) : this.requestMergeOperation(task.id);
    if (tool === 'accept_worker') return this.acceptWorkerOperation(task.id, context.actor ?? null, context.options ?? {});
    check(tool === 'integrate_deliveries' && entry.builtin_only && entry.scope === 'target', 'unsupported system tool');
    if (context.phase === 'pin') return this.pinDeliveryHandlerOperation(task, context);
    // Drivers still own their durable queues, dependencies, CAS and recovery protocols.
    // Routing here follows fixed receipts, not today's mutable target policy.
    check(['main','owner','order','child'].includes(task.task_kind) && task.branch, 'delivery handler requires a branch owner');
    if (context.engine === 'converge') return this.scheduleConvergenceOperation(task.id);
    return this.scheduleDeliveryHandlerOperation(task.id);
  },

  deliveryHandlerSelection(task) {
    const policy = this.convergencePolicy(task.branch);
    return { policy, revision: hookRevision({ worker_id: task.id, branch: task.branch, policy }),
      // Historical continuous policies remain readable, but never route new deliveries.
      strategy: 'serial' };
  },

  pinDeliveryHandlerOperation(parent, { selection, deliveryId, sourceId, noChanges = false }) {
    const live = this.store.task(parent.id), current = this.deliveryHandlerSelection(live);
    check(live.branch === parent.branch && current.revision === selection.revision
      && current.policy.generation === selection.policy.generation, 'delivery handler policy changed during safe-point inspection');
    check(this.taskConvergenceView(live), 'delivery handler target ownership changed');
    const source = this.store.task(sourceId), request = booking(source);
    check(source.parent_id === live.id && source.target_branch === live.branch && request?.status === 'pending', 'delivery handler source changed');
    const event = this.store.get("SELECT id FROM events WHERE id=? AND task_id=? AND (type='merge.enqueued' OR (? AND type='task.delivered' AND json_extract(data,'$.no_changes')=1))", deliveryId, source.id, noChanges ? 1 : 0);
    check(event, 'delivery handler requires an authorized fixed delivery');
    const existing = this.store.get("SELECT id,data FROM events WHERE task_id=? AND type='delivery.requested' AND json_extract(data,'$.tool')='integrate_deliveries' AND json_extract(data,'$.delivery_id')=? ORDER BY id DESC LIMIT 1", live.id, deliveryId);
    if (existing) {
      const receipt = JSON.parse(existing.data);
      check(receipt.source_worker_id === source.id && receipt.policy_revision === current.revision
        && receipt.strategy === current.strategy, 'delivery handler receipt changed');
      return { strategy: receipt.strategy, policy: current.policy, operation_id: existing.id };
    }
    const operationId = this.store.event(live.id, 'delivery.requested', { tool: 'integrate_deliveries',
      worker_id: live.id, source_worker_id: source.id, delivery_id: deliveryId, strategy: current.strategy,
      policy_revision: current.revision, policy_generation: current.policy.generation, ...(noChanges ? { no_changes: true } : {}) });
    return { strategy: current.strategy, policy: current.policy, operation_id: operationId };
  },

  ensureMergeRequestOperation(taskId) {
    return this.store.transaction(() => {
      const task = this.store.task(taskId), request = booking(task);
      if (request?.version !== 2 || request.status !== 'pending' || request.request_operation_id) return request?.request_operation_id ?? null;
      const operationId = this.store.event(task.id, 'automation.operation_submitted', { tool: 'request_merge', worker_id: task.id, round: round(this, task.id) });
      this.store.update(task.id, { reservation: JSON.stringify({ ...request, request_operation_id: operationId }) });
      return operationId;
    });
  },

  finishNoChangeMergeOperation(taskId, request, settledId) {
    if (request.request_operation_id) this.store.event(taskId, 'automation.operation_finished', {
      tool: 'request_merge', operation_id: request.request_operation_id, source_event_id: settledId, status: 'succeeded' });
  },

  mergeRequestOperationView(task, operationId = null) {
    const request = booking(task);
    const currentRound = round(this, task.id);
    const event = operationId ? this.store.get("SELECT * FROM events WHERE id=? AND task_id=? AND type='automation.operation_submitted'", operationId, task.id)
      : this.store.get("SELECT * FROM events WHERE task_id=? AND type='automation.operation_submitted' AND json_extract(data,'$.tool')='request_merge' AND json_extract(data,'$.round')=? ORDER BY id DESC LIMIT 1", task.id, currentRound);
    if (!event) return null;
    const data = JSON.parse(event.data);
    if (data.tool !== 'request_merge' || data.worker_id !== task.id || data.round !== currentRound) return null;
    const linked = request?.request_operation_id === event.id ? request : null;
    const finished = this.store.get("SELECT * FROM events WHERE task_id=? AND type='automation.operation_finished' AND json_extract(data,'$.operation_id')=? AND json_extract(data,'$.tool')='request_merge' ORDER BY id DESC LIMIT 1", task.id, event.id);
    const result = finished ? JSON.parse(finished.data) : null;
    const noChanges = result && this.store.get("SELECT id FROM events WHERE id=? AND task_id=? AND type='task.delivered' AND json_extract(data,'$.no_changes')=1", result.source_event_id, task.id);
    const settled = linked?.delivery_id && this.store.get("SELECT id FROM events WHERE task_id=? AND type='task.merge_integrated' AND json_extract(data,'$.delivery_id')=? AND json_extract(data,'$.source_commit')=?", task.id, linked.delivery_id, linked.commit);
    const run = linked?.run_id ? this.store.deliveryRun(linked.run_id) : null;
    let status = noChanges && result.status === 'succeeded' ? 'succeeded' : linked ? statusOf(linked) : 'unknown';
    if (status === 'succeeded' && !noChanges && !settled) status = 'unknown';
    if (run && !settled) status = ['failed','stale','withdrawn'].includes(run.state) ? 'failed'
      : run.state === 'blocked' ? 'unknown' : run.state === 'awaiting' ? 'waiting' : 'running';
    return { version: 1, id: `request-merge:${event.id}`, tool: 'request_merge', status, worker_id: task.id,
      round: data.round, created_at: event.created_at,
      ...(linked?.delivery_id ? { delivery_id: linked.delivery_id } : {}),
      ...(linked?.run_id ? { run_id: linked.run_id, generation: linked.generation } : {}),
      ...(noChanges ? { finished_at: finished.created_at } : settled && iso(linked?.integrated_at) ? { finished_at: linked.integrated_at } : {}),
      ...(['failed','unknown'].includes(status) ? { error: safeFailure('request_merge') } : {}) };
  },

  acceptanceOperationView(task) {
    let config;
    try { config = task.auto_merge ? JSON.parse(task.auto_merge) : null; } catch { return null; }
    const data = config?.completion;
    const currentRound = round(this, task.id);
    const receipt = data?.round === currentRound ? data.executions?.archive ?? data.executions?.accept : null;
    const attempt = this.store.get("SELECT * FROM events WHERE task_id=? AND type='task.acceptance_started' AND id>? ORDER BY id DESC LIMIT 1", task.id, currentRound);
    const settled = attempt && this.store.get("SELECT * FROM events WHERE task_id=? AND type IN ('task.accepted','task.acceptance_reclaimed') AND json_extract(data,'$.acceptance_execution')=? ORDER BY id DESC LIMIT 1", task.id, attempt.id);
    if (!receipt || (settled && attempt.id > receipt.id && JSON.parse(settled.data).completion_execution !== receipt.id)) {
      if (!attempt || JSON.parse(attempt.data).head_commit !== task.head_commit) return null;
      const status = settled ? 'succeeded' : this.acceptanceBusy?.has(task.id) ? 'running' : 'unknown';
      return { version: 1, id: `accept-worker:${attempt.id}`, tool: 'accept_worker', status, worker_id: task.id,
        round: currentRound, created_at: attempt.created_at, ...(settled ? { finished_at: settled.created_at } : status === 'unknown' ? { error: safeFailure('accept_worker') } : {}) };
    }
    const event = this.store.get("SELECT data FROM events WHERE id=? AND task_id=? AND type IN ('completion.execution_submitted','completion.execution_started')", receipt.id, task.id);
    if (!event) return null;
    const claim = JSON.parse(event.data);
    if (claim.authorization !== receipt.authorization || data.authorization !== receipt.authorization
      || claim.round !== receipt.round || claim.head_commit !== receipt.head_commit) return null;
    let status = validStatus(receipt.status);
    if (status === 'succeeded' && !this.store.get("SELECT id FROM events WHERE task_id=? AND (type IN ('task.accepted','task.acceptance_reclaimed') OR (type='branch.archive' AND json_array_length(json_extract(data,'$.failed'))=0 AND json_array_length(json_extract(data,'$.remaining'))=0)) AND json_extract(data,'$.completion_execution')=? AND json_extract(data,'$.authorization')=? AND json_extract(data,'$.round')=?", task.id, receipt.id, receipt.authorization, receipt.round)) status = 'unknown';
    return { version: 1, id: `accept-worker:${receipt.id}`, tool: 'accept_worker', status,
      worker_id: task.id, round: receipt.round, ...(iso(receipt.created_at) ? { created_at: receipt.created_at } : {}),
      ...(iso(receipt.finished_at) ? { finished_at: receipt.finished_at } : {}),
      ...(['failed','unknown'].includes(status) ? { error: safeFailure('accept_worker') } : {}) };
  },

  deliveryHandlerOperationView(task) {
    const event = this.store.get("SELECT * FROM events WHERE task_id=? AND type='delivery.requested' AND json_extract(data,'$.tool')='integrate_deliveries' ORDER BY id DESC LIMIT 1", task.id);
    if (!event) return null;
    const data = JSON.parse(event.data), source = this.store.get('SELECT * FROM tasks WHERE id=?', data.source_worker_id);
    const request = source && booking(source);
    // Old rounds remain traceable through exact settlement events after reservation consumption.
    const settled = data.no_changes === true
      ? this.store.get("SELECT * FROM events WHERE id=? AND task_id=? AND type='task.delivered' AND json_extract(data,'$.no_changes')=1", data.delivery_id, data.source_worker_id)
      : this.store.get("SELECT * FROM events WHERE task_id=? AND type='task.merge_integrated' AND json_extract(data,'$.delivery_id')=? ORDER BY id DESC LIMIT 1", data.source_worker_id, data.delivery_id);
    const linked = request?.handler_operation_id === event.id && request.delivery_id === data.delivery_id ? request : null;
    const run = linked?.run_id ? this.store.deliveryRun(linked.run_id) : null;
    let status = settled ? 'succeeded' : linked ? statusOf(linked) : 'unknown';
    if (run && !settled) status = run.state === 'failed' || run.state === 'stale' || run.state === 'withdrawn' ? 'failed'
      : run.state === 'blocked' ? 'unknown' : run.state === 'awaiting' ? 'waiting' : 'running';
    return { version: 1, id: `delivery-handler:${event.id}`, tool: 'integrate_deliveries', worker_id: task.id,
      delivery_id: data.delivery_id, strategy: data.strategy, status, created_at: event.created_at,
      ...(linked?.run_id ? { run_id: linked.run_id, generation: linked.generation } : {}),
      ...(settled ? { finished_at: settled.created_at } : {}),
      ...(['failed','unknown'].includes(status) ? { error: safeFailure('integrate_deliveries') } : {}) };
  },
};
