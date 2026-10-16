import { isSettled, TERMINAL } from '../../core/types.js';

// Observation only: never consult admission gates or interpret a merge reservation.
// These snapshots describe known waits, not permission to run/deliver/accept.
export const workerPhases = {
  workerPhaseSnapshot(taskId) {
    const task = this.task(taskId);
    const run = task.calls ? this.get('SELECT id FROM agent_runs WHERE task_id=? AND attempt=? ORDER BY id DESC LIMIT 1', task.id, task.calls) : null;
    let phase = 'unknown', reason = 'unknown', children = [], notices = [];
    if (task.status === 'running') { phase = 'running'; reason = 'invocation'; }
    else if (task.status === 'queued') { phase = 'queued'; reason = 'admission_unknown'; }
    else if (TERMINAL.has(task.status) || ['paused', 'awaiting_acceptance'].includes(task.status)) {
      phase = task.status; reason = task.status;
    } else if (['waiting', 'awaiting'].includes(task.status)) {
      notices = this.all("SELECT id,kind FROM notices WHERE task_id=? AND status='open' ORDER BY id", task.id);
      children = this.all('SELECT id,worker_number,status,task_kind,integration FROM tasks WHERE parent_id=? ORDER BY id', task.id)
        .filter(child => !isSettled(child)).map(child => ({ id: child.id, worker_number: child.worker_number }));
      if (notices.length) { phase = 'waiting_notice'; reason = notices.some(row => row.kind === 'questionnaire') ? 'questionnaire' : 'notice'; }
      else if (children.length) { phase = 'waiting_children'; reason = 'children_unsettled'; }
      else if (task.status === 'waiting') { phase = 'idle'; } // no known wait object; not a delivery/readiness claim
    }
    return { phase, status: task.status, reason, child_ids: children.map(row => row.id), children,
      notice_ids: notices.map(row => row.id), notices, run_id: run?.id ?? null };
  },

  /** Caller owns the fact-changing transaction. No read path calls this method. */
  recordWorkerPhase(taskId, before = null) {
    const after = this.workerPhaseSnapshot(taskId);
    const row = this.get("SELECT data FROM events WHERE task_id=? AND type='worker.phase_changed' ORDER BY id DESC LIMIT 1", taskId);
    const previous = row ? JSON.parse(row.data) : null;
    const comparable = value => JSON.stringify(value);
    const prior = previous ? { phase: previous.to, status: previous.to_status, reason: previous.reason,
      child_ids: previous.child_ids, children: previous.children, notice_ids: previous.notice_ids,
      notices: previous.notices, run_id: previous.run_id } : before;
    if (prior && comparable(prior) === comparable(after)) return null;
    // An unchanged write to legacy data must not manufacture a historical boundary.
    if (!previous && before && comparable(before) === comparable(after)) return null;
    return this.event(taskId, 'worker.phase_changed', { version: 1, from: prior?.phase ?? 'unknown', to: after.phase,
      from_status: prior?.status ?? null, to_status: after.status, reason: after.reason,
      child_ids: after.child_ids, children: after.children, notice_ids: after.notice_ids, notices: after.notices,
      run_id: after.run_id });
  },
};
