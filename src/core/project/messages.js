import { check, id, text, TERMINAL } from '../types.js';
import { questionnaire, questionnaireAnswer } from '../questionnaire.js';

/** 收件箱、notice、答复。 */
export default {
  message(taskId, body, sender = null) {
    const target = this.store.task(taskId); text(body, 'message');
    check(!TERMINAL.has(target.status), 'task has ended; retry it or submit a new input');
    if (sender !== null) {
      const from = this.store.task(sender);
      check(target.parent_id === from.id || from.parent_id === target.id, 'agents may message only a direct parent or child');
    }
    this.store.message(target.id, body, sender);
    this.store.event(target.id, 'message', { sender, body });
    this.wake(target.id); return this.store.task(target.id);
  },

  notice(taskId, title, body = '', kind = 'question', questions = undefined) {
    const task = this.store.task(taskId); text(title, 'title');
    check(typeof body === 'string' && body.length <= 32000, 'invalid notice body');
    check(['question','plan'].includes(kind), 'notice kind must be question or plan');
    check(!TERMINAL.has(task.status), 'task has ended');
    if (questions !== undefined) {
      check(kind === 'question', 'a plan cannot contain a questionnaire');
      check(!this.questionPending(task.id), 'task already has an open questionnaire');
      body = questionnaire(body, questions); kind = 'questionnaire';
    }
    const noticeId = this.store.transaction(() => {
      const row = this.store.run('INSERT INTO notices(task_id,title,body,kind) VALUES (?,?,?,?)', task.id, title, body, kind);
      const noticeId = Number(row.lastInsertRowid);
      this.store.event(task.id, 'notice.opened', { notice_id: noticeId, title, kind });
      if (kind === 'questionnaire') this.parkForQuestion(task.id, noticeId);
      return noticeId;
    });
    // This is a deliberate suspension, not a timeout/failure. Persist before stopping the process.
    if (kind === 'questionnaire') this.running.get(task.id)?.controller.abort();
    return this.store.get('SELECT * FROM notices WHERE id=?', noticeId);
  },

  answer(noticeId, answer, dismiss = false) {
    const notice = this.store.get('SELECT * FROM notices WHERE id=?', id(noticeId));
    check(notice && notice.status === 'open', 'notice is not open');
    // 计划审批走 plan.approve / plan.reject：它们要动闸门、作废本轮 spec，不是“回答一个问题”。
    check(notice.kind !== 'plan', `notice ${notice.id} is a plan approval; use lush plan approve|reject ${notice.task_id}`);
    if (!dismiss) {
      if (notice.kind === 'questionnaire') answer = questionnaireAnswer(notice.body, answer);
      else text(answer, 'answer');
    }
    const stored = typeof answer === 'string' ? answer : JSON.stringify(answer);
    this.store.transaction(() => {
      this.store.run('UPDATE notices SET status=?,answer=? WHERE id=?', dismiss ? 'dismissed' : 'answered', stored || '', notice.id);
      this.store.message(notice.task_id, JSON.stringify({ notice_id: notice.id, title: notice.title, dismissed: dismiss, answer: answer || '' }));
      this.store.event(notice.task_id, 'notice.answered', { notice_id: notice.id, answer, dismiss });
    });
    const owner = this.store.task(notice.task_id);
    // 预置任务（从未被唤醒过的解冲突任务）唯一没答过的请求就是这条 notice：
    // 忽略它意味着这件事不要做了，唤醒 agent 只会让它去做用户刚拒绝的事，所以直接让它结束。
    if (dismiss && owner.agent_wakes === 0 && owner.resolves_task_id) this.cancel(owner.id, `user dismissed notice ${notice.id}: ${notice.title}`);
    else this.wake(notice.task_id);
    return this.store.get('SELECT * FROM notices WHERE id=?', notice.id);
  }
};
