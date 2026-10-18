import { check } from '../types.js';
import { hookRevision } from '../hooks.js';
import { managementState, managementTime, saveManagement } from './management-data.js';

const limit = 100;
const reason = '用户急救已永久撤销此管家的旧授权；历史与未知副作用保留，不重放、不回滚。';
const rows = project => project.store.all("SELECT * FROM tasks WHERE task_kind='management' ORDER BY id");
const needsStop = task => managementState(task)?.emergency?.status !== 'isolated';
const label = task => ({ id: task.id, worker_number: typeof task.worker_number === 'string' && task.worker_number.length <= 128 ? task.worker_number : null });
const lastRequest = project => project.store.get("SELECT value FROM meta WHERE key='management_emergency'")?.value ?? null;

/** Only actual runtime owners block isolation. Never delete an owner to manufacture exit. */
export function managementEmergencyBlockers(project, task, state = managementState(task)) {
  const kinds = [];
  if (project.running.has(task.id)) kinds.push('provider_cleanup');
  if (project.managementControlOwners?.has(task.id)) kinds.push('control_owner');
  if ((state?.control_calls ?? []).some(call => project.managementControlBusy?.has(call.receipt_id))) kinds.push('control_busy');
  return kinds;
}
function snapshot(project) {
  const tasks = rows(project);
  // Hash ALL private affected facts, not the bounded public preview. No asynchronous gap
  // exists between this snapshot's CAS and durable revocation in emergencyStop().
  const facts = tasks.map(task => ({ id: task.id, management: task.management, status: task.status,
    calls: task.calls, running: project.running.has(task.id), run_id: project.running.get(task.id)?.recordId ?? null,
    aborted: project.running.get(task.id)?.controller.signal.aborted ?? false,
    owners: project.managementControlOwners?.get(task.id) ?? 0,
    busy: (managementState(task)?.control_calls ?? []).filter(call => project.managementControlBusy?.has(call.receipt_id)).map(call => call.receipt_id),
    decisions: project.store.all("SELECT id,kind,status FROM notices WHERE task_id=? AND status='open' AND kind!='info' ORDER BY id", task.id) }));
  return { tasks, facts, revision: hookRevision({ version: 1, facts, last_request: lastRequest(project) }) };
}
function result(project, revision) {
  const ids = new Set(project.store.all(`SELECT task_id FROM events WHERE type='management.emergency_requested'
    AND json_extract(data,'$.request_revision')=?`, revision).map(row => row.task_id));
  const tasks = rows(project).filter(task => ids.has(task.id));
  const blockers = tasks.map(task => ({ ...label(task), kinds: managementEmergencyBlockers(project, task) })).filter(item => item.kinds.length);
  const blockedIds = new Set(blockers.map(item => item.id));
  const stopping = tasks.filter(task => blockedIds.has(task.id) || managementState(task).emergency.status !== 'isolated').length;
  return { version: 1, scope: 'current_project', request_revision: revision, status: stopping ? 'stopping' : 'isolated',
    affected_total: tasks.length, isolated_total: tasks.length - stopping, stopping_total: stopping,
    blockers: blockers.slice(0, limit), blockers_total: blockers.length, blockers_truncated: blockers.length > limit,
    history_preserved: true };
}

export default {
  managementEmergencyPreview() {
    const { tasks, facts, revision } = snapshot(this);
    const affected = tasks.filter(needsStop);
    const totals = { enabled: 0, pending_occurrences: 0, unstarted_actions: 0, unstarted_calls: 0,
      started_receipts: 0, unknown_receipts: 0, open_decisions: 0, live_workers: 0 };
    const decisionCounts = new Map(facts.map(item => [item.id, item.decisions.length]));
    const items = [];
    for (const task of affected) {
      const state = managementState(task), calls = state?.control_calls ?? [], receipts = state?.receipts ?? [];
      const kinds = managementEmergencyBlockers(this, task, state);
      const counts = { enabled: state?.enabled ? 1 : 0, pending_occurrences: state?.pending_signal ? 1 : 0,
        unstarted_actions: receipts.filter(item => item.status === 'waiting').length,
        unstarted_calls: calls.filter(item => ['pending_confirmation','approved'].includes(item.status)).length,
        started_receipts: [...calls, ...receipts].filter(item => item.status === 'running').length,
        unknown_receipts: [...calls, ...receipts].filter(item => item.status === 'unknown').length,
        open_decisions: decisionCounts.get(task.id), live_workers: kinds.length ? 1 : 0 };
      for (const key of Object.keys(totals)) totals[key] += counts[key];
      if (items.length < limit) items.push({ ...label(task), ...counts, blockers: kinds });
    }
    return { version: 1, scope: 'current_project', revision, total: tasks.length, affected_total: affected.length,
      already_isolated_total: tasks.filter(task => managementState(task)?.emergency?.status === 'isolated').length,
      stopping_total: tasks.filter(task => managementState(task)?.emergency?.status === 'stopping').length,
      items, items_truncated: affected.length > items.length, totals, history_preserved: true };
  },

  managementEmergencyStop(revision, confirm) {
    this.assertWritable('emergency stop management Workers');
    check(confirm === true, 'management emergency requires confirm:true');
    check(typeof revision === 'string' && revision.length > 0 && revision.length <= 256, 'management emergency requires an exact preview revision');
    // A network retry refers only to its original set, never a newly created Valet.
    if (lastRequest(this) === revision) return result(this, revision);
    const preview = snapshot(this);
    check(revision === preview.revision, 'management emergency revision changed; reload preview and confirm again');
    const affected = preview.tasks.filter(needsStop);
    this.store.transaction(() => {
      for (const task of affected) {
        if (managementState(task)?.emergency) {
          // A fresh exact confirmation can include an earlier request still stopping.
          // Its audit scope must keep that real owner visible until cleanup finishes.
          this.store.event(task.id, 'management.emergency_requested', { request_revision: revision });
          continue;
        }
        const state = managementState(task) ?? { version: 1, config_revision: 0, receipts: [], control_calls: [] };
        state.enabled = false; state.consumed = true; state.config_revision += 1;
        state.emergency = { status: 'stopping', request_revision: revision, requested_at: managementTime(this) };
        this.revokeManagementCapabilities(task.id, state);
        for (const receipt of state.receipts ?? []) if (receipt.status === 'waiting') {
          receipt.status = 'skipped'; receipt.reason = reason;
          this.store.event(task.id, 'management.action_skipped', { occurrence_id: receipt.occurrence_id, ...receipt });
        }
        // Include own questions and historical orphan confirmations, not only the
        // current receipt's Notice. Keep answers, runs, messages and effects intact.
        this.store.run("UPDATE notices SET status='dismissed',answer='management emergency isolation' WHERE task_id=? AND status='open' AND kind!='info'", task.id);
        saveManagement(this, task.id, state);
        this.store.update(task.id, { status: 'cancelled', interrupt_state: null });
        this.store.event(task.id, 'management.emergency_requested', { request_revision: revision });
      }
      this.store.run("INSERT INTO meta(key,value) VALUES ('management_emergency',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", revision);
    });
    // The standard Provider abort kills its guarded process group. Persist all
    // revocations first; synchronous abort listeners cannot resurrect a stale state.
    for (const task of affected) this.running.get(task.id)?.controller.abort(new Error(reason));
    for (const task of affected) this.settleManagementEmergency(task.id);
    this.armScheduledHookTimer(); this.kick();
    return result(this, revision);
  },

  /** Called by real Provider/control cleanup and restart recovery, never by user polling. */
  settleManagementEmergency(taskId) {
    const task = this.store.task(taskId), state = managementState(task);
    if (!state?.emergency || state.emergency.status === 'isolated' || managementEmergencyBlockers(this, task, state).length) return;
    this.store.transaction(() => {
      // No live owner remains. A durable started receipt without a completion is
      // unknown, NOT cancelled/successful. Pending occurrence and old history stay.
      for (const receipt of [...(state.receipts ?? []), ...(state.control_calls ?? [])]) if (receipt.status === 'running') {
        receipt.status = 'unknown'; receipt.reason = '急救后实际操作已退出，但未观察到完成证明；不自动重放。';
      }
      state.emergency.status = 'isolated'; state.emergency.isolated_at = managementTime(this);
      saveManagement(this, taskId, state);
      this.store.event(taskId, 'management.emergency_isolated', { request_revision: state.emergency.request_revision });
    });
    this.kick();
  },
};
