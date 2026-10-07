import { check, id, TERMINAL } from '../types.js';
import { hookRevision, HOOK_LIMITS } from '../hooks.js';
import { settleNoticeAnswer } from './messages.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing } from './iteration.js';

const KEY = 'daemon_auto_select';
const DELEGATE = '请由 Agent 自行判断并继续。';
const empty = () => ({ version: 1, enabled: false, generation: 0, last_execution: null });
function state(project) {
  return JSON.parse(project.store.get('SELECT value FROM meta WHERE key=?', KEY)?.value ?? JSON.stringify(empty()));
}
function save(project, value) {
  project.store.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY, JSON.stringify(value));
}
// Execution receipts do not invalidate the authorization revision during a new arrival.
const revision = value => hookRevision({ version: 1, enabled: value.enabled, generation: value.generation });

export default {
  daemonHooks() {
    const value = state(this);
    return { version: 1, revision: revision(value), mounts: [{ id: 'auto-select', name: '自动选择',
      trigger: 'notice.received', mode: 'persistent', enabled: value.enabled, builtin: true,
      locked: false, editable: !this.stopping && !this.clearing && !this.workerDeleteIds?.size && !this.settingsMigrationApplying,
      removable: false, state: value.last_execution?.status === 'failed' ? 'failed' : value.enabled ? 'waiting' : 'idle',
      description: '单选选择第一项；多选和文字问题请 Agent 自行判断。开启时也处理已有待答问题，可能继续调用 Agent。',
      actions: [{ type: 'answer_notice', agent_call: true }], last_execution: value.last_execution }] };
  },

  setDaemonAutoSelect(enabled, expectedRevision) {
    this.assertWritable('configure daemon automatic selection');
    check(!this.stopping, 'daemon is stopping');
    check(typeof enabled === 'boolean', 'enabled must be boolean');
    this.store.transaction(() => {
      const value = state(this);
      check(typeof expectedRevision === 'string' && expectedRevision === revision(value), 'daemon Hook revision changed; reload before editing');
      save(this, { ...value, enabled, generation: value.generation + 1 });
      this.store.event(null, 'hook.daemon_configured', { hook_id: 'auto-select', enabled });
    });
    if (enabled) this.drainDaemonAutoSelect();
    return this.hooksList();
  },

  /** Runtime-only; public notice.answer never accepts a caller-supplied provenance. */
  autoAnswerNotice(noticeId) {
    if (this.stopping || this.clearing || this.workerDeleteIds?.size || this.settingsMigrationApplying || !state(this).enabled) return false;
    const notice = this.store.get('SELECT * FROM notices WHERE id=?', id(noticeId));
    if (!notice || notice.status !== 'open' || !['question', 'questionnaire'].includes(notice.kind)) return false;
    const task = this.store.task(notice.task_id);
    if (TERMINAL.has(task.status) || (task.branch && ['archived', 'deleted'].includes(this.store.branch(task.branch)?.status))) return false;
    // Automatic authorization is not permission to revive an ended tree or bypass a sync/frozen source.
    try { assertTaskAncestorsOpen(this, task); assertTaskNotSyncing(this, task.id); } catch { return false; }
    if (task.reservation) {
      const booking = JSON.parse(task.reservation);
      if (booking.version === 2 && ['requested', 'executing', 'blocked'].includes(booking.status)) return false;
    }
    const answer = notice.kind === 'questionnaire' ? { answers: JSON.parse(notice.body).questions.map(q => q.multiSelect
      ? { selected: [], custom: DELEGATE } : { selected: [0] }) } : DELEGATE;
    this.store.transaction(() => {
      settleNoticeAnswer(this, notice.id, answer, false, 'lush');
      const value = state(this), time = new Date().toISOString();
      save(this, { ...value, last_execution: { id: notice.id, notice_id: notice.id, trigger: 'notice.received',
        status: 'succeeded', created_at: time, finished_at: time } });
    });
    return true;
  },

  /** Bound each turn of backlog processing; never scan or trigger actions from a read API. */
  drainDaemonAutoSelect(after = 0) {
    if (this.stopping || !state(this).enabled) return;
    const rows = this.store.all("SELECT id FROM notices WHERE id>? AND status='open' AND kind IN ('question','questionnaire') ORDER BY id LIMIT ?", after, HOOK_LIMITS.batch);
    for (const row of rows) {
      try { this.autoAnswerNotice(row.id); }
      catch {
        // Bad legacy data or a rejected settlement remains open; never retry an unknown effect.
        const error = '自动答复未完成；原问题保留，请检查并由用户处理。';
        this.store.transaction(() => {
          const value = state(this), time = new Date().toISOString();
          save(this, { ...value, last_execution: { id: row.id, notice_id: row.id, trigger: 'notice.received',
            status: 'failed', created_at: time, finished_at: time, error } });
          this.store.event(null, 'hook.daemon_failed', { hook_id: 'auto-select', notice_id: row.id, error });
        });
      }
    }
    if (rows.length === HOOK_LIMITS.batch) queueMicrotask(() => {
      try { this.drainDaemonAutoSelect(rows.at(-1).id); }
      catch { console.error('daemon automatic selection backlog could not continue; pending questions were retained'); }
    });
  },
};
