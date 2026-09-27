import { check, id, text, TERMINAL, isPlainObject } from '../types.js';
import { questionnaire, questionnaireAnswer } from '../questionnaire.js';
import { decideAPInput } from '../ap-input-rule.js';

/** 收件箱、notice、答复。 */
export default {
  message(apId, body, sender = null) {
    const target = this.store.ap(apId); text(body, 'message');
    check(!['main','owner'].includes(target.ap_kind), 'branch owner AP is not an unrestricted Agent inbox; use an approved merge request');
    check(!TERMINAL.has(target.status), 'AP has ended; retry it or submit a new input');
    check(target.ap_kind !== 'say' || !target.reservation || JSON.parse(target.reservation).status !== 'started',
      'say AP has finished development and is presenting; submit a new say instead');
    if (sender !== null) {
      const from = this.store.ap(sender);
      check(target.parent_id === from.id || from.parent_id === target.id, 'agents may message only a direct parent or child');
    }
    // Rules are frozen when a say AP is created. Failure is visible, but never discards the input.
    let decision = { delivery: 'message', source: 'agent' }, ruleError = null;
    if (sender === null && ['say', 'child'].includes(target.ap_kind)) {
      try { decision = decideAPInput(this.config.home, target, body); }
      catch (error) { ruleError = error.message; decision = { delivery: 'interrupt', source: 'fallback' }; }
    } else if (sender === null) decision = { delivery: 'interrupt', source: 'default' };
    this.store.transaction(() => {
      this.store.message(target.id, body, sender);
      this.store.event(target.id, 'message', { sender, body });
      if (sender === null) this.store.event(target.id, 'ap.input_routed', { delivery: decision.delivery,
        source: decision.source, error: ruleError });
    });
    // Soft preemption only at a backend-attested safe point; otherwise deliver at the end of the turn.
    if (sender === null && decision.delivery === 'interrupt') this.requestPreempt(target.id, 'user message');
    this.wake(target.id); return this.store.ap(target.id);
  },

  /** Runtime-only: commit a typed child→parent signal once, then wake the parent. */
  sendAPSignal(sourceId, targetId, type, key, payload = {}) {
    const source = this.store.ap(sourceId), target = this.store.ap(targetId);
    check(source.parent_id === target.id, 'AP signals must go from a child to its direct parent');
    check(!['main','owner'].includes(target.ap_kind), 'branch owner only receives pinned reserved merge requests');
    check(!TERMINAL.has(target.status), 'a terminal parent cannot receive a new signal');
    check(typeof type === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(type), 'invalid AP signal type');
    check(typeof key === 'string' && key.length > 0 && key.length <= 128 && !/\s/u.test(key), 'invalid AP signal key');
    check(isPlainObject(payload), 'AP signal payload must be an object');
    check(Buffer.byteLength(JSON.stringify(payload)) <= 16384, 'AP signal payload exceeds 16384 bytes');
    const body = JSON.stringify({ version: 1, signal: type, key, source_ap_id: source.id,
      target_ap_id: target.id, payload });
    const signal = this.store.transaction(() => {
      const row = this.store.signal(target.id, source.id, type, key, body);
      if (row.inserted) this.store.event(target.id, 'ap.signal', { message_id: row.id,
        source_ap_id: source.id, signal: type, key });
      return row;
    });
    if (signal.inserted) this.wake(target.id);
    return signal;
  },

  notice(apId, title, body = '', kind = 'question', questions = undefined) {
    const ap = this.store.ap(apId); text(title, 'title');
    check(typeof body === 'string' && body.length <= 32000, 'invalid notice body');
    check(['question','plan'].includes(kind), 'notice kind must be question or plan');
    check(!TERMINAL.has(ap.status), 'AP has ended');
    if (questions !== undefined) {
      check(kind === 'question', 'a plan cannot contain a questionnaire');
      check(!this.questionPending(ap.id), 'AP already has an open questionnaire');
      body = questionnaire(body, questions); kind = 'questionnaire';
    }
    const noticeId = this.store.transaction(() => {
      const row = this.store.run('INSERT INTO notices(ap_id,title,body,kind) VALUES (?,?,?,?)', ap.id, title, body, kind);
      const noticeId = Number(row.lastInsertRowid);
      this.store.event(ap.id, 'notice.opened', { notice_id: noticeId, title, kind });
      if (kind === 'questionnaire') this.parkForQuestion(ap.id, noticeId);
      return noticeId;
    });
    // This is a deliberate suspension, not a timeout/failure. Persist before stopping the process.
    if (kind === 'questionnaire') this.running.get(ap.id)?.controller.abort();
    return this.store.get('SELECT * FROM notices WHERE id=?', noticeId);
  },

  /**
   * 纯提醒：结算时告知「这一时刻、这条分支发生了什么」，不需要用户回复。
   * 落库固定 kind='info' / status='sent'（不是 open），因此不进任何「待决」口径，
   * 也不会让 AP 停在 awaiting；answer / dismiss 会因为 status 不是 open 而拒绝它。
   * 允许在终态 AP 上写：这条提醒本来就是结算的产物，结算之后 AP 不能再被唤醒。
   */
  notify(apId, title, body = '') {
    const ap = this.store.ap(apId); text(title, 'title');
    check(typeof body === 'string' && body.length <= 32000, 'invalid notice body');
    const row = this.store.run("INSERT INTO notices(ap_id,title,body,kind,status) VALUES (?,?,?,'info','sent')", ap.id, title, body);
    this.store.event(ap.id, 'notice.opened', { notice_id: Number(row.lastInsertRowid), title, kind: 'info' });
    return this.store.get('SELECT * FROM notices WHERE id=?', Number(row.lastInsertRowid));
  },

  answer(noticeId, answer, dismiss = false) {
    const notice = this.store.get('SELECT * FROM notices WHERE id=?', id(noticeId));
    check(notice && notice.status === 'open', 'notice is not open');
    // 计划审批走 plan.approve / plan.reject：它们要动闸门、作废本轮 spec，不是“回答一个问题”。
    check(notice.kind !== 'plan', `notice ${notice.id} is a plan approval; use lush plan approve|reject ${notice.ap_id}`);
    if (!dismiss) {
      if (notice.kind === 'questionnaire') answer = questionnaireAnswer(notice.body, answer);
      else text(answer, 'answer');
    }
    const stored = typeof answer === 'string' ? answer : JSON.stringify(answer);
    this.store.transaction(() => {
      this.store.run('UPDATE notices SET status=?,answer=? WHERE id=?', dismiss ? 'dismissed' : 'answered', stored || '', notice.id);
      this.store.message(notice.ap_id, JSON.stringify({ notice_id: notice.id, title: notice.title, dismissed: dismiss, answer: answer || '' }));
      this.store.event(notice.ap_id, 'notice.answered', { notice_id: notice.id, answer, dismiss });
    });
    const owner = this.store.ap(notice.ap_id);
    // 预置 AP（从未被唤醒过的解冲突 AP）唯一没答过的请求就是这条 notice：
    // 忽略它意味着这件事不要做了，唤醒 agent 只会让它去做用户刚拒绝的事，所以直接让它结束。
    if (dismiss && owner.agent_wakes === 0 && owner.resolves_ap_id) this.cancel(owner.id, `user dismissed notice ${notice.id}: ${notice.title}`);
    else this.wake(notice.ap_id);
    return this.store.get('SELECT * FROM notices WHERE id=?', notice.id);
  }
};
