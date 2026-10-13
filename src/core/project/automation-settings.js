import { randomUUID } from 'node:crypto';
import { check, id, isPlainObject, isSettled, TERMINAL } from '../types.js';
import { hookRevision } from '../hooks.js';
import { workerLabel } from '../worker-number.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing, taskSyncDeliveryPaused, assertNoPartialParentAcceptance } from './iteration.js';
import { completionRound } from './completion.js';

const KEY = 'project_automation_settings';
const initial = () => ({ version: 1, generation: null, completion_defaults: { enabled: false, level: 'merge' },
  acceptance_notice_defaults: { enabled: true },
  display_principles: { completion: 'all', push: 'all', convergence: 'all', acceptance_notice: 'all' } });
function object(value, keys, label) {
  check(isPlainObject(value) && Object.keys(value).length > 0 && Object.keys(value).every(key => keys.includes(key)), `invalid ${label} fields`);
}
function patchSettings(value, patch) {
  object(patch, ['completion_defaults','acceptance_notice_defaults','display_principles'], 'project automation patch');
  const next = { ...value, generation: randomUUID() };
  for (const key of ['completion_defaults','acceptance_notice_defaults']) if (Object.hasOwn(patch, key)) {
    object(patch[key], key === 'completion_defaults' ? ['enabled','level'] : ['enabled'], key);
    if (Object.hasOwn(patch[key], 'enabled')) check(typeof patch[key].enabled === 'boolean', `${key} enabled must be boolean`);
    if (Object.hasOwn(patch[key], 'level')) check(['merge','accept','archive'].includes(patch[key].level), 'completion level must be merge or accept');
    next[key] = { ...value[key], ...patch[key] };
    if (next[key].level === 'archive') next[key].level = 'accept';
  }
  if (Object.hasOwn(patch, 'display_principles')) {
    object(patch.display_principles, Object.keys(value.display_principles), 'display principles');
    check(Object.values(patch.display_principles).every(v => ['main','all','user'].includes(v)), 'display principle must be main, all or user');
    next.display_principles = { ...value.display_principles, ...patch.display_principles };
  }
  return next;
}
function stored(project) {
  return JSON.parse(project.store.get('SELECT value FROM meta WHERE key=?', KEY)?.value ?? JSON.stringify(initial()));
}
const config = task => JSON.parse(task.auto_merge ?? '{"version":1,"enabled":false,"locked":false}');

export default {
  automationSettings() {
    const value = stored(this);
    return { version: 1, revision: hookRevision(value), completion_defaults: { ...value.completion_defaults },
      acceptance_notice_defaults: { ...value.acceptance_notice_defaults }, display_principles: { ...value.display_principles } };
  },

  setAutomationSettings(patch, expectedRevision) {
    this.assertWritable('configure project automation');
    patchSettings(initial(), patch);
    this.store.transaction(() => {
      const value = stored(this);
      check(typeof expectedRevision === 'string' && hookRevision(value) === expectedRevision, 'automation revision changed; reload before editing');
      const next = patchSettings(value, patch);
      this.store.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY, JSON.stringify(next));
      this.store.event(null, 'hook.automation_settings_configured', { scope: 'project', revision: hookRevision(next), patch });
    });
    return this.hooksList();
  },

  acceptanceNoticeView(task) {
    const enabled = config(task).acceptance_notice?.enabled ?? ['order','say'].includes(task.task_kind);
    let reason = null;
    if (!['order','say','child'].includes(task.task_kind)) reason = '仅指令和派生 Worker 支持待验收告知';
    else if (TERMINAL.has(task.status) || ['archived','deleted'].includes(this.store.branch(task.branch)?.status)) reason = 'Worker 已结束或归档';
    else if (['requested','executing','resolving','blocked','suspended'].includes(JSON.parse(task.reservation ?? 'null')?.status)
      || task.branch && this.branchFreeze(task.branch)) reason = '交付请求或分支已冻结，不能修改告知';
    else if (this.completionBusy?.has(task.id) || this.acceptanceBusy?.has(task.id) || this.workspaces.busy.has(task.id) || this.commandHookRunning?.has(task.id)) reason = '自动动作正在执行，等待安全收尾';
    else if (this.taskSyncBusy?.has(task.id) || taskSyncDeliveryPaused(this, task.id)) reason = '父同步正在执行或交付已暂停';
    if (!reason) try { assertTaskAncestorsOpen(this, task); assertNoPartialParentAcceptance(this, task.id); }
    catch { reason = '祖先已结束或验收资源回收未完成'; }
    return { enabled, editable: !reason, reason };
  },

  setTaskAcceptanceNotice(taskId, enabled, expectedRevision) {
    this.assertWritable('configure acceptance notice');
    check(typeof enabled === 'boolean', 'enabled must be boolean');
    const task = this.store.task(id(taskId));
    check(typeof expectedRevision === 'string' && this.taskHooks(task.id).revision === expectedRevision, 'Hook revision changed; reload before editing');
    const view = this.acceptanceNoticeView(task); check(view.editable, view.reason);
    assertTaskNotSyncing(this, task.id);
    this.store.transaction(() => {
      this.store.update(task.id, { auto_merge: JSON.stringify({ ...config(task), acceptance_notice: { enabled } }) });
      this.store.event(task.id, 'task.acceptance_notice_changed', { enabled });
    });
    // Configuration never backfills a completed transition.
    return this.taskHooks(task.id);
  },

  /** Called only by real settlement transitions, never by reads or recovery scans. */
  notifyAcceptanceEntry(taskId, sourceEventId) {
    return this.store.transaction(() => {
      const task = this.store.task(taskId);
      if (!['order','say','child'].includes(task.task_kind) || task.status !== 'awaiting_acceptance') return null;
      const event = this.store.get('SELECT id FROM events WHERE id=? AND task_id=?', sourceEventId, task.id);
      check(event, 'acceptance source event does not belong to this Worker');
      if (this.hasActionableMessages(task.id) || this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open' LIMIT 1", task.id)
        || this.store.children(task.id).some(child => !isSettled(child))) return null;
      const round = completionRound(this, task.id);
      if (this.store.get("SELECT id FROM events WHERE task_id=? AND type='task.acceptance_notice_observed' AND json_extract(data,'$.round')=? LIMIT 1", task.id, round)) return null;
      const enabled = this.acceptanceNoticeView(task).enabled;
      // Explicit automatic acceptance keeps successful intermediate settlement silent.
      const automatic = ['accept','archive'].includes(this.autoCompletionView(task)?.level);
      const notice = enabled && !automatic ? this.notify(task.id,
        `Worker ${workerLabel(task)} · ${task.task_kind === 'child' ? '待父确认' : '待验收'}`,
        `${task.task_kind === 'child' ? '成果已交付，等待直接父 Worker 检查确认，默认保留现场供追加需求。' : '本轮成果已交付，请检查并验收；验收将安全回收 worktree/ref，保留运行历史。'}\n${task.integration === 'merged' ? '已合入父分支。' : '本轮无代码改动，不产生合并提交。'}\n${String(task.result ?? '').slice(0, 1200)}\n打开 Worker ${workerLabel(task)} 查看详情；待验收不代表 Worker 已验收完成。`, event.id) : null;
      this.store.event(task.id, 'task.acceptance_notice_observed', { round, source_event_id: event.id, enabled,
        automatic_acceptance: automatic, notice_id: notice?.id ?? null });
      return notice;
    });
  },
};
