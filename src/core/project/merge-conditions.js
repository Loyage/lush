import { check, id, TERMINAL } from '../types.js';
import { hookRevision } from '../hooks.js';
import { normalizeMergeConditions, MergeConditionCycleError } from '../merge-conditions.js';
import { workerLabel } from '../worker-number.js';
import { systemRegistration } from './automation-registry.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing, assertTaskNoCommand } from './iteration.js';

const settings = task => JSON.parse(task.auto_merge ?? '{}');
const stateOf = task => settings(task).merge_conditions ?? null;
const booking = task => JSON.parse(task.reservation ?? 'null');
const active = state => state && state.state !== 'consumed';
const definition = state => state.conditions.map(({ kind, worker_id }) => ({ kind, worker_id }));
function save(project, taskId, state) {
  project.store.update(taskId, { auto_merge: JSON.stringify({ ...settings(project.store.task(taskId)), merge_conditions: state }) });
}
/** A development round is input/iteration identity, not every invocation or repair return. */
export function mergeConditionRound(project, taskId) {
  return project.store.get(`SELECT max(e.id) AS id FROM events e WHERE e.task_id=? AND
    (e.type IN ('task.iteration_started','task.reopened','retry','task.input_released') OR
      (e.type='message' AND NOT EXISTS (SELECT 1 FROM events held WHERE held.task_id=e.task_id
        AND held.type='task.input_buffered' AND json_extract(held.data,'$.message_id')=json_extract(e.data,'$.message_id'))))`, taskId)?.id ?? 0;
}
function revision(project, task) {
  return hookRevision({ worker_id: task.id, round: mergeConditionRound(project, task.id), config: stateOf(task)?.id ?? null });
}
function settledEvent(project, task, round) {
  return project.store.get(`SELECT e.id FROM events e WHERE e.task_id=? AND e.id>?
    AND coalesce(json_extract(e.data,'$.source_commit'),json_extract(e.data,'$.head_commit'),json_extract(e.data,'$.commit'))=? AND
    (e.type IN ('task.delivered','task.merge_integrated') OR (e.type='task.idle' AND EXISTS
      (SELECT 1 FROM agent_runs r WHERE r.id=json_extract(e.data,'$.run_id') AND r.task_id=e.task_id AND r.status='completed')))
    ORDER BY e.id DESC LIMIT 1`, task.id, round, task.head_commit)?.id ?? null;
}
function settledReason(project, task, round) {
  if (!task || project.store.executionRetired(task.id) || !['order','child'].includes(task.task_kind)) return '条件 Worker 不可用';
  if (mergeConditionRound(project, task.id) !== round) return `${workerLabel(task)} 条件轮次已过期；请重新配置`;
  if (!['waiting','awaiting_acceptance','completed'].includes(task.status)) return `${workerLabel(task)} 尚未安全交付就绪`;
  if (project.running.has(task.id) || project.commandHookRunning?.has(task.id) || project.taskSyncBusy?.has(task.id)
    || project.acceptanceBusy?.has(task.id) || project.workspaces.busy.has(task.id)) return `${workerLabel(task)} 仍有在途执行`;
  if (project.store.children(task.id).some(child => ['order','child','integration'].includes(child.task_kind)
    && !['awaiting_acceptance','completed','cancelled'].includes(child.status))) return `${workerLabel(task)} 后代尚未成功收口`;
  if (project.taskInputQueue(task).buffered) return `${workerLabel(task)} 有暂存的新输入，不能复用旧轮证据`;
  const intrinsic = project.reservationWaitReason({ ...task, status: 'waiting' }, false);
  if (intrinsic) return `${workerLabel(task)}：${intrinsic}`;
  if (!settledEvent(project, task, round)) return `${workerLabel(task)} 本轮尚无成功安全交付证据`;
  return null;
}
async function workspaceProof(project, task) {
  if (!await project.inputWorkspaceClean(task)) return false;
  const record = project.store.branch(task.branch);
  if (task.status === 'completed' && !task.workspace && ['archived','deleted'].includes(record?.status))
    return Boolean(project.store.get("SELECT id FROM events WHERE task_id=? AND type='task.accepted' LIMIT 1", task.id));
  try {
    const branch = await project.workspaces.branchState(task.branch);
    return branch.child_head === task.head_commit && branch.blockers.every(blocker => blocker === `task:#${task.id}`);
  } catch { return false; }
}
function validateGraph(project, sourceId, conditions) {
  const rows = project.store.all("SELECT * FROM tasks WHERE task_kind IN ('order','child','main','owner') ORDER BY id");
  check(rows.length <= 10000, 'merge dependency graph exceeds safety limit');
  const settled = taskId => `${taskId}:settled`, merged = taskId => `${taskId}:merged`;
  const edges = new Map(rows.flatMap(task => [[settled(task.id), new Set()], [merged(task.id), new Set([settled(task.id)])]]));
  for (const task of rows) {
    // Readiness is independent of this Worker's own conditional merge. Parent
    // closure, however, waits for active children to deliver, not just return.
    if (task.parent_id && !TERMINAL.has(task.status)) edges.get(settled(task.parent_id))?.add(merged(task.id));
    for (const dep of project.store.deps(task.id).filter(edge => edge.kind === 'code')) edges.get(merged(task.id)).add(merged(dep.depends_on));
    const state = stateOf(task);
    const configured = task.id === sourceId ? conditions : active(state) ? state.conditions : [];
    for (const condition of configured) edges.get(merged(task.id)).add(
      condition.kind === 'worker_settled' ? settled(condition.worker_id) : merged(condition.worker_id));
  }
  // Iterative DFS keeps the bounded graph safe even for long dependency chains.
  const visiting = new Set(), visited = new Set(), stack = [[merged(sourceId), false]];
  while (stack.length) {
    const [node, leaving] = stack.pop();
    if (leaving) { visiting.delete(node); visited.add(node); continue; }
    if (visiting.has(node)) throw new MergeConditionCycleError();
    if (visited.has(node)) continue;
    visiting.add(node); stack.push([node, true]);
    for (const next of edges.get(node) ?? []) stack.push([next, false]);
  }
}

export default {
  taskMergeConditions(taskId) {
    const task = this.store.task(id(taskId)), state = stateOf(task);
    check(['order','child'].includes(task.task_kind), 'merge conditions require an order/child Worker');
    const reason = this.mergeConditionsWaitReason(task);
    return { version: 1, worker_id: task.id, worker_number: task.worker_number ?? null, revision: revision(this, task),
      round: state?.round ?? mergeConditionRound(this, task.id), state: !state ? 'idle' : state.state === 'consumed' ? 'consumed'
        : mergeConditionRound(this, task.id) !== state.round || state.conditions.some(c => mergeConditionRound(this, c.worker_id) !== c.round) ? 'stale'
          : reason ? 'waiting' : 'ready', reason,
      conditions: (state?.conditions ?? []).map(condition => ({ ...condition,
        worker_number: this.store.get('SELECT worker_number FROM tasks WHERE id=?', condition.worker_id)?.worker_number ?? null,
        satisfied: Boolean(condition.evidence) && !this.mergeConditionEvidenceReason(condition) })),
      ...(state?.delivery_event_id ? { delivery_event_id: state.delivery_event_id } : {}) };
  },

  mergeTaskAfter(taskId, rawConditions, expectedRevision) {
    this.assertWritable('configure conditional merge');
    const conditions = normalizeMergeConditions(rawConditions), task = this.store.task(id(taskId));
    const prior = stateOf(task);
    check(typeof expectedRevision === 'string' && expectedRevision.length > 0, 'merge conditions revision is required');
    // Exact lost-ACK retry is not a new authorization or an edit of a fixed attempt.
    if (prior?.request_revision === expectedRevision) {
      check(JSON.stringify(definition(prior)) === JSON.stringify(conditions), 'merge conditions revision was used for different conditions');
      return this.taskMergeConditions(task.id);
    }
    check(revision(this, task) === expectedRevision, 'merge conditions revision changed; reload before configuring');
    check(['order','child'].includes(task.task_kind) && !TERMINAL.has(task.status) && task.status !== 'awaiting_acceptance', 'Worker has ended or this round was delivered');
    check(!this.store.executionRetired(task.id), 'Worker execution environment retired');
    const request = booking(task);
    check(!request || request.version === 2 && request.status === 'pending' && !request.attempt_id && !request.delivery_id,
      'merge conditions cannot change a fixed/requested/executing/resolving/blocked/suspended delivery');
    assertTaskAncestorsOpen(this, task); assertTaskNotSyncing(this, task.id); assertTaskNoCommand(this, task.id);
    check(!this.taskMergeOperation(task)?.state || ['integrated','withdrawn','stale'].includes(this.taskMergeOperation(task).state), 'Worker is part of a fixed integration');
    for (const condition of conditions) {
      check(condition.worker_id !== task.id, 'merge conditions cannot depend on self');
      const other = this.store.task(condition.worker_id);
      check(['order','child'].includes(other.task_kind) && !['failed','cancelled'].includes(other.status)
        && !this.store.executionRetired(other.id), 'condition requires a non-failed development Worker');
      check(!this.taskInputQueue(other).buffered, 'condition Worker has buffered future input; wait for its admitted round before configuring');
    }
    validateGraph(this, task.id, conditions);
    this.store.transaction(() => {
      const registration = systemRegistration(this, 'system:merge-conditions');
      const configId = this.store.event(task.id, 'merge.conditions_configured', { conditions, round: mergeConditionRound(this, task.id) });
      save(this, task.id, { version: 1, id: configId, ...registration, request_revision: expectedRevision,
        round: mergeConditionRound(this, task.id), state: 'waiting', conditions: conditions.map(condition => ({ ...condition,
          round: mergeConditionRound(this, condition.worker_id), parent_id: this.store.task(condition.worker_id).parent_id, evidence: null })) });
      // Explicit one-shot authorization, independent of the child's locked persistent Hook.
      this.store.update(task.id, { reservation: JSON.stringify({ ...(request ?? { version: 2, kind: 'merge', created_at: new Date().toISOString() }),
        auto_merge: false, status: 'pending' }) });
      this.ensureMergeRequestOperation(task.id);
    });
    this.scheduleMergeConditions();
    return this.taskMergeConditions(task.id);
  },

  mergeConditionEvidenceReason(condition) {
    const task = this.store.get('SELECT * FROM tasks WHERE id=?', condition.worker_id);
    const reason = settledReason(this, task, condition.round);
    if (reason) return reason;
    const proof = condition.evidence;
    if (!proof || task.head_commit !== proof.head_commit || task.parent_id !== condition.parent_id) return `${workerLabel(task)} 等待本轮精确证据`;
    if (condition.kind === 'worker_merged' && (proof.parent_id !== task.parent_id || !proof.commit)) return `${workerLabel(task)} 尚未确实合入直接父 Worker`;
    return null;
  },

  mergeConditionsWaitReason(task) {
    const state = stateOf(task);
    if (!active(state)) return null;
    if (mergeConditionRound(this, task.id) !== state.round) return '条件合并源 Worker 轮次已过期；请重新配置';
    for (const condition of state.conditions) {
      const reason = this.mergeConditionEvidenceReason(condition);
      if (reason) return `条件合并等待：${reason}`;
    }
    return state.state === 'ready' ? null : '等待本轮合并条件全部满足（AND）';
  },

  /** Fresh Git proof; callers repeat the synchronous gate after every await and in apply guards. */
  async refreshMergeConditions(taskId) {
    let task = this.store.task(taskId), state = stateOf(task);
    if (!active(state)) return true;
    const configId = state.id;
    const observed = [];
    for (const condition of state.conditions) {
      const other = this.store.get('SELECT * FROM tasks WHERE id=?', condition.worker_id);
      let evidence = null;
      if (!settledReason(this, other, condition.round) && other.parent_id === condition.parent_id
        && await workspaceProof(this, other)) {
        const eventId = settledEvent(this, other, condition.round);
        if (condition.kind === 'worker_settled') evidence = { event_id: eventId, head_commit: other.head_commit };
        else {
          const event = this.store.get("SELECT id,data FROM events WHERE task_id=? AND type='task.merge_integrated' AND id>? ORDER BY id DESC LIMIT 1", other.id, condition.round);
          const receipt = event && JSON.parse(event.data), parent = this.store.get('SELECT * FROM tasks WHERE id=?', condition.parent_id);
          if (receipt?.parent_id === parent?.id && receipt?.source_commit === other.head_commit && receipt.commit && parent?.branch) {
            const head = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${parent.branch}^{commit}`).catch(() => null);
            if (head && await this.workspaces.isAncestor(this.config.project, receipt.commit, head))
              evidence = { event_id: event.id, head_commit: other.head_commit, parent_id: parent.id, commit: receipt.commit, parent_head: head };
          }
        }
      }
      // Git awaits cannot latch a new round, new input, changed source or failure.
      const live = this.store.get('SELECT * FROM tasks WHERE id=?', condition.worker_id);
      if (!live || settledReason(this, live, condition.round) || live.head_commit !== other?.head_commit || live.parent_id !== condition.parent_id) evidence = null;
      observed.push({ ...condition, evidence });
    }
    task = this.store.task(taskId); state = stateOf(task);
    if (!active(state) || state.id !== configId) return false;
    // Recheck ALL operands together: an earlier operand may change during a later one's Git wait.
    for (const condition of observed) if (this.mergeConditionEvidenceReason(condition)) condition.evidence = null;
    const ready = mergeConditionRound(this, taskId) === state.round && observed.every(condition => condition.evidence);
    const next = { ...state, conditions: observed, state: ready ? 'ready' : 'waiting' };
    if (JSON.stringify(next) !== JSON.stringify(state)) save(this, taskId, next);
    return ready && !this.mergeConditionsWaitReason(this.store.task(taskId));
  },

  pinMergeConditionEvidence(taskId) {
    const task = this.store.task(taskId), state = stateOf(task);
    if (!active(state)) return null;
    check(!this.mergeConditionsWaitReason(task), 'merge conditions changed before pinning publication evidence');
    return structuredClone({ id: state.id, round: state.round, conditions: state.conditions });
  },

  assertMergeConditionPublicationEvidence(taskId, pinned) {
    const state = stateOf(this.store.task(taskId));
    if (!active(state)) return;
    check(pinned?.id === state.id && pinned.round === state.round && pinned.conditions?.length === state.conditions.length,
      'exact landing lacks its pinned merge condition evidence');
    for (let index = 0; index < pinned.conditions.length; index++) {
      const condition = pinned.conditions[index], configured = state.conditions[index], proof = condition.evidence;
      check(condition.kind === configured.kind && condition.worker_id === configured.worker_id && condition.round === configured.round
        && condition.parent_id === configured.parent_id && proof?.event_id > condition.round, 'pinned condition identity changed');
      const event = this.store.get('SELECT type,data FROM events WHERE id=? AND task_id=?', proof.event_id, condition.worker_id);
      const data = event && JSON.parse(event.data);
      check(event && ['task.idle','task.delivered','task.merge_integrated'].includes(event.type)
        && (data.source_commit ?? data.head_commit ?? data.commit) === proof.head_commit, 'pinned condition success receipt is missing');
      if (event.type === 'task.idle') check(this.store.get("SELECT id FROM agent_runs WHERE id=? AND task_id=? AND status='completed'", data.run_id, condition.worker_id), 'pinned idle is not a successful Run');
      if (condition.kind === 'worker_merged') check(event.type === 'task.merge_integrated' && data.parent_id === condition.parent_id
        && proof.parent_id === data.parent_id && proof.commit === data.commit, 'pinned direct-parent merge receipt changed');
    }
  },

  consumeMergeConditions(taskId, eventId, pinned = null) {
    const state = stateOf(this.store.task(taskId));
    if (!active(state)) return;
    if (pinned) this.assertMergeConditionPublicationEvidence(taskId, pinned);
    save(this, taskId, { ...state, ...(pinned ? { conditions: pinned.conditions } : {}), state: 'consumed', delivery_event_id: eventId });
    this.store.event(taskId, 'merge.conditions_consumed', { configuration_id: state.id, source_event_id: eventId });
  },

  scheduleMergeConditions() { this.runtimeCoordinator.request('merge_conditions'); },

  async drainMergeConditions() {
    if (this.stopping || this.maintenancePaused() || this.clearing || this.workerDeleteIds?.size) return;
    const rows = this.store.all(`SELECT id FROM tasks WHERE json_valid(auto_merge)
      AND json_extract(auto_merge,'$.merge_conditions.state') IN ('waiting','ready') ORDER BY id`);
    for (const { id: taskId } of rows) {
      const before = JSON.stringify(stateOf(this.store.task(taskId)));
      const ready = await this.refreshMergeConditions(taskId), task = this.store.task(taskId), request = booking(task);
      if (ready && request?.status === 'pending' && !this.reservationWaitReason(task)) await this.settleQueuedMerge(taskId);
      else if (request?.parent_id && ['requested','executing','resolving','blocked'].includes(request.status)
        && before !== JSON.stringify(stateOf(task))) this.scheduleTaskMerge(request.parent_id);
      // Only a proof transition wakes a fixed queue. Waiting checks must never self-schedule.
    }
  },
};
