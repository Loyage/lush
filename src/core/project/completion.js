import { randomUUID } from 'node:crypto';
import { check, id, TERMINAL } from '../types.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing, taskSyncDeliveryPaused } from './iteration.js';

const LEVELS = ['off', 'merge', 'accept', 'archive'];
const rank = level => LEVELS.indexOf(level);
const settings = task => task.auto_merge ? JSON.parse(task.auto_merge) : { version: 1, enabled: false, locked: false };
const booking = task => task.reservation ? JSON.parse(task.reservation) : null;
const levelOf = task => { const value = settings(task); return value.enabled ? LEVELS.includes(value.level) && value.level !== 'off' ? value.level : 'merge' : 'off'; };
const now = () => new Date().toISOString();
const ERROR = {
  merge: '自动合并暂不能继续；请查看交付诊断，处理现场或显式恢复。',
  accept: '自动验收未通过安全检查；请检查未读输入、待决、后代、同步及 Git 交付现场，未自动重试。',
  archive: '自动归档未完成；工作区或部分分支可能仍保留，请检查归档记录并显式处理，未自动重试。',
  unknown: '后台中断，自动动作结果未知；保留现场，禁止自动重放，请检查执行与归档记录。',
};
function round(project, taskId) {
  return project.store.get("SELECT max(id) AS id FROM events WHERE task_id=? AND type IN ('task.iteration_started','task.reopened','retry')", taskId)?.id ?? 0;
}
function state(project, task) {
  const value = settings(task), current = round(project, task.id);
  return value.completion?.round === current ? value.completion : { authorization: value.completion?.authorization ?? null, round: current, executions: {}, notices: {} };
}
function persist(project, taskId, data) {
  const current = settings(project.store.task(taskId));
  project.store.update(taskId, { auto_merge: JSON.stringify({ ...current, completion: data }) });
}
function phaseOf(task) { return task.status === 'completed' ? 'archive' : task.status === 'awaiting_acceptance' || booking(task)?.status === 'integrated' ? 'accept' : 'merge'; }
function accepted(project, task) { return project.store.get("SELECT id,data FROM events WHERE task_id=? AND type='task.accepted' ORDER BY id DESC LIMIT 1", task.id); }
function publicExecution(value) {
  if (!value) return null;
  return { id: value.id, phase: value.phase, status: value.status, created_at: value.created_at, finished_at: value.finished_at ?? null,
    ...(typeof value.no_changes === 'boolean' ? { no_changes: value.no_changes } : {}),
    ...(value.error ? { error: value.error } : {}) };
}
function acceptanceProof(project, task, receipt) {
  if (task.status !== 'completed' || task.head_commit !== receipt.head_commit) return null;
  return project.store.get("SELECT id FROM events WHERE task_id=? AND type='task.accepted' AND json_extract(data,'$.completion_execution')=? AND json_extract(data,'$.authorization')=? AND json_extract(data,'$.round')=? AND json_extract(data,'$.head_commit')=?", task.id, receipt.id, receipt.authorization, receipt.round, receipt.head_commit);
}
function archiveProof(project, task, receipt) {
  if (task.status !== 'completed' || task.head_commit !== receipt.head_commit || project.store.branch(task.branch)?.status !== 'archived') return null;
  const event = project.store.get("SELECT id,data FROM events WHERE task_id=? AND type='branch.archive' AND json_extract(data,'$.completion_execution')=? AND json_extract(data,'$.authorization')=? AND json_extract(data,'$.round')=? AND json_extract(data,'$.branch')=? AND json_array_length(json_extract(data,'$.failed'))=0 AND json_array_length(json_extract(data,'$.remaining'))=0", task.id, receipt.id, receipt.authorization, receipt.round, task.branch);
  if (!event) return null;
  const summary = JSON.parse(event.data);
  return summary.completed?.includes(task.branch) && summary.completed.every(branch => project.store.branch(branch)?.status === 'archived') ? event : null;
}

/** User-authorized completion, separate from the parent's merge and custom Hook queues. */
export default {
  autoCompletionView(task) {
    if (!this.autoMergeView(task)) return null;
    const config = settings(task), level = levelOf(task), data = state(this, task), phase = phaseOf(task);
    const record = data.executions?.[phase], last = Object.values(data.executions ?? {}).at(-1) ?? null;
    let reason = null;
    if (['failed', 'cancelled'].includes(task.status)) reason = 'Worker 已结束，不能配置自动链';
    else if (task.branch && ['archived', 'deleted'].includes(this.store.branch(task.branch)?.status)) reason = 'Worker 已归档或回收';
    else if (['requested', 'executing', 'resolving', 'blocked', 'suspended'].includes(booking(task)?.status)) reason = '交付请求已冻结或挂起，不能调整当前自动链';
    else if (this.completionBusy?.has(task.id) || Object.values(data.executions ?? {}).some(row => row.status === 'running')) reason = '自动动作已领取执行，不能调整';
    else if (this.taskSyncBusy?.has(task.id) || taskSyncDeliveryPaused(this, task.id)) reason = '父同步正在执行或交付已暂停';
    else if (Object.values(data.executions ?? {}).some(row => row.status === 'unknown')) reason = '自动动作结果未知；检查现场后显式处理，不能重放';
    else if (task.status === 'completed' && !accepted(this, task)) reason = '历史结算不是验收事实，不能自动归档';
    const frozen = task.branch && this.branchFreeze(task.branch);
    if (!reason && frozen) reason = 'Worker 分支正在冻结，不能调整自动链';
    const receipt = booking(task);
    const status = record?.status ?? (level === 'off' ? 'idle' : phase === 'archive' && rank(level) >= 3 && this.store.branch(task.branch)?.status === 'archived' ? 'succeeded' : 'waiting');
    return { level, min_level: config.locked ? 'merge' : 'off', locked: config.locked === true,
      editable: !reason, reason, phase: level === 'off' ? null : phase,
      state: receipt?.status === 'blocked' ? 'unknown' : status, last_execution: publicExecution(last) };
  },

  async setTaskCompletion(taskId, level, expectedRevision) {
    this.assertWritable('configure completion Hooks');
    check(LEVELS.includes(level), 'completion level must be off, merge, accept or archive');
    const task = this.store.task(id(taskId)), view = this.autoCompletionView(task);
    check(view, 'only version 2 order/child Workers support completion Hooks');
    check(typeof expectedRevision === 'string' && this.taskHooks(task.id).revision === expectedRevision, 'Hook revision changed; reload before editing');
    check(view.editable, view.reason);
    check(rank(level) >= rank(view.min_level), '父Worker派生的子Worker至少自动合并，不能关闭');
    assertTaskAncestorsOpen(this, task); assertTaskNotSyncing(this, task.id);
    if (task.status === 'awaiting_acceptance' || task.status === 'completed')
      check(rank(level) >= rank(view.level), 'delivered Workers may only raise the completion level');
    if (level === view.level) return this.taskHooks(task.id);
    this.store.transaction(() => {
      const config = settings(task), data = state(this, task);
      // A higher level is fresh explicit authorization. Unknown effects cannot get here.
      const next = { ...data, authorization: randomUUID() };
      this.store.update(task.id, { auto_merge: JSON.stringify({ ...config, enabled: level !== 'off', level, completion: next }) });
      this.store.event(task.id, 'task.completion_changed', { level, previous: view.level, authorization: next.authorization });
      const intent = booking(task);
      if (level === 'off' && intent?.status === 'pending' && intent.auto_merge) {
        this.store.update(task.id, { reservation: null });
        this.store.event(task.id, 'task.unreserved', { reservation: intent, reason: 'completion disabled' });
      }
      if (level !== 'off') this.armTaskAutoMerge(task.id);
    });
    this.scheduleTaskCompletion(task.id);
    if (level !== 'off') await this.settleQueuedMerge(task.id).catch(() => {
      this.noteCompletionMergeFailure(task.id);
    });
    return this.taskHooks(task.id);
  },

  /** Read-only latest per-stage projection for the three built-in mounts. */
  completionMountState(task, phase) {
    const data = state(this, task), record = data.executions?.[phase];
    if (record) return { state: record.status, last_execution: publicExecution(record), reason: record.error ?? null };
    const before = LEVELS.indexOf(phase), current = LEVELS.indexOf(phaseOf(task));
    const done = current > before || (phase === 'archive' && this.store.branch(task.branch)?.status === 'archived');
    return { state: done ? 'succeeded' : rank(levelOf(task)) >= before ? 'waiting' : 'idle', last_execution: null, reason: null };
  },

  /** Durable reminder identity; successes in configured automatic stages never notify. */
  completionNotice(taskId, stage, body) {
    const task = this.store.task(taskId);
    if (levelOf(task) === 'off' || (task.task_kind === 'child' && !settings(task).level)) return null;
    return this.store.transaction(() => {
      const data = state(this, task), key = `${data.authorization ?? 'legacy'}:${stage}`;
      data.notices ??= {};
      if (data.notices[key]) return this.store.get('SELECT * FROM notices WHERE id=?', data.notices[key]);
      const label = task.worker_number ?? `#${task.id}`;
      const notice = this.notify(task.id, `Worker ${label} · ${stage === 'accept' ? '待验收' : stage === 'archive' ? '待归档' : '自动处理受阻'}`, body);
      data.notices[key] = notice.id;
      // Only four stage reminders are relevant to an authorization. Keep history in Events, not unbounded JSON.
      const keys = Object.keys(data.notices); for (const old of keys.slice(0, Math.max(0, keys.length - 8))) delete data.notices[old];
      persist(this, task.id, data);
      this.store.event(task.id, 'completion.reminder', { notice_id: notice.id, stage, round: data.round, authorization: data.authorization });
      return notice;
    });
  },

  scheduleTaskCompletion(taskId = null) {
    if (this.stopping || this.clearing || this.workerDeleteIds?.size || this.recoveringHooks) return;
    const rows = taskId === null ? this.store.all("SELECT * FROM tasks WHERE auto_merge IS NOT NULL AND task_kind IN ('order','child') AND status IN ('waiting','awaiting_acceptance','completed') ORDER BY id") : [this.store.task(taskId)];
    this.completionQueued ??= new Set();
    for (const task of rows) {
      try { if (!this.autoMergeView(task) || levelOf(task) === 'off' || this.completionQueued.has(task.id)) continue; }
      catch { continue; } // Corrupt historical configuration cannot stop scheduling unrelated Workers.
      // Merge is already driven by its own persistent queue; only diagnose a real stop or run its tail.
      const request = booking(task);
      if (phaseOf(task) === 'merge' && !['blocked','suspended'].includes(request?.status) && request?.blocked_code !== 'completion_failed') continue;
      const record = state(this, task).executions?.[phaseOf(task)];
      if (record && ['running', 'succeeded', 'failed', 'unknown'].includes(record.status)) continue;
      if (task.branch && ['archived','deleted'].includes(this.store.branch(task.branch)?.status)) continue;
      this.completionQueued.add(task.id);
      const job = (this.completionQueue ?? Promise.resolve()).then(async () => {
        if (!this.stopping) await this.write('run completion Hooks', () => this.runTaskCompletion(task.id));
      }).catch(() => {}).finally(() => { this.completionQueued.delete(task.id); });
      this.completionQueue = job;
    }
  },

  noteCompletionMergeFailure(taskId) {
    this.noteReservationBlocked(taskId, ERROR.merge, 'completion_failed');
    this.scheduleTaskCompletion(taskId);
  },

  recordCompletionDelivery(taskId, sourceId, noChanges = false) {
    const task = this.store.task(taskId); if (levelOf(task) === 'off') return;
    const data = state(this, task);
    data.executions ??= {};
    data.executions.merge = { id: sourceId, phase: 'merge', status: 'succeeded', round: data.round,
      head_commit: task.head_commit, no_changes: noChanges, created_at: now(), finished_at: now() };
    persist(this, taskId, data);
    this.scheduleTaskCompletion(taskId);
  },

  assertCompletionClaim(taskId, claim, phase) {
    const task = this.store.task(taskId), data = state(this, task), receipt = data.executions?.[phase];
    check(claim && data.authorization === claim.authorization && data.round === claim.round
      && receipt?.id === claim.id && receipt.status === 'running' && receipt.authorization === claim.authorization
      && receipt.round === claim.round && receipt.head_commit === claim.head_commit && task.head_commit === claim.head_commit
      && rank(levelOf(task)) >= rank(phase), 'completion authorization or result changed');
    check(!this.stopping && !this.running.has(task.id) && !this.taskSyncBusy?.has(task.id), 'completion invocation/sync still in flight or stopping');
    assertTaskAncestorsOpen(this, task);
    check(!taskSyncDeliveryPaused(this, task.id), 'completion paused by parent sync');
    return task;
  },

  async runTaskCompletion(taskId) {
    let task = this.store.task(taskId), level = levelOf(task), phase = phaseOf(task);
    if (!this.autoMergeView(task) || level === 'off' || this.stopping || this.running.has(task.id)) return;
    if (phase === 'merge') {
      const request = booking(task);
      if (['blocked', 'suspended'].includes(request?.status) || (request?.blocked_code === 'completion_failed'
        && task.status === 'waiting' && !this.reservationWaitReason(task))) this.completionNotice(task.id, 'blocked:merge', ERROR.merge);
      return;
    }
    if (task.status !== 'awaiting_acceptance' && task.status !== 'completed') return;
    if (phase === 'archive' && !accepted(this, task)) return;
    if (rank(level) < rank(phase)) {
      this.completionNotice(task.id, phase, phase === 'accept' ? '成果交付已收口，下一步请检查并验收；验收不等于质量保证。' : 'Worker 已验收，下一步可归档工作区；历史记录和会话保留。'); return;
    }
    let data = state(this, task);
    const previous = data.executions?.[phase];
    if (previous && ['running','succeeded','failed','unknown'].includes(previous.status)) return;
    check(data.authorization && settings(task).level, 'automatic acceptance/archive requires explicit user authorization');
    if (this.taskMergeBusy?.has(task.parent_id) || this.activeTaskMerge(task.parent_id)) return; // release parent ownership first
    if (this.subtreeTasks(task.id).some(row => this.running.has(row.id))) return;
    this.completionBusy ??= new Set(); this.completionBusy.add(task.id);
    const receipt = this.store.transaction(() => {
      const execution = { id: this.store.event(task.id, 'completion.execution_started', { phase, round: data.round, authorization: data.authorization, head_commit: task.head_commit }),
        phase, round: data.round, authorization: data.authorization, head_commit: task.head_commit, status: 'running', created_at: now(), finished_at: null };
      data.executions ??= {}; data.executions[phase] = execution; persist(this, task.id, data); return execution;
    });
    let status = 'succeeded', error = null, superseded = false;
    try {
      this.assertCompletionClaim(task.id, receipt, phase);
      if (phase === 'accept') await this.acceptTask(task.id, null, { completion: receipt });
      else {
        const result = await this.archiveBranch(task.branch, { completion: receipt });
        if (result.failed.length || result.remaining.length) { status = 'unknown'; error = ERROR.archive; }
      }
    } catch {
      // An acceptance transaction is an exact proof; a thrown callback must not repeat it.
      const proof = phase === 'accept' && acceptanceProof(this, this.store.task(task.id), receipt);
      const current = state(this, this.store.task(task.id));
      superseded = !proof && phase === 'accept' && (current.round !== receipt.round || current.authorization !== receipt.authorization);
      if (!proof) { status = phase === 'archive' && this.store.task(task.id).workspace !== task.workspace ? 'unknown' : 'failed'; error = superseded ? null : ERROR[phase]; }
    } finally {
      this.store.transaction(() => {
        const live = state(this, this.store.task(task.id));
        if (superseded) this.store.event(task.id, 'completion.execution_superseded', { phase, execution_id: receipt.id, round: receipt.round });
        else if (live.executions?.[phase]?.id === receipt.id) {
          Object.assign(live.executions[phase], { status, finished_at: now(), ...(error ? { error } : {}) }); persist(this, task.id, live);
          this.store.event(task.id, `completion.execution_${status}`, { phase, execution_id: receipt.id, round: receipt.round, authorization: receipt.authorization, error });
        }
      });
      this.completionBusy.delete(task.id);
    }
    if (error) this.completionNotice(task.id, `blocked:${phase}`, error);
    else if (phase === 'accept') await this.runTaskCompletion(task.id); // archive or the final manual reminder, strictly after acceptance
  },

  recoverTaskCompletion() {
    for (const task of this.store.all("SELECT * FROM tasks WHERE auto_merge IS NOT NULL AND task_kind IN ('order','child')")) {
      let data;
      try { if (!this.autoMergeView(task)) continue; data = state(this, task); }
      catch { continue; } // Unknown stored authorization is never repaired or executed by guessing.
      for (const [phase, receipt] of Object.entries(data.executions ?? {})) if (receipt.status === 'running') {
        const proof = phase === 'accept' ? acceptanceProof(this, task, receipt) : phase === 'archive' ? archiveProof(this, task, receipt) : null;
        Object.assign(receipt, { status: proof ? 'succeeded' : 'unknown', finished_at: now(), ...(!proof ? { error: ERROR.unknown } : {}) });
        persist(this, task.id, data);
        this.store.event(task.id, `completion.execution_${receipt.status}`, { phase, execution_id: receipt.id, recovered: true });
        if (receipt.status === 'unknown') this.completionNotice(task.id, `unknown:${phase}`, ERROR.unknown);
      }
    }
    this.scheduleTaskCompletion();
  },
};
