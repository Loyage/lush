import { check, id, text, TERMINAL } from '../types.js';

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

  notice(taskId, title, body = '', kind = 'question') {
    const task = this.store.task(taskId); text(title, 'title');
    check(typeof body === 'string' && body.length <= 32000, 'invalid notice body');
    check(['question','plan'].includes(kind), 'notice kind must be question or plan');
    check(!TERMINAL.has(task.status), 'task has ended');
    const row = this.store.run('INSERT INTO notices(task_id,title,body,kind) VALUES (?,?,?,?)', task.id, title, body, kind);
    this.store.event(task.id, 'notice.opened', { notice_id: Number(row.lastInsertRowid), title, kind });
    return this.store.get('SELECT * FROM notices WHERE id=?', Number(row.lastInsertRowid));
  },

  answer(noticeId, answer, dismiss = false) {
    const notice = this.store.get('SELECT * FROM notices WHERE id=?', id(noticeId));
    check(notice && notice.status === 'open', 'notice is not open');
    // 计划审批走 plan.approve / plan.reject：它们要动闸门、作废本轮 spec，不是“回答一个问题”。
    check(notice.kind !== 'plan', `notice ${notice.id} is a plan approval; use lush plan approve|reject ${notice.task_id}`);
    if (!dismiss) text(answer, 'answer');
    this.store.transaction(() => {
      this.store.run('UPDATE notices SET status=?,answer=? WHERE id=?', dismiss ? 'dismissed' : 'answered', answer || '', notice.id);
      this.store.message(notice.task_id, JSON.stringify({ notice_id: notice.id, title: notice.title, dismissed: dismiss, answer: answer || '' }));
      this.store.event(notice.task_id, 'notice.answered', { notice_id: notice.id, answer, dismiss });
    });
    const owner = this.store.task(notice.task_id);
    // 预置任务（从未被唤醒过的解冲突任务）唯一没答过的请求就是这条 notice：
    // 忽略它意味着这件事不要做了，唤醒 agent 只会让它去做用户刚拒绝的事，所以直接让它结束。
    if (dismiss && owner.agent_wakes === 0) this.cancel(owner.id, `user dismissed notice ${notice.id}: ${notice.title}`);
    else this.wake(notice.task_id);
    return this.store.get('SELECT * FROM notices WHERE id=?', notice.id);
  }
};
