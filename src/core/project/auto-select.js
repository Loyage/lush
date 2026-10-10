import { check, id, TERMINAL, isPlainObject } from '../types.js';
import { hookRevision, HOOK_LIMITS } from '../hooks.js';
import { settleNoticeAnswer } from './messages.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing } from './iteration.js';

// Old daemon_auto_select meta remains historical; it never grants device-wide authority.
const KEY = 'device_auto_select_receipts';
const DELEGATE = '请由 Agent 自行判断并继续。';
const CONFIG_ERROR = '设备自动化配置暂不可用；未自动答复，请检查共享设置后继续。';
const FAILURE = '自动答复未完成；原问题保留，请检查并由用户处理，未自动重试。';
const MAX_FAILURES = 1024;
const empty = () => ({ version: 1, last_execution: null, blocked: [] });
function state(project) {
  const value = JSON.parse(project.store.get('SELECT value FROM meta WHERE key=?', KEY)?.value ?? JSON.stringify(empty()));
  check(isPlainObject(value) && value.version === 1 && Array.isArray(value.blocked) && value.blocked.length <= MAX_FAILURES
    && value.blocked.every(row => isPlainObject(row) && Number.isSafeInteger(row.id) && row.id > 0
      && typeof row.identity === 'string' && /^[0-9a-f]{64}$/.test(row.identity)), 'automatic selection receipts are invalid');
  const receipt = value.last_execution;
  check(receipt === null || (isPlainObject(receipt) && Number.isSafeInteger(receipt.notice_id) && receipt.notice_id > 0
    && ['succeeded', 'failed'].includes(receipt.status) && [receipt.created_at, receipt.finished_at].every(time =>
      typeof time === 'string' && time.length <= 64 && Number.isFinite(Date.parse(time)))), 'automatic selection receipts are invalid');
  return { version: 1, blocked: value.blocked.map(row => ({ id: row.id, identity: row.identity })),
    last_execution: receipt && { id: receipt.notice_id, notice_id: receipt.notice_id, trigger: 'notice.received', scope: 'device',
      ...(typeof receipt.policy_revision === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(receipt.policy_revision) ? { policy_revision: receipt.policy_revision } : {}),
      status: receipt.status, created_at: receipt.created_at, finished_at: receipt.finished_at,
      ...(receipt.status === 'failed' ? { error: FAILURE } : {}) } };
}
function save(project, value) {
  project.store.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY, JSON.stringify(value));
}
const noticeIdentity = notice => hookRevision({ id: notice.id, task_id: notice.task_id, created_at: notice.created_at,
  kind: notice.kind, body: notice.body });
function policy(project) {
  try { return project.deviceAutomation.get(); }
  catch { return null; }
}
function stopBatch(project) {
  if (project.deviceAutoSelectBatchTimer !== null && project.deviceAutoSelectBatchTimer !== undefined)
    (project.deviceAutomationOptions.clearTimeout || clearTimeout)(project.deviceAutoSelectBatchTimer);
  project.deviceAutoSelectBatchTimer = null;
}

export default {
  /** A safe read-only mirror; receipts are project-local, authorization is device-global. */
  daemonHooks() {
    const model = policy(this);
    let receipt;
    try { receipt = state(this); } catch { receipt = { ...empty(), invalid: true }; }
    const error = !model ? CONFIG_ERROR : receipt.invalid ? FAILURE : null;
    const enabled = model?.auto_select.enabled ?? false;
    return { version: 1, scope: 'device', revision: model?.revision ?? 'unavailable',
      policy_revision: model?.revision ?? null, available: !error, error,
      mounts: [{ id: 'auto-select', name: '全局自动选择', scope: 'device',
        trigger: 'notice.received', mode: 'persistent', enabled, builtin: true,
        locked: false, editable: !error && !this.stopping && !this.clearing && !this.workerDeleteIds?.size && !this.settingsMigrationApplying,
        removable: false, state: error || receipt.last_execution?.status === 'failed' ? 'failed' : enabled ? 'waiting' : 'idle',
        reason: error, description: '所有使用该设备配置的项目共享授权；单选第一项，多选和文字问题请 Agent 判断。开启也处理已有问题，可能继续调用 Agent。',
        actions: [{ type: 'answer_notice', agent_call: true }], last_execution: receipt.last_execution }] };
  },

  /** Cheap invalidation fact only; never starts a backlog scan from a read API. */
  deviceAutomationRevision() { return policy(this)?.revision ?? 'unavailable'; },

  setDaemonAutoSelect(enabled, expectedRevision) {
    this.assertWritable('configure device automatic selection');
    check(!this.stopping, 'daemon is stopping');
    const value = this.deviceAutomation.save({ auto_select: { enabled } }, expectedRevision);
    this.store.event(null, 'hook.daemon_configured', { hook_id: 'auto-select', enabled, scope: 'device', policy_revision: value.revision });
    // This user mutation may drain this project. Other daemons observe the same file independently.
    this.refreshDeviceAutomation();
    return this.hooksList();
  },

  /** Runtime-only; public notice.answer never accepts caller-supplied provenance. */
  autoAnswerNotice(noticeId) {
    noticeId = id(noticeId);
    if (this.stopping || this.maintenancePaused() || this.clearing || this.workerDeleteIds?.size || this.settingsMigrationApplying
      || !policy(this)?.auto_select.enabled) return false;
    // Notice creation still calls us inside its transaction. Hold the policy lock through a REAL
    // outer commit, not a nested savepoint: defer until creation has committed (or rolled back).
    if (this.store.db.inTransaction) {
      this.deviceAutoSelectDeferred ||= new Set();
      if (!this.deviceAutoSelectDeferred.has(noticeId)) {
        this.deviceAutoSelectDeferred.add(noticeId);
        queueMicrotask(() => {
          this.deviceAutoSelectDeferred.delete(noticeId);
          if (this.stopping) return;
          try { this.autoAnswerNotice(noticeId); }
          catch { this.recordDeviceAutoSelectFailure(noticeId); }
        });
      }
      return false;
    }
    let entered = false;
    try {
      return this.deviceAutomation.withPolicy(model => {
        entered = true;
        if (!model.auto_select.enabled || this.stopping || this.clearing || this.workerDeleteIds?.size || this.settingsMigrationApplying) return false;
        const notice = this.store.get('SELECT * FROM notices WHERE id=?', noticeId);
        if (!notice || notice.status !== 'open' || !['question', 'questionnaire'].includes(notice.kind)) return false;
        const receipt = state(this), identity = noticeIdentity(notice);
        if (receipt.blocked.length === MAX_FAILURES || receipt.blocked.some(row => row.identity === identity)) return false;
        const task = this.store.task(notice.task_id);
        if (TERMINAL.has(task.status) || (task.branch && ['archived', 'deleted'].includes(this.store.branch(task.branch)?.status))) return false;
        // Authorization never revives an ended tree or bypasses delivery/sync safety gates.
        try { assertTaskAncestorsOpen(this, task); assertTaskNotSyncing(this, task.id); } catch { return false; }
        if (task.reservation) {
          const booking = JSON.parse(task.reservation);
          if (booking.version === 2 && ['requested', 'executing', 'blocked'].includes(booking.status)) return false;
        }
        const answer = notice.kind === 'questionnaire' ? { answers: JSON.parse(notice.body).questions.map(q => q.multiSelect
          ? { selected: [], custom: DELEGATE } : { selected: [0] }) } : DELEGATE;
        this.store.transaction(() => {
          settleNoticeAnswer(this, notice.id, answer, false, 'lush');
          const time = new Date().toISOString();
          save(this, { ...receipt, last_execution: { id: notice.id, notice_id: notice.id, trigger: 'notice.received',
            scope: 'device', policy_revision: model.revision, status: 'succeeded', created_at: time, finished_at: time } });
        });
        return true;
      });
    } catch (error) {
      // Busy/invalid shared configuration never prevents the original Notice from being retained.
      if (!entered) { this.deviceAutomationExecutionIssue = CONFIG_ERROR; return false; }
      throw error;
    }
  },

  recordDeviceAutoSelectFailure(noticeId) {
    if (this.stopping) return;
    const notice = this.store.get('SELECT * FROM notices WHERE id=?', noticeId);
    if (!notice) return;
    try {
      const value = state(this), identity = noticeIdentity(notice);
      if (value.blocked.some(row => row.identity === identity) || value.blocked.length === MAX_FAILURES) return;
      this.store.transaction(() => {
        const time = new Date().toISOString();
        save(this, { ...value, blocked: [...value.blocked, { id: notice.id, identity }], last_execution: {
          id: notice.id, notice_id: notice.id, trigger: 'notice.received', scope: 'device', status: 'failed',
          created_at: time, finished_at: time, error: FAILURE } });
        this.store.event(notice.task_id, 'hook.daemon_failed', { hook_id: 'auto-select', notice_id: notice.id, scope: 'device', error: FAILURE });
      });
    } catch { this.deviceAutomationExecutionIssue = FAILURE; }
  },

  /** Bounded batches yield to I/O; no unbounded microtask chain can starve a global close request. */
  drainDaemonAutoSelect(after = 0) {
    if (this.stopping || this.maintenancePaused() || this.clearing || this.workerDeleteIds?.size || this.settingsMigrationApplying || !policy(this)?.auto_select.enabled) {
      stopBatch(this); return;
    }
    const rows = this.store.all("SELECT id FROM notices WHERE id>? AND status='open' AND kind IN ('question','questionnaire') ORDER BY id LIMIT ?", after, HOOK_LIMITS.batch);
    for (const row of rows) {
      try { this.autoAnswerNotice(row.id); }
      catch { this.recordDeviceAutoSelectFailure(row.id); }
    }
    if (rows.length === HOOK_LIMITS.batch && !this.deviceAutoSelectBatchTimer && !this.stopping) {
      this.deviceAutoSelectBatchTimer = (this.deviceAutomationOptions.setTimeout || setTimeout)(() => {
        this.deviceAutoSelectBatchTimer = null;
        this.drainDaemonAutoSelect(rows.at(-1).id);
      }, 0);
      this.deviceAutoSelectBatchTimer?.unref?.();
    }
  },

  /** Only runtime entry points call this method; read projections do not apply policy or answer. */
  refreshDeviceAutomation() {
    if (this.stopping || this.clearing || this.workerDeleteIds?.size || this.settingsMigrationApplying) return false;
    const model = policy(this);
    if (!model) { stopBatch(this); this.deviceAutomationExecutionIssue = CONFIG_ERROR; return false; }
    this.deviceAutomationExecutionIssue = null;
    // Only manual settlement/deletion releases a failed identity. Retaining open failures prevents
    // retries after restart; pruning resolved ones bounds receipts without disabling the project forever.
    let receipt;
    try { receipt = state(this); } catch { this.deviceAutomationExecutionIssue = FAILURE; return false; }
    if (receipt.blocked.length) {
      const pending = new Set(this.store.all(`SELECT id FROM notices WHERE status='open' AND id IN (${receipt.blocked.map(() => '?').join(',')})`,
        ...receipt.blocked.map(row => row.id)).map(row => row.id));
      const blocked = receipt.blocked.filter(row => pending.has(row.id));
      if (blocked.length !== receipt.blocked.length) save(this, { ...receipt, blocked });
    }
    if (this.deviceAutomationObservedRevision !== model.revision) {
      this.deviceAutomationObservedRevision = model.revision;
      this.store.event(null, 'hook.daemon_configured', { hook_id: 'auto-select', enabled: model.auto_select.enabled,
        scope: 'device', policy_revision: model.revision, via: 'device_policy_observed' });
    }
    if (!model.auto_select.enabled) stopBatch(this);
    else if (!this.deviceAutoSelectBatchTimer) this.drainDaemonAutoSelect();
    return true;
  },

  startDeviceAutomationMonitor() {
    if (this.deviceAutomationMonitor || this.stopping) return;
    this.refreshDeviceAutomation();
    this.deviceAutomationMonitor = (this.deviceAutomationOptions.setInterval || setInterval)(() => {
      if (!this.stopping) this.refreshDeviceAutomation();
    }, 1000);
    this.deviceAutomationMonitor?.unref?.();
  },

  stopDeviceAutomationMonitor() {
    if (this.deviceAutomationMonitor !== null && this.deviceAutomationMonitor !== undefined)
      (this.deviceAutomationOptions.clearInterval || clearInterval)(this.deviceAutomationMonitor);
    this.deviceAutomationMonitor = null;
    stopBatch(this);
  },
};
