import { randomUUID } from 'node:crypto';
import { check } from './types.js';
import { abandonRecoveryState } from './runner-deployment-recovery-view.js';

// Only a positively acknowledged rejection may be classified as failed. Ordinary exceptions,
// disconnects, cancellation and receipt publication failures remain unknown, never retryable.
export class DeploymentRejection extends Error {
  constructor() { super('Deployment stage rejected; inspect partial results before any further action'); }
}
const messages = { running: '已发送，等待确认', complete: '已确认完成', failed: '已拒绝；请检查已完成步骤和部分现场', unknown: '结果未知；不得重试或另建计划绕过' };

/** Internal stage journal; callbacks/factories are trusted code, never JSON/RPC dispatch.
 * Every asynchronous stage has a durable CAS intent before callback invocation. No global write
 * lock survives an await. The operation flock survives the complete workflow and cleanup instead.
 */
export class DeploymentOperations {
  #active = new Map(); #closed = false; #closing;
  constructor(store) { this.store = store; }
  get pending() { return this.#active.size; }
  view(record) {
    const value = structuredClone(record);
    const observation = Array.isArray(value.private_data.reconciliations) ? value.private_data.reconciliations.at(-1) : null;
    const recoveries = Array.isArray(value.private_data.recovery?.items) ? value.private_data.recovery.items : [];
    const abandoned = (value.status === 'running' || observation?.status === 'running' || recoveries.some(item => item.status === 'running'
      || item.observations?.some(o => o.status === 'running'))) && !this.store.isActive(value.id);
    if (abandoned) abandonRecoveryState(value.private_data.recovery);
    if (observation?.status === 'running' && abandoned) observation.status = 'unknown';
    if (value.status === 'running' && abandoned) {
      value.status = 'unknown';
      for (const stage of value.stages) if (stage.status === 'running') Object.assign(stage, { status: 'unknown', message: messages.unknown });
    }
    return value;
  }
  #guard(entry) {
    check(!this.#closed && !entry.failed && !entry.closing && !entry.disposing, 'Deployment operation is stopping or uncertain');
    entry.lease.assert();
  }
  #checkpoint(entry, mutate) {
    this.#guard(entry);
    entry.record = this.store.change(entry.record.id, entry.record.revision, row => {
      mutate(row);
      if (entry.observation) {
        const strip = value => { const copy = structuredClone(value); delete copy.private_data.reconciliations; return JSON.stringify(copy); };
        check(strip(row) === strip(entry.record) && JSON.stringify(row.private_data.reconciliations.slice(0, -1)) === JSON.stringify(entry.record.private_data.reconciliations.slice(0, -1)), 'Inspection cannot change original deployment facts');
        const before = entry.record.private_data.reconciliations.at(-1), after = row.private_data.reconciliations.at(-1);
        check(after.id === entry.operation_id && after.status === 'running' && ['id', 'request_id', 'status', 'from_revision', 'original_operation_id', 'created_at']
          .every(key => after[key] === before[key]), 'Deployment inspection identity cannot change');
      } else check(row.status === 'running' && row.private_data.operation_id === entry.operation_id, 'Deployment operation identity cannot change');
    }, { guard: () => this.#guard(entry) });
    return structuredClone(entry.record);
  }
  #fail(entry, status) {
    entry.failed = true;
    try {
      const latest = this.store.read(entry.record.id);
      if (entry.observation) {
        const observation = latest.private_data.reconciliations?.at(-1);
        if (observation?.id !== entry.operation_id || observation.status !== 'running') { entry.record = latest; return; }
        entry.record = this.store.change(latest.id, latest.revision, row => { row.private_data.reconciliations.at(-1).status = 'unknown'; }, { guard: entry.lease.assert });
        return;
      }
      if (latest.private_data.operation_id !== entry.operation_id || latest.status !== 'running') { entry.record = latest; return; }
      entry.record = this.store.change(latest.id, latest.revision, row => {
        row.status = status;
        row.private_data.failure = status === 'failed' ? 'acknowledged_rejection' : 'not_confirmed';
        const stage = row.stages.findLast(stage => stage.id === entry.current && stage.status === 'running');
        if (stage) Object.assign(stage, { status, message: messages[status] });
        const intent = row.private_data.intents?.[entry.current];
        if (intent?.status === 'running') intent.status = status;
      }, { guard: entry.lease.assert });
    } catch {
      // A storage failure is itself uncertain. Do not expose IO errors or overwrite a newer owner.
      // The durable running intent + now-abandoned kernel lease also yields unknown on inert reads.
      if (entry.observation) {
        entry.record = structuredClone(entry.record);
        const observation = entry.record.private_data.reconciliations?.at(-1);
        if (observation?.id === entry.operation_id) observation.status = 'unknown';
      } else entry.record = { ...entry.record, status: 'unknown', stages: entry.record.stages.map(stage =>
        stage.status === 'running' ? { ...stage, status: 'unknown', message: messages.unknown } : stage) };
    }
  }
  #dispose(entry) {
    if (!entry.disposing) entry.disposing = Promise.allSettled([...entry.closers].map(close => Promise.resolve().then(close)));
    return entry.disposing;
  }
  /** Separate append-only observation journal, never a resumed stage or a new installation authority. */
  observe(id, expected_revision, work) {
    check(!this.#closed && typeof work === 'function', 'Deployment inspection is unavailable');
    const lease = this.store.lease(id); let record;
    try {
      record = this.store.read(id);
      check(record.revision === expected_revision, 'Deployment revision changed; reload before inspection');
      check(Array.isArray(record.private_data.reconciliations ?? []) && (record.private_data.reconciliations?.length ?? 0) < 16, 'Deployment inspection history limit reached; no action sent');
    } catch (error) { lease.release(); throw error; }
    const entry = { lease, record, operation_id: randomUUID(), request_id: randomUUID(), observation: true, controller: new AbortController(), closers: new Set(), claimed: false };
    this.#active.set(id, entry);
    entry.promise = this.#observe(entry, work);
    return entry.promise;
  }
  #context(entry) {
    return { read: () => structuredClone(entry.record), signal: entry.controller.signal,
      guard: () => this.#guard(entry), checkpoint: mutate => this.#checkpoint(entry, mutate),
      onClose: close => { this.#guard(entry); check(typeof close === 'function', 'Deployment cleanup callback required'); entry.closers.add(close); return () => entry.closers.delete(close); } };
  }
  async #observe(entry, work) {
    try {
      entry.record = this.store.change(entry.record.id, entry.record.revision, row => {
        // Acquiring the original kernel lease proves its former operation is no longer active,
        // not that any original write/process succeeded or stopped. Persist only that uncertainty.
        if (row.status === 'running') {
          row.status = 'unknown'; row.private_data.failure = 'not_confirmed';
          for (const stage of row.stages) if (stage.status === 'running') Object.assign(stage, { status: 'unknown', message: messages.unknown });
          const intent = row.private_data.intents?.[row.private_data.active_stage];
          if (intent?.status === 'running') intent.status = 'unknown';
        }
        abandonRecoveryState(row.private_data.recovery);
        row.private_data.reconciliations ??= [];
        for (const observation of row.private_data.reconciliations) if (observation.status === 'running') observation.status = 'unknown';
        row.private_data.reconciliations.push({ id: entry.operation_id, request_id: entry.request_id, status: 'running', from_revision: entry.record.revision,
          original_operation_id: row.private_data.operation_id ?? null, created_at: new Date().toISOString() });
      }, { guard: () => this.#guard(entry) });
      entry.claimed = true;
      const facts = await work(this.#context(entry), { request_id: entry.request_id });
      this.#guard(entry);
      entry.record = this.store.change(entry.record.id, entry.record.revision, row => {
        const observation = row.private_data.reconciliations.at(-1);
        check(observation.id === entry.operation_id && observation.status === 'running', 'Deployment inspection identity changed');
        Object.assign(observation, { status: 'complete', completed_at: new Date().toISOString(), facts: structuredClone(facts) });
      }, { guard: () => this.#guard(entry) });
    } catch {
      if (!entry.claimed) throw new Error('Deployment inspection intent could not be persisted; no action sent');
      this.#fail(entry, 'unknown');
    } finally {
      await this.#dispose(entry); this.#active.delete(entry.record.id); entry.lease.release();
    }
    return structuredClone(entry.record);
  }
  run(id, expected_revision, { stages, finish = 'ready', publish = null, purpose = 'apply' }, work) {
    check(!this.#closed, 'Deployment service is closed');
    check(Array.isArray(stages) && stages.length > 0 && stages.length <= 32 && new Set(stages).size === stages.length
      && stages.every(value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(value)), 'Invalid internal deployment stages');
    check(typeof work === 'function', 'Deployment operation callback required');
    check(purpose === 'apply' || (purpose === 'confirm' && finish === 'confirmed' && JSON.stringify(stages) === JSON.stringify(['confirm_remote', 'confirm_binding'])),  'Invalid internal deployment operation purpose');
    const lease = this.store.lease(id);
    let record;
    try {
      record = this.store.read(id);
      check(record.revision === expected_revision && record.status === (purpose === 'confirm' ? 'ready' : 'planned'), 'Deployment revision changed or operation cannot be replayed');
      check(record.stages.length + stages.length <= 32 && stages.every(id => !record.stages.some(stage => stage.id === id)), 'Deployment stages cannot be repeated or exceed their limit');
    } catch (error) { lease.release(); throw error; }
    const entry = { lease, record, operation_id: randomUUID(), current: null, index: 0, controller: new AbortController(), closers: new Set(), failed: false, closing: false, claimed: false };
    this.#active.set(id, entry);
    entry.promise = this.#run(entry, { stages, finish, publish, purpose }, work);
    return entry.promise;
  }
  async #run(entry, definition, work) {
    const context = { ...this.#context(entry),
      stage: async (id, send, publish = null) => {
        this.#guard(entry);
        check(id === definition.stages[entry.index] && typeof send === 'function', 'Deployment stage order changed');
        entry.current = id;
        const request_id = randomUUID();
        this.#checkpoint(entry, row => {
          check(!row.stages.some(stage => stage.id === id), 'Deployment stage cannot be replayed');
          row.stages.push({ id, status: 'running', message: messages.running });
          row.private_data.intents ??= {};
          row.private_data.intents[id] = { id, request_id, operation_id: entry.operation_id, status: 'running' };
          row.private_data.active_stage = id;
        });
        try {
          const result = await send({ request_id, operation_id: entry.operation_id, signal: entry.controller.signal });
          this.#checkpoint(entry, row => {
            publish?.(row, result);
            Object.assign(row.stages.findLast(stage => stage.id === id), { status: 'complete', message: messages.complete });
            row.private_data.intents[id].status = 'complete';
            row.private_data.active_stage = null;
          });
          entry.current = null; entry.index++;
          return result;
        } catch (error) {
          this.#fail(entry, error instanceof DeploymentRejection && !entry.closing ? 'failed' : 'unknown');
          // No raw stderr, scripts, authentication values or unexpected storage diagnostics escape.
          throw new Error('Deployment stage was not completed; inspect its receipt');
        }
      },
    };
    try {
      entry.record = this.store.change(entry.record.id, entry.record.revision, row => {
        for (const observation of (Array.isArray(row.private_data.reconciliations) ? row.private_data.reconciliations : [])) if (observation.status === 'running') observation.status = 'unknown';
        row.status = 'running'; row.private_data.operation_id = entry.operation_id;
        row.private_data.operation_kind = definition.purpose;
        if (definition.purpose === 'confirm') row.private_data.confirmation = { status: 'running', operation_id: entry.operation_id, from_revision: entry.record.revision, runner_id: entry.record.runner_id };
        row.private_data.active_stage = null;
      }, { guard: () => this.#guard(entry) });
      entry.claimed = true;
      await work(context);
      this.#guard(entry);
      check(entry.index === definition.stages.length, 'Deployment required stages are incomplete');
      entry.record = this.store.change(entry.record.id, entry.record.revision, row => {
        definition.publish?.(row);
        check(row.private_data.operation_id === entry.operation_id && row.private_data.active_stage === null, 'Deployment operation identity cannot change');
        const status = typeof definition.finish === 'function' ? definition.finish(row) : definition.finish;
        check((['ready', 'planned', 'blocked'].includes(status) && definition.purpose === 'apply') || (status === 'confirmed' && definition.purpose === 'confirm'), 'Invalid deployment completion state');
        if (definition.purpose === 'confirm') row.private_data.confirmation.status = 'complete';
        row.status = status;
      }, { guard: () => this.#guard(entry) });
    } catch (error) {
      if (!entry.claimed) throw error;
      if (!entry.failed) this.#fail(entry, error instanceof DeploymentRejection ? 'failed' : 'unknown');
    } finally {
      await this.#dispose(entry);
      this.#active.delete(entry.record.id);
      entry.lease.release();
    }
    return structuredClone(entry.record);
  }
  close() {
    if (!this.#closing) {
      this.#closed = true;
      const active = [...this.#active.values()];
      for (const entry of active) {
        entry.closing = true; entry.controller.abort();
        if (entry.claimed) this.#fail(entry, 'unknown');
        void this.#dispose(entry);
      }
      this.#closing = Promise.allSettled(active.map(entry => entry.promise)).then(() => {});
    }
    return this.#closing;
  }
}
