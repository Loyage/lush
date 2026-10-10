import { check, TERMINAL } from '../types.js';

const KEY = 'project_maintenance';
const empty = () => ({ version: 1, paused: false, affected: [] });
function state(project) {
  const value = project.store.get('SELECT value FROM meta WHERE key=?', KEY)?.value;
  if (!value) return empty();
  const data = JSON.parse(value);
  check(data?.version === 1 && typeof data.paused === 'boolean' && Array.isArray(data.affected)
    && data.affected.every(row => Number.isInteger(row.id) && row.id > 0), 'invalid project maintenance state; inspect before continuing');
  return data;
}
function save(project, data) {
  project.store.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY, JSON.stringify(data));
}

/** A durable project admission gate, not a replacement for individual Worker states. */
export default {
  maintenancePaused() { return state(this).paused; },

  maintenanceView() {
    const data = state(this);
    const activeCalls = this.running.size + this.introRunning.size;
    // Counts describe overlapping safety barriers, not distinct jobs. A queued Git or
    // asynchronous writer still owns resources even when no Agent status says running.
    const groups = [
      [this.writing + Number(this.clearing) + Number(Boolean(this.settingsMigrationApplying)), '等待项目后台写操作收尾'],
      [this.workspaces.pending + this.workspaces.busy.size, '等待 Git 操作收尾'],
      [(this.taskMergeBusy?.size ?? 0) + this.mergeRunsDriving.size + this.integratingIntents.size, '等待交付或合并收尾'],
      [(this.taskSyncBusy?.size ?? 0) + (this.acceptanceBusy?.size ?? 0) + (this.workerDeleteIds?.size ?? 0), '等待同步或资源回收收尾'],
      [(this.lifecycleHookRunning?.size ?? 0) + (this.lifecycleHookQueued?.size ?? 0)
        + (this.scheduledHookQueued?.size ?? 0) + (this.commandHookQueued?.size ?? 0)
        + (this.commandHookRunning?.size ?? 0) + (this.completionQueued?.size ?? 0)
        + (this.completionBusy?.size ?? 0) + (this.shortcutCommandJobs?.size ?? 0), '等待自动化动作收尾'],
    ];
    const pendingOperations = groups.reduce((sum, [count]) => sum + count, 0);
    const ready = !this.stopping && activeCalls === 0 && pendingOperations === 0;
    return { version: 1, paused: data.paused, phase: data.paused ? ready ? 'paused' : 'pausing' : 'running',
      ready_to_restart: ready, active_calls: activeCalls, pending_operations: pendingOperations,
      affected_count: data.affected.length,
      blockers: [...(this.stopping ? ['项目后台正在停止'] : []), ...(activeCalls ? ['等待当前 Agent 或模型调用安全退出'] : []),
        ...groups.filter(([count]) => count > 0).map(([, reason]) => reason)] };
  },

  interruptAll() {
    this.assertWritable('pause project Agents');
    check(!this.stopping, 'daemon is stopping');
    const previous = state(this);
    if (previous.paused) return this.maintenanceView();
    const affected = [];
    // Close admission durably before requesting any boundaries or triggering Hooks.
    this.store.transaction(() => {
      for (const [id, run] of this.running) {
        const task = this.store.task(id);
        if (run.parked || run.invocationEnded || TERMINAL.has(task.status) || task.status === 'paused'
          || task.interrupt_state === 'requested') continue;
        if (['order','child','management'].includes(task.task_kind)) affected.push({ id, run_id: run.recordId ?? null });
      }
      save(this, { version: 1, paused: true, affected });
      this.store.event(null, 'maintenance.interrupted', { affected_count: affected.length });
    });
    for (const { id } of affected) {
      const task = this.store.task(id), run = this.running.get(id);
      if (run) run.maintenancePause = true;
      if (task.task_kind === 'management') this.requestPreempt(id, 'project maintenance', 'pause');
      else this.interrupt(id, 'project maintenance', true);
    }
    return this.maintenanceView();
  },

  /** A later personal pause wins even if its status/intent was already paused. */
  forgetMaintenanceWorker(taskId) {
    const data = state(this);
    if (!data.affected.some(row => row.id === taskId)) return;
    data.affected = data.affected.filter(row => row.id !== taskId);
    save(this, data);
    const run = this.running.get(taskId);
    if (run) run.maintenancePause = false;
  },

  resumeAll() {
    this.assertWritable('resume project Agents');
    check(!this.stopping, 'daemon is stopping');
    const data = state(this);
    if (!data.paused) return this.maintenanceView();
    // Resume under the still-closed gate; no microtask can launch midway through
    // the batch. Failures retain their individual safety state, not a false success.
    for (const { id } of data.affected) {
      const task = this.store.get('SELECT * FROM tasks WHERE id=?', id);
      if (!task || TERMINAL.has(task.status) || task.status === 'awaiting_acceptance') continue;
      if (task.task_kind === 'management') {
        const run = this.running.get(id);
        if (run) {
          run.maintenancePause = false;
          // A management stop already claimed by Pi is handled as a safe pause
          // on the same occurrence; only an unclaimed request can be removed.
          this.cancelMaintenancePreempt(id, run);
        }
      } else if (task.status === 'paused' || task.interrupt_state) {
        // A syncing/frozen target stays paused; do not bypass the ordinary guard.
        try {
          this.resumeTask(id);
          const run = this.running.get(id);
          if (run) run.maintenancePause = false;
        }
        catch {
          this.store.event(id, 'maintenance.resume_blocked', { reason: 'Worker 安全门仍未通过，保留暂停；检查后显式继续。' });
        }
      }
    }
    this.store.transaction(() => {
      save(this, empty());
      this.store.event(null, 'maintenance.resumed', { affected_count: data.affected.length });
    });
    // Existing persistent queues remain authoritative. Do not wake every idle
    // Worker: that would turn a parent's child-wait into a needless invocation.
    this.observeTaskHooks();
    this.drainDaemonAutoSelect();
    this.drainManagementActions();
    this.scheduleTaskCompletion();
    for (const row of this.store.all("SELECT id,parent_id,status,reservation FROM tasks WHERE task_kind IN ('order','say','child')")) {
      if (row.status === 'waiting') this.armTaskAutoMerge(row.id);
      let booking; try { booking = row.reservation ? JSON.parse(row.reservation) : null; } catch { continue; }
      if (booking?.version === 2 && booking.status === 'pending' && row.status === 'waiting')
        void this.settleQueuedMerge(row.id).catch(() => this.noteCompletionMergeFailure(row.id));
      if (booking?.version === 2 && ['requested','executing','resolving'].includes(booking.status)) this.scheduleTaskMerge(booking.parent_id);
    }
    this.kick();
    return this.maintenanceView();
  },
};
