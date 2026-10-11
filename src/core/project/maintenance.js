import { randomUUID } from 'node:crypto';
import { check, TERMINAL } from '../types.js';
import { HOOK_LIMITS } from '../hooks.js';
import { workerLabel } from '../worker-number.js';

const KEY = 'project_maintenance';
const empty = () => ({ version: 1, paused: false, affected: [] });
function state(project) {
  const value = project.store.get('SELECT value FROM meta WHERE key=?', KEY)?.value;
  if (!value) return empty();
  const data = JSON.parse(value);
  check(data?.version === 1 && typeof data.paused === 'boolean' && Array.isArray(data.affected)
    && data.affected.every(row => Number.isInteger(row.id) && row.id > 0), 'invalid project maintenance state; inspect before continuing');
  if (data.batch_id !== undefined && data.batch_id !== null) check(
    typeof data.batch_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.batch_id)
    && ['pending','completed','cancelled','unknown'].includes(data.completion_state)
    && (data.completion_state === 'completed'
      ? Number.isSafeInteger(data.completion_notice_id) && data.completion_notice_id > 0
      : data.completion_notice_id === null)
    && Array.isArray(data.participants) && data.participants.every(row => Number.isSafeInteger(row.id) && row.id > 0
      && typeof row.invocation_id === 'string' && (row.run_id === null || (Number.isSafeInteger(row.run_id) && row.run_id > 0))
      && ['pending','completed','cancelled','unknown'].includes(row.state)),
    'invalid project maintenance batch; inspect before continuing');
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
    const activeCalls = this.running.size;
    // Counts describe overlapping safety barriers, not distinct jobs. A queued Git or
    // asynchronous writer still owns resources even when no Agent status says running.
    const groups = [
      [this.writing + Number(this.clearing) + Number(Boolean(this.settingsMigrationApplying)), '等待项目后台写操作收尾'],
      [this.workspaces.pending + this.workspaces.busy.size, '等待 Git 操作收尾'],
      [(this.taskMergeBusy?.size ?? 0) + (this.convergenceJobs?.size ?? 0) + (this.convergenceDrivers?.size ?? 0) + this.mergeRunsDriving.size + this.integratingIntents.size, '等待交付或合并收尾'],
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
      batch_id: data.batch_id ?? null, completion_state: data.completion_state ?? null,
      completion_notice_id: data.completion_notice_id ?? null,
      blockers: [...(this.stopping ? ['项目后台正在停止'] : []), ...(activeCalls ? ['等待当前 Agent 或模型调用安全退出'] : []),
        ...groups.filter(([count]) => count > 0).map(([, reason]) => reason)] };
  },

  interruptAll() {
    this.assertWritable('pause project Agents');
    check(!this.stopping, 'daemon is stopping');
    const previous = state(this);
    if (previous.paused) return this.maintenanceView();
    const affected = [], participants = [], batchId = randomUUID();
    // Snapshot ownership and install the exact one-shot authorizations atomically BEFORE
    // closing admission or requesting a boundary. Capacity failure rolls back the whole batch.
    this.store.transaction(() => {
      for (const [id, run] of this.running) {
        const task = this.store.task(id);
        if (run.parked || TERMINAL.has(task.status) || !['order','child','management','integration'].includes(task.task_kind)) continue;
        const participant = { id, run_id: run.recordId ?? null, invocation_id: run.signalId, state: 'pending' };
        participants.push(participant);
        this.mountInterruptionNotice(task, participant, batchId);
        if (task.status !== 'paused' && task.interrupt_state !== 'requested')
          affected.push({ id, run_id: run.recordId ?? null });
      }
      save(this, { version: 1, paused: true, affected, participants, batch_id: batchId,
        completion_state: 'pending', completion_notice_id: null });
      this.store.event(null, 'maintenance.interrupted', { batch_id: batchId, affected_count: affected.length });
    });
    this.startMaintenanceMonitor();
    for (const { id } of affected) {
      const task = this.store.task(id), run = this.running.get(id);
      if (run) run.maintenancePause = true;
      if (task.task_kind === 'management') {
        run.interruptionRequested = (!run.invocationEnded || run.providerReturned) && !run.controller.signal.aborted;
        run.pauseBoundaryRequested = run.interruptionRequested;
        this.requestPreempt(id, 'project maintenance', 'pause');
      }
      else this.interrupt(id, 'project maintenance', true);
    }
    this.observeMaintenanceCompletion();
    return this.maintenanceView();
  },

  mountInterruptionNotice(task, participant, batchId) {
    const data = task.hooks ? JSON.parse(task.hooks) : { version: 1, mounts: [], observed: {} };
    check(data.mounts.length < HOOK_LIMITS.mounts, 'too many mounted Hooks; free capacity before interrupting the project');
    check(task.hooks || this.store.get('SELECT count(*) AS n FROM tasks WHERE hooks IS NOT NULL').n < 500,
      'too many Workers with mounted Hooks (limit 500)');
    const mount = { id: randomUUID(), name: '批量中断完成告知', trigger: 'worker.interrupted', mode: 'once', enabled: true,
      conditions: {}, actions: [{ type: 'notify', title: `${workerLabel(task)} 中断完成`,
        body: `本次调用已安全退出且暂停生效。项目维护批次：${batchId}。项目是否可重启仍需等待项目中断完成信号并动态复核。` }],
      state: 'idle', created_at: new Date().toISOString(), last_execution: null,
      signal_binding: { batch_id: batchId, run_id: participant.run_id, invocation_id: participant.invocation_id } };
    data.mounts.push(mount);
    check(Buffer.byteLength(JSON.stringify(data)) <= HOOK_LIMITS.bytes, 'mounted Hooks exceed size limit');
    this.store.update(task.id, { hooks: JSON.stringify(data) });
    this.store.event(task.id, 'hook.attached', { hook_id: mount.id, trigger: mount.trigger, batch_id: batchId, run_id: participant.run_id });
  },

  /** Called after provider AND cleanup ownership release, never from a read projection. */
  settleInterruptionSignal(taskId, run) {
    const task = this.store.task(taskId);
    const closed = run.recordId ? this.store.get('SELECT status FROM agent_runs WHERE id=?', run.recordId) : null;
    const safe = run.interruptionRequested && !run.invocationFailed && !run.resumeRequested && !run.controller.signal.aborted
      && (task.status === 'paused' || (task.task_kind === 'management' && run.managementPaused && this.maintenancePaused()))
      && (!closed || ['completed','preempted'].includes(closed.status));
    this.store.transaction(() => {
      if (safe) {
        const source = this.store.event(taskId, 'worker.interrupted', { run_id: run.recordId ?? null, invocation_id: run.signalId });
        this.emitTaskHook(taskId, 'worker.interrupted', source);
      }
      const data = state(this), participant = data.participants?.find(row => row.id === taskId && row.invocation_id === run.signalId);
      if (!participant || data.completion_state !== 'pending') return;
      participant.run_id = run.recordId ?? null;
      participant.state = safe ? 'completed' : task.status === 'cancelled' || run.resumeRequested ? 'cancelled' : 'unknown';
      if (!safe) {
        data.completion_state = participant.state;
        this.retireInterruptionMounts(data.batch_id, participant.state);
        this.store.event(null, `maintenance.${participant.state}`, { batch_id: data.batch_id });
      }
      save(this, data);
    });
  },

  // No replay authorization remains for a withdrawn/unverified batch. Claimed safe
  // signals already queued have their own exact receipts and may finish normally.
  retireInterruptionMounts(batchId, result) {
    for (const task of this.store.all('SELECT id,hooks FROM tasks WHERE hooks IS NOT NULL')) {
      const data = JSON.parse(task.hooks); let changed = false;
      for (const mount of data.mounts) if (mount.signal_binding?.batch_id === batchId && !mount.last_execution) {
        changed = true;
        mount.enabled = false; mount.state = result === 'unknown' ? 'unknown' : 'skipped';
        mount.reason = result === 'unknown' ? '本次中断无法确认安全完成，不自动重放。' : '本次维护已撤销，不发送完成信号。';
        this.store.event(task.id, `hook.execution_${mount.state}`, { hook_id: mount.id, batch_id: batchId, error: mount.reason });
      }
      if (!changed) continue;
      // Withdrawn internal authorizations have no effects to inspect; release capacity.
      data.mounts = data.mounts.filter(m => !(m.signal_binding?.batch_id === batchId && !m.last_execution && result !== 'unknown'));
      this.store.update(task.id, { hooks: data.mounts.length ? JSON.stringify(data) : null });
    }
  },

  invalidateMaintenanceWorker(taskId, status) {
    const data = state(this);
    if (data.completion_state !== 'pending' || !data.participants?.some(row => row.id === taskId)) return;
    this.store.transaction(() => {
      data.completion_state = status === 'failed' ? 'unknown' : 'cancelled';
      this.retireInterruptionMounts(data.batch_id, data.completion_state);
      save(this, data);
      this.store.event(null, `maintenance.${data.completion_state}`, { batch_id: data.batch_id });
    });
  },

  cancelInterruptionSignal(taskId, run) {
    if (run) run.interruptionRequested = false;
    const data = state(this);
    if (data.completion_state !== 'pending' || !data.participants?.some(row => row.id === taskId)) return;
    this.cancelMaintenanceBatch(data);
  },

  cancelMaintenanceBatch(data = state(this)) {
    if (!data.batch_id) return;
    data.completion_state = 'cancelled'; data.completion_notice_id = null;
    this.retireInterruptionMounts(data.batch_id, 'cancelled');
    save(this, data);
    this.store.event(null, 'maintenance.cancelled', { batch_id: data.batch_id });
  },

  observeMaintenanceCompletion() {
    if (this.stopping || this.recoveringHooks) return;
    const data = state(this);
    if (!data.paused || data.completion_state !== 'pending' || !data.participants?.every(row => row.state === 'completed')
      || !this.maintenanceView().ready_to_restart) return;
    const owner = this.store.get("SELECT id FROM tasks WHERE task_kind='main' ORDER BY id LIMIT 1")
      ?? this.store.get("SELECT id FROM tasks WHERE task_kind='owner' ORDER BY id LIMIT 1");
    if (!owner) return; // Do not create a root or mutate Git merely to publish an observation.
    this.store.transaction(() => {
      const notice = this.notify(owner.id, '项目中断完成',
        `维护批次 ${data.batch_id} 已全部安全收尾，并在此时通过重启屏障。重启前仍须动态确认 ready_to_restart；本告知不是永久可重启许可。`);
      data.completion_state = 'completed'; data.completion_notice_id = notice.id;
      save(this, data);
      const source = this.store.event(owner.id, 'project.interrupted', { batch_id: data.batch_id, notice_id: notice.id });
      this.store.run('UPDATE notices SET source_event_id=? WHERE id=?', source, notice.id);
      for (const root of this.store.all("SELECT id FROM tasks WHERE task_kind IN ('main','owner') AND hooks IS NOT NULL"))
        this.emitTaskHook(root.id, 'project.interrupted', source);
    });
  },

  startMaintenanceMonitor() {
    if (this.maintenanceMonitor) return;
    this.maintenanceMonitor = setInterval(() => {
      try { this.observeMaintenanceCompletion(); }
      catch { console.error('project maintenance completion observation failed; inspect project state'); }
    }, 1000);
    this.maintenanceMonitor.unref?.();
  },
  stopMaintenanceMonitor() {
    clearInterval(this.maintenanceMonitor); this.maintenanceMonitor = null;
  },
  recoverMaintenanceBatch() {
    const data = state(this);
    if (data.completion_state === 'pending') this.store.transaction(() => {
      data.completion_state = 'unknown';
      this.retireInterruptionMounts(data.batch_id, 'unknown');
      save(this, data);
      this.store.event(null, 'maintenance.unknown', { batch_id: data.batch_id, reason: '后台重启，无法确认旧批次安全收尾。' });
    });
    this.startMaintenanceMonitor();
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
    this.store.transaction(() => this.cancelMaintenanceBatch(data));
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
          this.resumeTask(id, null, task.task_kind === 'integration');
          const run = this.running.get(id);
          if (run) run.maintenancePause = false;
        }
        catch {
          this.store.event(id, 'maintenance.resume_blocked', { reason: 'Worker 安全门仍未通过，保留暂停；检查后显式继续。' });
        }
      }
    }
    this.store.transaction(() => {
      save(this, { ...empty(), batch_id: data.batch_id ?? null, participants: [],
        completion_state: data.batch_id ? 'cancelled' : null, completion_notice_id: null });
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
