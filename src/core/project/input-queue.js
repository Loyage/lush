import { TERMINAL } from '../types.js';
import { assertTaskAncestorsOpen, consumeIntegratedReservation, resumeTaskDelivery } from './iteration.js';

const bookingOf = task => task.reservation ? JSON.parse(task.reservation) : null;

/** Worker-owned inbox admission is separate from Agent delivery and Git ownership. */
export default {
  inputFreezeReason(task, freezes = null) {
    const booking = bookingOf(task);
    if (booking?.version === 2 && ['requested','executing','resolving','blocked'].includes(booking.status))
      return booking.status === 'blocked' ? '交付落地待核验；输入已保存，等待安全解冻'
        : '当前固定交付尚未结束；输入已保存，等待交付解冻';
    const branch = task.branch ?? task.target_branch;
    const freeze = branch ? freezes ? freezes.get(branch) : this.branchFreeze(branch) : null;
    return freeze ? `分支冻结；输入已保存，等待解冻：${freeze.reason}` : null;
  },

  inputQueueWaitReason(task, freezes = null) {
    if (TERMINAL.has(task.status)) return 'Worker 已停止；暂存输入保留，等待显式恢复';
    if (task.branch && this.store.branch(task.branch)?.status !== 'active') return 'Worker 分支已归档；暂存输入保留';
    try { assertTaskAncestorsOpen(this, task); } catch (error) { return error.message; }
    const frozen = this.inputFreezeReason(task, freezes);
    if (frozen) return frozen;
    if (this.running.has(task.id) || task.status === 'running') return 'Agent 尚未实际退出；输入已保存，等待静息';
    if (task.status === 'paused' || task.interrupt_state) return 'Worker 已暂停；输入已保存，等待继续';
    if (this.questionPending(task.id)) return 'Worker 正在等待待决答复；输入已保存，等待答复';
    if (this.taskSyncBusy?.has(task.id) || this.workerDeleteIds?.has(task.id)
      || this.workspaces.busy.has(task.id) || this.commandHookRunning?.has(task.id) || this.completionBusy?.has(task.id))
      return 'Worker 正在同步或收尾；输入已保存，等待安全点';
    return null;
  },

  taskInputQueue(task, buffered = null, freezes = null) {
    buffered ??= this.store.get("SELECT count(*) AS n FROM messages WHERE task_id=? AND consumed=0 AND delivery_hold IN ('frozen','routing')", task.id).n;
    return { buffered, reason: buffered ? this.inputQueueWaitReason(task, freezes) ?? '输入已保存，等待 Worker 投递安全点' : null };
  },

  releaseTaskInputs(taskId, freezes = null) {
    const task = this.store.task(taskId);
    if (['main','owner','merge','management'].includes(task.task_kind) || this.inputQueueWaitReason(task, freezes)) return false;
    const held = this.store.all("SELECT id,body,sender_id,delivery_hold FROM messages WHERE task_id=? AND consumed=0 AND delivery_hold IN ('frozen','routing') ORDER BY id LIMIT 50", taskId);
    if (!held.length) return false;
    // Rules are trusted repository code. Persist their claim BEFORE running them: a
    // interrupted rule has unknown effects and must fall back, never replay on restart.
    for (const message of held) {
      let routing;
      if (message.delivery_hold === 'routing') routing = { decision: { delivery: 'interrupt', source: 'fallback' },
        error: 'input rule interrupted; unknown effects were not replayed' };
      else {
        this.store.run("UPDATE messages SET delivery_hold='routing' WHERE id=? AND consumed=0 AND delivery_hold='frozen'", message.id);
        routing = this.routeTaskInput(this.store.task(taskId), message.body, message.sender_id);
      }
      this.store.transaction(() => {
        const current = this.store.task(taskId), booking = bookingOf(current);
        if (booking?.version === 2 && booking.status === 'suspended') this.resumeQueuedTaskMerge(taskId);
        if (message.sender_id === null) resumeTaskDelivery(this, taskId, 'buffered user input');
        consumeIntegratedReservation(this, this.store.task(taskId), 'buffered input');
        this.store.run("UPDATE messages SET delivery_hold='released' WHERE id=? AND consumed=0", message.id);
        this.store.event(taskId, 'task.input_released', { message_id: message.id });
        if (message.sender_id === null) this.store.event(taskId, 'task.input_routed', { message_id: message.id,
          delivery: routing.decision.delivery, source: routing.decision.source, error: routing.error });
      });
    }
    // There is no invocation to preempt here. A single wake admits the entire FIFO wave.
    this.wake(taskId);
    return true;
  },

  releaseQueuedInputs() {
    const freezes = new Map(this.branchFreeze().map(freeze => [freeze.branch, freeze]));
    const rows = this.store.all("SELECT DISTINCT task_id FROM messages WHERE consumed=0 AND delivery_hold IN ('frozen','routing') ORDER BY task_id");
    for (const row of rows) this.releaseTaskInputs(row.task_id, freezes);
  },
};
