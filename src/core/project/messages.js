import { check, id, text, TERMINAL, isPlainObject, isSettled } from '../types.js';
import { questionnaire, questionnaireAnswer } from '../questionnaire.js';
import { NOTICE_SELECT } from '../../persistence/notice-projection.js';
import { decideTaskInput } from '../task-input-rule.js';
import { workerLabel } from '../worker-number.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing, consumeIntegratedReservation, resumeTaskDelivery } from './iteration.js';

/** Internal shared settlement; provenance is chosen by the runtime, never by RPC input. */
export function settleNoticeAnswer(project, noticeId, answer, dismiss = false, source = 'user') {
  check(['user', 'lush'].includes(source), 'invalid answer source');
  const notice = project.store.get('SELECT * FROM notices WHERE id=?', id(noticeId));
  check(notice && notice.status === 'open', 'notice is not open');
  check(notice.kind !== 'plan', `notice ${notice.id} is a plan approval; use lush plan approve|reject ${notice.task_id}`);
  if (!dismiss) {
    if (notice.kind === 'questionnaire') answer = questionnaireAnswer(notice.body, answer);
    else text(answer, 'answer');
  }
  const stored = typeof answer === 'string' ? answer : JSON.stringify(answer);
  project.store.transaction(() => {
    project.store.run('UPDATE notices SET status=?,answer=?,answer_source=? WHERE id=?', dismiss ? 'dismissed' : 'answered', stored || '', source, notice.id);
    project.store.message(notice.task_id, JSON.stringify({ notice_id: notice.id, title: notice.title, dismissed: dismiss,
      answer: answer || '', answer_source: source,
      ...(source === 'lush' ? { automatic: true, instruction: '此答复由 Lush 自动选择 Hook 生成，不是用户亲自决断；多选或文字答复授权 Agent 自行判断并继续。' } : {}) }));
    project.store.event(notice.task_id, 'notice.answered', { notice_id: notice.id, answer, dismiss, answer_source: source });
  });
  const owner = project.store.task(notice.task_id);
  if (dismiss && owner.agent_wakes === 0 && owner.resolves_task_id) project.cancel(owner.id, `user dismissed notice ${notice.id}: ${notice.title}`);
  else project.wake(notice.task_id);
  project.scheduleTaskHooks();
  return project.store.get(`${NOTICE_SELECT} WHERE id=?`, notice.id);
}

/** 收件箱、notice、答复。 */
export default {
  message(taskId, body, sender = null) {
    const target = this.store.task(taskId); text(body, 'message');
    assertTaskNotSyncing(this, target.id);
    check(!['main','owner'].includes(target.task_kind), 'branch owner Worker is not an unrestricted Agent inbox; use an approved merge request');
    check(!TERMINAL.has(target.status), 'worker has ended; explicitly reopen a completed Worker or retry failed work');
    assertTaskAncestorsOpen(this, target);
    check(!target.branch || this.store.branch(target.branch)?.status === 'active', 'archived Workers cannot receive new work');
    if (target.reservation) {
      const booking = JSON.parse(target.reservation);
      check(!(booking.version === 2 && ['requested','executing','blocked'].includes(booking.status)),
        'Worker is frozen for merge; wait for integration or divergence repair before messaging it');
    }
    if (sender !== null) {
      const from = this.store.task(sender);
      check(target.parent_id === from.id || from.parent_id === target.id, 'agents may message only a direct parent or child');
    }
    // Rules are frozen when a order Task is created. Failure is visible, but never discards the input.
    let decision = { delivery: 'message', source: 'agent' }, ruleError = null;
    if (sender === null && ['order', 'child'].includes(target.task_kind)) {
      try { decision = decideTaskInput(this.config.home, target, body); }
      catch (error) { ruleError = error.message; decision = { delivery: 'interrupt', source: 'fallback' }; }
    } else if (sender === null) decision = { delivery: 'interrupt', source: 'default' };
    this.store.transaction(() => {
      // No delivery mutation (including consuming repair signals) before all sender/target admission checks.
      const booking = target.reservation ? JSON.parse(target.reservation) : null;
      if (booking?.version === 2 && booking.status === 'resolving') this.suspendTaskMerge(target.id, '源侧修复收到追加输入');
      if (booking?.version === 2 && ['resolving','suspended'].includes(booking.status)) this.resumeQueuedTaskMerge(target.id);
      if (sender === null) resumeTaskDelivery(this, target.id, 'new user input');
      consumeIntegratedReservation(this, target, 'new input');
      const messageId = this.store.message(target.id, body, sender);
      this.store.event(target.id, 'message', { sender, body, message_id: messageId });
      if (sender === null) this.store.event(target.id, 'task.input_routed', { delivery: decision.delivery,
        source: decision.source, error: ruleError });
    });
    // Soft preemption only at a backend-attested safe point; otherwise deliver at the end of the turn.
    if (sender === null && decision.delivery === 'interrupt') this.requestPreempt(target.id, 'user message');
    this.wake(target.id); return this.store.task(target.id);
  },

  /** Runtime-only: commit a typed child→parent signal once, then wake the parent. */
  sendTaskSignal(sourceId, targetId, type, key, payload = {}) {
    const source = this.store.task(sourceId), target = this.store.task(targetId);
    check(source.parent_id === target.id, 'worker signals must go from a child to its direct parent');
    check(!['main','owner'].includes(target.task_kind), 'branch owner only receives pinned reserved merge requests');
    check(!TERMINAL.has(target.status), 'a terminal parent cannot receive a new signal');
    check(typeof type === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(type), 'invalid worker signal type');
    check(typeof key === 'string' && key.length > 0 && key.length <= 128 && !/\s/u.test(key), 'invalid worker signal key');
    check(isPlainObject(payload), 'worker signal payload must be an object');
    check(Buffer.byteLength(JSON.stringify(payload)) <= 16384, 'worker signal payload exceeds 16384 bytes');
    const body = JSON.stringify({ version: 1, signal: type, key, source_task_id: source.id,
      target_task_id: target.id, payload });
    const signal = this.store.transaction(() => {
      const row = this.store.signal(target.id, source.id, type, key, body);
      if (row.inserted) this.store.event(target.id, 'task.signal', { message_id: row.id,
        source_task_id: source.id, signal: type, key });
      return row;
    });
    if (signal.inserted) this.wake(target.id);
    return signal;
  },

  notice(taskId, title, body = '', kind = 'question', questions = undefined) {
    const task = this.store.task(taskId); text(title, 'title');
    check(typeof body === 'string' && body.length <= 32000, 'invalid notice body');
    check(['question','plan'].includes(kind), 'notice kind must be question or plan');
    check(!TERMINAL.has(task.status), 'worker has ended');
    if (questions !== undefined) {
      check(kind === 'question', 'a plan cannot contain a questionnaire');
      check(!this.questionPending(task.id), 'worker already has an open questionnaire');
      body = questionnaire(body, questions); kind = 'questionnaire';
    }
    const noticeId = this.store.transaction(() => {
      const row = this.store.run('INSERT INTO notices(task_id,title,body,kind) VALUES (?,?,?,?)', task.id, title, body, kind);
      const noticeId = Number(row.lastInsertRowid);
      this.store.event(task.id, 'notice.opened', { notice_id: noticeId, title, kind });
      if (kind === 'questionnaire') {
        this.prepareChoiceSnapshot(noticeId, task);
        this.parkForQuestion(task.id, noticeId);
      }
      this.autoAnswerNotice(noticeId);
      return noticeId;
    });
    // This is a deliberate suspension, not a timeout/failure. Persist before stopping the process.
    if (kind === 'questionnaire') this.running.get(task.id)?.controller.abort();
    this.scheduleTaskHooks();
    return this.store.get(`${NOTICE_SELECT} WHERE id=?`, noticeId);
  },

  /**
   * 纯提醒：结算时告知「这一时刻、这条分支发生了什么」，不需要用户回复。
   * 落库固定 kind='info' / status='sent'（不是 open），因此不进任何「待决」口径，
   * 也不会让任务停在 awaiting；answer / dismiss 会因为 status 不是 open 而拒绝它。
   * 允许在终态任务上写：这条提醒本来就是结算的产物，结算之后任务不能再被唤醒。
   */
  notify(taskId, title, body = '') {
    const task = this.store.task(taskId); text(title, 'title');
    check(typeof body === 'string' && body.length <= 32000, 'invalid notice body');
    const row = this.store.run("INSERT INTO notices(task_id,title,body,kind,status) VALUES (?,?,?,'info','sent')", task.id, title, body);
    this.store.event(task.id, 'notice.opened', { notice_id: Number(row.lastInsertRowid), title, kind: 'info' });
    return this.store.get(`${NOTICE_SELECT} WHERE id=?`, Number(row.lastInsertRowid));
  },

  /** Built-in lifecycle hook. Caller commits Task state, source Event and Notice together. */
  notifyTaskLifecycle(taskId, sourceEventId) {
    const task = this.store.task(taskId);
    if (!['order','analysis'].includes(task.task_kind)) return null;
    const event = this.store.get('SELECT * FROM events WHERE id=? AND task_id=?', id(sourceEventId), task.id);
    check(event, 'lifecycle source event does not belong to this Worker');
    const failed = task.status === 'failed' && ['failed','merge.repair_interrupted','analysis.fork_failed'].includes(event.type);
    const idle = event.type === 'task.idle' && ['waiting','awaiting_acceptance'].includes(task.status);
    const analyzed = task.task_kind === 'analysis' && task.status === 'completed' && event.type === 'completed';
    if (!failed && !idle && !analyzed) return null;
    // A configured automatic stage records success, but only its next manual stage reminds.
    if (idle && this.autoCompletionView(task)?.level !== 'off' && this.autoCompletionView(task)) return null;
    if (!failed && (this.hasActionableMessages(task.id)
      || this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open' LIMIT 1", task.id)
      || this.store.children(task.id).some(child => !isSettled(child)))) return null;
    const existing = this.store.get(`${NOTICE_SELECT} WHERE source_event_id=?`, event.id);
    if (existing) return existing;
    const goal = String(task.goal ?? '').trim().split('\n')[0].slice(0, 100);
    const title = `${task.task_kind === 'analysis' ? '分析' : 'Worker'} ${workerLabel(task)} ${failed ? '异常停止' : analyzed ? '已完成' : '本轮已结束'}：${goal}`;
    const body = [
      failed ? `Worker 异常停止：${String(task.error ?? '没有记录到原因').slice(0, 1200)}`
        : analyzed ? '只读分析已完成，没有分支改动。'
          : '本轮工作已收尾，现已静息，等待合并、验收或进一步指示；这不代表 Worker 已验收完成。',
      task.branch ? `分支：${task.branch}\n父分支：${task.target_branch ?? '（未记录）'}`
        : `分析分支：${task.target_branch ?? '（未记录）'}`,
      task.task_kind === 'analysis' ? '' : task.integration === 'merged'
        ? 'integration：已合入父分支。' : '尚未记录已合入父分支；实际交付状态见 Worker 详情。',
      task.result ? `${analyzed ? '结论' : '本轮结果'}：${String(task.result).slice(0, 1200)}` : '',
      `打开 Worker ${workerLabel(task)} 查看详情。此告知无需答复，不会批准合并、验收或自动重试。`,
    ].filter(Boolean).join('\n');
    const row = this.store.run(`INSERT INTO notices(task_id,title,body,kind,status,source_event_id)
      VALUES (?,?,?,'info','sent',?)`, task.id, title, body, event.id);
    const noticeId = Number(row.lastInsertRowid);
    this.store.event(task.id, 'notice.opened', { notice_id: noticeId, title, kind: 'info', source_event_id: event.id });
    return this.store.get(`${NOTICE_SELECT} WHERE id=?`, noticeId);
  },

  /** User acknowledgement is independent of decisions and never wakes the Agent. */
  readNotice(noticeId) {
    const notice = this.store.get('SELECT * FROM notices WHERE id=?', id(noticeId));
    check(notice && notice.kind === 'info' && notice.status === 'sent', 'only sent info notices can be marked read');
    this.store.transaction(() => {
      const changed = this.store.run("UPDATE notices SET read_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND read_at IS NULL", notice.id);
      if (changed.changes) this.store.event(notice.task_id, 'notice.read', { notice_id: notice.id });
    });
    return this.store.get(`${NOTICE_SELECT} WHERE id=?`, notice.id);
  },

  answer(noticeId, answer, dismiss = false) {
    return settleNoticeAnswer(this, noticeId, answer, dismiss, 'user');
  }
};
