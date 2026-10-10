import { check, TERMINAL } from '../types.js';
import { HOOK_LIMITS, hookConditionsMatch } from '../hooks.js';
import { nextHookRun } from '../hook-schedule.js';
import { assertTaskAncestorsOpen } from './iteration.js';

const read = task => task.hooks ? JSON.parse(task.hooks) : { mounts: [] };
const save = (project, taskId, data) => project.store.update(taskId, { hooks: JSON.stringify(data) });
const timestamp = project => new Date(project.hookClock()).toISOString();
const nextRun = (mount, clock) => nextHookRun(mount.schedule, Math.max(clock, Date.parse(mount.last_due_at ?? '') || clock));
const eligible = mount => mount?.schedule && mount.enabled && !['failed','unknown','running'].includes(mount.state)
  && !(mount.mode === 'once' && ['succeeded','skipped'].includes(mount.state));
const selfRetry = (mount, task) => mount.actions.some(a => a.type === 'retry_worker' && a.target_id === task.id)
  && mount.actions.every(a => a.type === 'notify' || (a.type === 'retry_worker' && a.target_id === task.id));
const errors = { create_worker: '定时 Worker 创建未完成；检查分支、运行设置和现场，未自动重试。',
  message: '定时消息未完成；检查目标生命周期和现场，未自动重试。',
  retry_worker: '定时重试未通过安全检查；检查 Worker 和运行设置，未自动重试。',
  resume_worker: '定时继续未通过安全检查；检查 Worker 和运行设置，未自动重试。',
  notify: '定时告知未保存；请检查现场。' };

function ownerReason(project, task, mount) {
  if (['completed','cancelled'].includes(task.status) || (task.status === 'failed' && !selfRetry(mount, task))) return '挂载 Worker 已结束，定时授权停止。';
  if (task.branch && ['archived','deleted'].includes(project.store.branch(task.branch)?.status)) return '挂载 Worker 已归档或分支不可用，定时授权停止。';
  try { assertTaskAncestorsOpen(project, task); } catch { return '挂载 Worker 的祖先已结束，定时授权停止。'; }
  return null;
}
function targetReason(project, target) {
  if (!['order','child'].includes(target.task_kind) || ['completed','cancelled'].includes(target.status)) return '目标已结束或不支持此操作，定时授权停止。';
  if (target.branch && ['archived','deleted'].includes(project.store.branch(target.branch)?.status)) return '目标已归档或分支不可用，定时授权停止。';
  try { assertTaskAncestorsOpen(project, target); } catch { return '目标的祖先已结束，定时授权停止。'; }
  return null;
}

/** Known, side-effect-free admission facts. An arbitrary action exception is NEVER treated as a retryable gate. */
function admission(project, task, mount, action) {
  if (project.maintenancePaused()) return { wait: '项目维护暂停，动作已提交并等待显式全部继续。' };
  const permanent = ownerReason(project, task, mount);
  if (permanent) return { stop: permanent };
  if (project.clearing || project.workerDeleteIds?.size || project.settingsMigrationApplying) return { wait: '项目正在清理或迁移，等待安全点。' };
  if (action.type === 'notify') return {};
  const target = action.type === 'create_worker' ? task : project.store.get('SELECT * FROM tasks WHERE id=?', action.target_id);
  if (!target) return { stop: '目标 Worker 已不存在，定时授权停止。' };
  if (action.type !== 'create_worker') {
    if (!(target.id === task.id || target.parent_id === task.id || task.parent_id === target.id)) return { stop: '目标已不再是当前 Worker 或直接父子，定时授权停止。' };
    const reason = targetReason(project, target); if (reason) return { stop: reason };
    if (action.type === 'retry_worker' && target.status !== 'failed') return { skip: '目标不是失败状态，本次定时重试不适用。' };
    if (action.type === 'resume_worker' && (target.status !== 'paused' || target.interrupt_state)) return { skip: '目标不是已生效的暂停状态，本次定时继续不适用。' };
    if (action.type === 'message' && TERMINAL.has(target.status)) return { stop: '消息目标已结束，不能通过消息复活 Worker。' };
  }
  if (project.taskSyncBusy?.has(target.id)) return { wait: '目标正在同步，等待安全点。' };
  if (project.workspaces.busy.has(target.id)) return { wait: '目标工作区正在清理，等待安全点。' };
  if (target.branch && project.branchFreeze(target.branch)) return { wait: '目标分支冻结，动作已提交并等待安全点。' };
  const booking = target.reservation ? JSON.parse(target.reservation) : null;
  if (booking?.version === 2 && ['requested','executing','blocked'].includes(booking.status)) return { wait: '目标交付冻结，动作已提交并等待安全点。' };
  if (['retry_worker','resume_worker'].includes(action.type) && project.running.has(target.id)) return { wait: '原 Agent 尚在收尾，等待实际退出。' };
  if (action.type === 'create_worker' && (!project.hookParentReady(task.id) || project.taskMergeBusy?.has(task.id))) return { wait: '父 Worker 尚未通过创建准入，动作已提交并等待安全点。' };
  return {};
}

export default {
  hookClock() { return (this.scheduledHookOptions?.now ?? Date.now)(); },

  stopScheduledHookTimer() {
    if (this.scheduledHookTimer !== undefined && this.scheduledHookTimer !== null)
      (this.scheduledHookOptions?.clearTimeout ?? clearTimeout)(this.scheduledHookTimer);
    this.scheduledHookTimer = null;
  },

  armScheduledHookTimer() {
    this.stopScheduledHookTimer();
    if (this.stopping || this.recoveringHooks) return;
    const clock = this.hookClock(); let deadline = this.managementTimerDeadline(clock);
    for (const task of this.store.all('SELECT hooks FROM tasks WHERE hooks IS NOT NULL')) for (const mount of read(task).mounts) {
      if (!mount.schedule || !mount.enabled || ['failed','unknown'].includes(mount.state)) continue;
      if (mount.next_run_at) deadline = Math.min(deadline, mount.state === 'running' ? Math.max(clock + 1000, Date.parse(mount.next_run_at)) : Date.parse(mount.next_run_at));
      if (mount.pending_due_at && mount.state !== 'running') deadline = Math.min(deadline, clock + 1000);
    }
    if (!Number.isFinite(deadline)) return;
    // Long timeouts overflow on Bun/Node; the cap also observes clock/timezone changes and external safety facts.
    this.scheduledHookTimer = (this.scheduledHookOptions?.setTimeout ?? setTimeout)(() => {
      this.scheduledHookTimer = null;
      if (!this.stopping) this.observeScheduledTaskHooks();
    }, Math.max(this.clearing || this.workerDeleteIds?.size || this.settingsMigrationApplying ? 1000 : 1, Math.min(60000, deadline - clock)));
    this.scheduledHookTimer?.unref?.();
  },

  submitScheduledOccurrence(taskId, hookId, dueAt) {
    this.store.transaction(() => {
      const task = this.store.task(taskId), data = read(task), mount = data.mounts.find(m => m.id === hookId);
      if (!mount || !eligible(mount) || mount.pending_due_at) return;
      const id = this.store.event(taskId, 'hook.scheduled_submitted', { hook_id: hookId, trigger: 'time.scheduled', due_at: dueAt });
      mount.pending_due_at = dueAt; mount.pending_execution_id = id; mount.last_due_at = dueAt;
      mount.state = 'waiting'; mount.receipts = [];
      mount.reason = '定时动作已提交；在安全点尽早执行，不保证 Agent 准点开始。';
      mount.last_execution = { id, trigger: 'time.scheduled', status: 'waiting', due_at: dueAt, created_at: timestamp(this), finished_at: null };
      save(this, taskId, data);
      if (!hookConditionsMatch(mount, task)) this.finishScheduledTaskHook(taskId, hookId, id, 'skipped', '到点时 Worker 条件不匹配，本次动作跳过。');
    });
  },

  finishScheduledTaskHook(taskId, hookId, executionId, status, reason = null, stop = false) {
    this.store.transaction(() => {
      const task = this.store.task(taskId), data = read(task), mount = data.mounts.find(m => m.id === hookId);
      if (!mount || mount.pending_execution_id !== executionId) return;
      mount.state = status; mount.reason = reason;
      mount.pending_due_at = null; delete mount.pending_execution_id; delete mount.action_started_index;
      if (stop || mount.mode === 'once' || ['failed','unknown'].includes(status)) { mount.enabled = false; mount.next_run_at = null; }
      Object.assign(mount.last_execution, { status, finished_at: timestamp(this), ...(reason ? { error: reason } : {}) });
      save(this, taskId, data);
      this.store.event(taskId, `hook.execution_${status}`, { hook_id: hookId, execution_id: executionId, error: reason });
      this.removeSucceededTaskHook(taskId, hookId);
    });
  },

  observeScheduledTaskHooks(taskId = null) {
    if (this.stopping || this.recoveringHooks) return;
    if (this.clearing || this.workerDeleteIds?.size || this.settingsMigrationApplying) { this.armScheduledHookTimer(); return; }
    const clock = this.hookClock();
    this.observeHookSignals(clock);
    const tasks = taskId === null ? this.store.all('SELECT * FROM tasks WHERE hooks IS NOT NULL ORDER BY id')
      : this.store.all('SELECT * FROM tasks WHERE id=? AND hooks IS NOT NULL', taskId);
    for (const task of tasks) for (const original of read(task).mounts) {
      if (original.schedule?.kind === 'daily' && original.enabled && original.state === 'running'
        && original.next_run_at && Date.parse(original.next_run_at) <= clock) {
        const data = read(this.store.task(task.id)), mount = data.mounts.find(m => m.id === original.id);
        mount.next_run_at = nextRun(mount, clock); save(this, task.id, data);
      }
      if (!eligible(original)) continue;
      const dueAt = original.next_run_at;
      if (dueAt && Date.parse(dueAt) <= clock) {
        this.store.transaction(() => {
          const data = read(this.store.task(task.id)), mount = data.mounts.find(m => m.id === original.id);
          if (!eligible(mount) || mount.next_run_at !== dueAt) return;
          mount.next_run_at = nextRun(mount, clock); save(this, task.id, data);
          // A pending occurrence owns the single slot; later days never build a backlog.
          if (!mount.pending_due_at) this.submitScheduledOccurrence(task.id, mount.id, dueAt);
        });
      }
      const current = read(this.store.task(task.id)).mounts.find(m => m.id === original.id);
      if (eligible(current) && current.pending_due_at) this.queueScheduledTaskHook(task.id, current.id, current.pending_execution_id);
    }
    this.armScheduledHookTimer();
  },

  queueScheduledTaskHook(taskId, hookId, executionId) {
    if (this.maintenancePaused()) return;
    const key = `${taskId}:${hookId}`, queued = this.scheduledHookQueued ??= new Set();
    if (queued.has(key)) return;
    // Probe only the first uncompleted action, without marking a waiting item as started.
    const task = this.store.task(taskId), mount = read(task).mounts.find(m => m.id === hookId);
    const action = mount.actions.find((_, index) => !(mount.receipts ?? []).some(r => r.index === index));
    const gate = action ? admission(this, task, mount, action) : {};
    if (gate.wait) {
      if (mount.reason !== gate.wait) { const data = read(task); data.mounts.find(m => m.id === hookId).reason = gate.wait; save(this, taskId, data); }
      return;
    }
    queued.add(key);
    const previous = this.hookQueue ?? Promise.resolve();
    const job = previous.then(async () => {
      this.hookBatchCount = ((this.hookBatchCount ?? 0) + 1) % HOOK_LIMITS.batch;
      if (this.hookBatchCount === 0) await new Promise(resolve => setImmediate(resolve));
      await this.runScheduledTaskHook(taskId, hookId, executionId);
    }).finally(() => { queued.delete(key); this.armScheduledHookTimer(); });
    this.hookQueue = job.catch(() => {});
  },

  async runScheduledTaskHook(taskId, hookId, executionId) {
    if (this.stopping || this.maintenancePaused()) return;
    let actionType = null;
    try {
      // Another admitted writer may have closed the global gate since the non-blocking submission.
      if (this.clearing || this.workerDeleteIds?.size || this.settingsMigrationApplying) return;
      await this.write('execute a scheduled Hook', async () => {
        for (let index = 0; ; index += 1) {
          if (this.stopping) return;
          const task = this.store.get('SELECT * FROM tasks WHERE id=?', taskId);
          if (!task?.hooks) return;
          const mount = read(task).mounts.find(m => m.id === hookId);
          if (!mount?.enabled || mount.pending_execution_id !== executionId || ['failed','unknown'].includes(mount.state)) return;
          const action = mount.actions[index]; if (!action) break;
          if ((mount.receipts ?? []).some(r => r.index === index)) continue;
          actionType = action.type;
          const gate = admission(this, task, mount, action);
          if (gate.stop) { this.finishScheduledTaskHook(taskId, hookId, executionId, 'skipped', gate.stop, true); return; }
          if (gate.wait) {
            const data = read(task), current = data.mounts.find(m => m.id === hookId);
            current.state = 'waiting'; current.reason = gate.wait; current.last_execution.status = 'waiting'; delete current.action_started_index;
            save(this, taskId, data); return;
          }
          const begin = () => {
            const data = read(this.store.task(taskId)), current = data.mounts.find(m => m.id === hookId);
            current.state = 'running'; current.reason = null; current.action_started_index = index;
            current.last_execution.status = 'running'; save(this, taskId, data);
            this.store.event(taskId, 'hook.execution_started', { hook_id: hookId, execution_id: executionId, trigger: 'time.scheduled', index });
          };
          if (action.type === 'create_worker' && !gate.skip) {
            this.store.transaction(begin);
            const receipt = { task_id: taskId, hook_id: hookId, execution_id: executionId, action_index: index };
            const result = await this.sendOrder(action.content, task.branch, action.references, null, action.start, undefined, action.profile ?? null, false, receipt);
            this.store.transaction(() => {
              this.recordHookAction(taskId, hookId, executionId, index, { worker_id: result.task.id, input_id: result.id });
              const data = read(this.store.task(taskId)); delete data.mounts.find(m => m.id === hookId).action_started_index; save(this, taskId, data);
            });
          } else {
            // DB effects, retry/resume authorization, and receipts are atomic. kick() only queues a microtask.
            this.store.transaction(() => {
              begin(); let outcome = {};
              if (gate.skip) outcome = { skipped: true, reason: gate.skip };
              else if (action.type === 'notify') outcome = { notice_id: this.notify(taskId, action.title, action.body).id };
              else if (action.type === 'message') this.message(action.target_id, action.body);
              else if (action.type === 'retry_worker') this.retry(action.target_id, action.profile ?? null);
              else if (action.type === 'resume_worker') this.resumeTask(action.target_id, action.profile ?? null);
              else check(false, 'unsupported scheduled action');
              this.recordHookAction(taskId, hookId, executionId, index, outcome);
              const data = read(this.store.task(taskId)); delete data.mounts.find(m => m.id === hookId).action_started_index; save(this, taskId, data);
            });
          }
        }
        const mount = read(this.store.task(taskId)).mounts.find(m => m.id === hookId);
        const skipped = mount.receipts.find(r => r.skipped);
        this.finishScheduledTaskHook(taskId, hookId, executionId, skipped ? 'skipped' : 'succeeded', skipped?.reason ?? null);
      });
    } catch {
      this.finishScheduledTaskHook(taskId, hookId, executionId, 'failed', errors[actionType] ?? '定时动作执行失败；检查现场，未自动重试。', true);
    }
  },

  recoverScheduledTaskHooks() {
    this.stopScheduledHookTimer();
    const clock = this.scheduledHookRecoveryClock ?? this.hookClock();
    this.scheduledHookRecoveryClock = null;
    this.recoverHookSignals(clock);
    for (const task of this.store.all('SELECT * FROM tasks WHERE hooks IS NOT NULL')) for (const original of read(task).mounts) {
      if (!original.schedule) continue;
      if (original.state === 'running') {
        // Atomic receipts are positive evidence; an exact single creation Event covers the Git/DB return gap.
        if (original.actions.length === 1 && original.actions[0].type === 'create_worker' && !original.receipts?.length) {
          const event = this.store.get("SELECT data FROM events WHERE task_id=? AND type='hook.worker_created' AND json_extract(data,'$.execution_id')=? ORDER BY id DESC LIMIT 1", task.id, original.pending_execution_id);
          if (event) {
            const receipt = JSON.parse(event.data);
            this.recordHookAction(task.id, original.id, original.pending_execution_id, 0, { worker_id: receipt.worker_id, input_id: receipt.input_id });
          }
        }
        const mount = read(this.store.task(task.id)).mounts.find(m => m.id === original.id);
        const complete = mount.actions.every((_, index) => (mount.receipts ?? []).some(r => r.index === index));
        const skipped = mount.receipts?.find(r => r.skipped);
        this.finishScheduledTaskHook(task.id, mount.id, mount.pending_execution_id,
          complete ? skipped ? 'skipped' : 'succeeded' : 'unknown',
          complete ? skipped?.reason ?? null : '后台中断；定时动作可能已生效，保留现场并禁止自动重放。', !complete);
      }
      const data = read(this.store.task(task.id)), mount = data.mounts.find(m => m.id === original.id);
      if (!eligible(mount)) continue;
      if (mount.schedule.kind === 'once' && !mount.pending_due_at && Date.parse(mount.next_run_at ?? mount.schedule.at) <= clock) {
        // Persist a missed receipt, not a submitted action; reads remain side-effect-free.
        const id = this.store.event(task.id, 'hook.schedule_missed', { hook_id: mount.id, due_at: mount.schedule.at });
        mount.pending_execution_id = id;
        mount.last_execution = { id, trigger: 'time.scheduled', status: 'skipped', due_at: mount.schedule.at, created_at: timestamp(this), finished_at: null };
        save(this, task.id, data);
        this.finishScheduledTaskHook(task.id, mount.id, id, 'skipped', '项目后台停机期间错过指定时间，本次动作跳过。');
      } else if (mount.schedule.kind === 'daily') {
        mount.next_run_at = nextRun(mount, clock); save(this, task.id, data);
      }
    }
  },
};
