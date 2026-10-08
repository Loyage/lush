import { randomUUID } from 'node:crypto';
import { check, isPlainObject } from '../types.js';
import { hookRevision } from '../hooks.js';
import { normalizeHookSchedule, nextHookRun } from '../hook-schedule.js';
import { MANAGEMENT_LIMITS, managementState, managementTime } from './management-data.js';

const empty = () => ({ version: 1, config_revision: 0, items: [] });
function read(project) {
  return JSON.parse(project.store.get("SELECT value FROM meta WHERE key='hook_signals'")?.value ?? JSON.stringify(empty()));
}
function save(project, library) {
  const encoded = JSON.stringify(library);
  check(Buffer.byteLength(encoded) <= MANAGEMENT_LIMITS.bytes, 'signal library exceeds 128 KiB');
  project.store.run("INSERT INTO meta(key,value) VALUES ('hook_signals',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", encoded);
}
const revision = library => hookRevision({ version: library.version, config_revision: library.config_revision });
const isLive = signal => signal.enabled && !signal.consumed;
const future = (signal, clock) => nextHookRun(signal.schedule, Math.max(clock, Date.parse(signal.last_due_at ?? '') || clock));

export default {
  hookSignals() {
    const library = read(this);
    return { version: 1, revision: revision(library), items: library.items.map(signal => ({ id: signal.id, name: signal.name,
      enabled: isLive(signal), schedule: signal.schedule, next_run_at: signal.next_run_at ?? null,
      last_due_at: signal.last_due_at ?? null, last_execution: signal.last_execution ?? null })) };
  },

  saveHookSignal(raw, expectedRevision) {
    this.assertWritable('save a time signal');
    check(isPlainObject(raw) && Object.keys(raw).every(key => ['id','name','enabled','schedule'].includes(key)), 'invalid signal fields');
    check(typeof raw.name === 'string' && raw.name.trim().length > 0 && raw.name.length <= 200, 'signal name must be non-empty text (max 200 characters)');
    check(raw.enabled === undefined || typeof raw.enabled === 'boolean', 'signal enabled must be boolean');
    const schedule = normalizeHookSchedule(raw.schedule, raw.schedule?.kind === 'once' ? 'once' : 'persistent');
    const library = read(this);
    check(typeof expectedRevision === 'string' && revision(library) === expectedRevision, 'signal revision changed; reload before editing');
    const old = raw.id === undefined ? null : library.items.find(item => item.id === raw.id);
    check(raw.id === undefined || old, 'signal not found');
    check(old || library.items.length < MANAGEMENT_LIMITS.signals, 'signal count limit reached');
    const enabled = raw.enabled ?? old?.enabled ?? true;
    const unchangedSchedule = old && JSON.stringify(old.schedule) === JSON.stringify(schedule);
    const consumed = unchangedSchedule && old.consumed === true;
    check(!(enabled && consumed), 'one-shot signal already emitted or skipped; schedule a new time instead of replaying');
    if (enabled && schedule.kind === 'once') check(Date.parse(schedule.at) > this.hookClock(), 'one-shot signal must be scheduled in the future');
    const signal = { id: old?.id ?? randomUUID(), name: raw.name.trim(), enabled, schedule,
      consumed: Boolean(consumed), next_run_at: enabled && !consumed ? nextHookRun(schedule,
        unchangedSchedule ? Math.max(this.hookClock(), Date.parse(old.last_due_at ?? '') || this.hookClock()) : this.hookClock()) : null,
      last_due_at: old?.last_due_at ?? null, last_execution: old?.last_execution ?? null };
    this.store.transaction(() => {
      if (old) library.items[library.items.indexOf(old)] = signal; else library.items.push(signal);
      library.config_revision += 1; save(this, library);
      this.store.event(null, 'hook.signal_saved', { signal_id: signal.id, name: signal.name, enabled: isLive(signal) });
    });
    this.armScheduledHookTimer();
    return this.hooksList();
  },

  removeHookSignal(signalId, expectedRevision) {
    this.assertWritable('remove a time signal');
    const library = read(this);
    check(typeof expectedRevision === 'string' && revision(library) === expectedRevision, 'signal revision changed; reload before editing');
    check(library.items.some(item => item.id === signalId), 'signal not found');
    const used = this.store.all(`SELECT id,management FROM tasks WHERE task_kind='management' AND management IS NOT NULL
      AND (json_extract(management,'$.enabled')=1 OR json_extract(management,'$.pending_signal') IS NOT NULL)`)
      .some(task => { const binding = managementState(task); return binding.signal_id === signalId && (binding.enabled || (binding.pending_signal && !['failed','unknown'].includes(binding.state))); });
    check(!used, 'signal has enabled or unfinished management bindings; disable and settle them before removing');
    this.store.transaction(() => {
      library.items = library.items.filter(item => item.id !== signalId); library.config_revision += 1; save(this, library);
      this.store.event(null, 'hook.signal_removed', { signal_id: signalId });
    });
    this.armScheduledHookTimer();
    return this.hooksList();
  },

  managementTimerDeadline(clock) {
    let deadline = Infinity;
    for (const signal of read(this).items) if (isLive(signal) && signal.next_run_at)
      deadline = Math.min(deadline, Date.parse(signal.next_run_at));
    for (const task of this.store.all(`SELECT id,management FROM tasks WHERE task_kind='management'
      AND json_extract(management,'$.enabled')=1 AND json_extract(management,'$.pending_signal') IS NOT NULL`)) {
      const binding = managementState(task);
      if (binding.enabled && binding.pending_signal && (binding.pending_signal.phase === 'pending'
        || (binding.receipts ?? []).some(receipt => receipt.status === 'waiting'))) deadline = Math.min(deadline, clock + 1000);
    }
    return deadline;
  },

  observeHookSignals(clock = this.hookClock()) {
    if (this.stopping || this.recoveringHooks || this.clearing || this.workerDeleteIds?.size || this.settingsMigrationApplying) return;
    const library = read(this);
    for (const signal of library.items) {
      if (!isLive(signal) || !signal.next_run_at || Date.parse(signal.next_run_at) > clock) continue;
      const dueAt = signal.next_run_at;
      this.store.transaction(() => {
        // Persist advancement and fanout at the same durable boundary. A clock rollback cannot repeat this identity.
        const occurrenceId = this.store.event(null, 'hook.signal_emitted', { signal_id: signal.id, name: signal.name, due_at: dueAt });
        signal.last_due_at = dueAt; signal.consumed = signal.schedule.kind === 'once';
        signal.next_run_at = signal.consumed ? null : future(signal, clock);
        signal.last_execution = { id: occurrenceId, status: 'succeeded', due_at: dueAt, created_at: managementTime(this) };
        save(this, library);
        for (const task of this.store.all(`SELECT id,management FROM tasks WHERE task_kind='management'
          AND json_extract(management,'$.enabled')=1 ORDER BY id`)) {
          const binding = managementState(task);
          if (binding.signal_id === signal.id && binding.enabled) this.submitManagementSignal(task.id,
            { id: occurrenceId, signal_id: signal.id, name: signal.name, due_at: dueAt, submitted_at: managementTime(this) });
        }
      });
    }
    this.drainManagementActions();
  },

  recoverHookSignals(clock) {
    const library = read(this);
    for (const signal of library.items) {
      if (!isLive(signal)) continue;
      if (signal.schedule.kind === 'once' && Date.parse(signal.next_run_at ?? signal.schedule.at) <= clock) {
        const occurrenceId = this.store.event(null, 'hook.signal_missed', { signal_id: signal.id, due_at: signal.schedule.at });
        signal.consumed = true; signal.next_run_at = null;
        signal.last_due_at = signal.schedule.at;
        signal.last_execution = { id: occurrenceId, status: 'skipped', due_at: signal.schedule.at,
          created_at: managementTime(this), reason: '项目后台停机期间错过指定时间，本次信号跳过。' };
      } else signal.next_run_at = future(signal, clock);
    }
    save(this, library);
    this.recoverManagementWorkers();
  },
};
