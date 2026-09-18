/**
 * The agent runtime: which task's agent may run, under which guards, and what
 * is recorded for one invocation.
 *
 * Agents belong to **tasks**, not to services. `startTask` opens a task's run
 * in the background; within it, `_runTask` invokes the agent, and when the
 * agent answers while its child tasks are still running, waits for them and
 * wakes the agent again with their results (that is `waiting`). One task at a
 * time per service is enforced by the task layer before a task exists, so the
 * runtime only has to keep one invocation per task in flight.
 *
 * This file holds the object itself — the live-slot bookkeeping, which provider
 * answers for a service, and shutdown. The three groups of behaviour are merged
 * in from the same-named directory:
 *
 *   runtime/space.js        the agent space and invocation descriptions (read)
 *   runtime/task.js         one task's run, its invocations and its timer
 *   runtime/interactive.js  a run handed to the caller's own terminal
 *
 * The work itself is split out: the live-worker space lives in
 * `agent_space.js`, invocation descriptions in `invocation.js`, and the tool
 * loop in `loop.js`.
 */
import { createLogger } from '../../log.js';
import { LushError } from '../../core/types.js';
import { closeAgent } from '../agent_space.js';
import { interactive } from './interactive.js';
import { space } from './space.js';
import { taskRun } from './task.js';

const log = createLogger('lush.agent.runtime');

export class AgentRuntime {
  constructor(manager, provider, builder, { timeout = 120, maxRounds = 12, maxCalls = 12 } = {}) {
    this.manager = manager;
    this.repository = manager.repository;
    this.provider = provider;
    this.builder = builder;
    this.timeout = timeout;
    this.maxRounds = maxRounds;
    /** How many times one task's agent may be invoked (initial + wake-ups). */
    this.maxCalls = maxCalls;
    /** task id -> { taskId, sid, callId, agent, controller, busy, reason, timer, promise, interactive } */
    this.active = new Map();
    /**
     * The agent space: live workers keyed by `TASK.N`. Agents are runtime data,
     * never persisted. `agentSeq` mints N per task for this daemon run,
     * `agentLog` keeps the last finished ones so `task agents list --all` can
     * answer "what just ran?" without a schema.
     */
    this.agents = new Map();
    this.agentSeq = new Map();
    this.agentLog = [];
    this.closing = false;
  }

  /** A service is busy while one of its tasks is being worked on. */
  isBusy(sid) {
    for (const entry of this.active.values()) {
      if (entry.busy && entry.sid === sid) return true;
    }
    return false;
  }

  isTaskBusy(taskId) {
    const entry = this.active.get(taskId);
    return Boolean(entry && entry.busy);
  }

  // ── Which agent answers for one service ───────────────────────────────────

  /** The profile name a service selected at construct time (`state.agent`), or null. */
  selectedAgent(sid) {
    return this.manager.selectedAgent(sid);
  }

  /** The profile name to show for a service: its explicit choice, or `default`. */
  agentProfile(sid, selected = undefined) {
    return this.manager.agentProfileName(sid, selected);
  }

  /**
   * The effective provider of one service: the agent profile it selected, or the
   * daemon's fallback provider. See `ServiceManager.agentProvider`.
   */
  providerFor(sid) {
    return this.manager.agentProvider(sid);
  }

  /**
   * The provider *name* of one service, without building a provider. `selected`
   * lets a caller that already decoded the service row skip the extra read.
   */
  providerName(sid, selected = undefined) {
    return this.manager.agentProviderName(sid, selected);
  }

  get activeCalls() {
    let count = 0;
    for (const entry of this.active.values()) if (entry.busy) count += 1;
    return count;
  }

  /** Abort one task's agent (an interrupted task has no answer to record). */
  cancelTask(taskId) {
    const entry = this.active.get(taskId);
    if (entry && entry.busy) {
      entry.reason = 'cancelled';
      entry.controller.abort();
    }
  }

  // ── One task's run ─────────────────────────────────────────────────────────

  /**
   * Open a task's run in the background and return immediately: the caller
   * (a `call`, a `task_construct` tool) gets the task id, and the work proceeds in
   * this daemon. The promise is kept on the entry so `shutdown` can await it.
   */
  startTask(taskId) {
    if (this.closing) throw new LushError('runtime is shutting down', -32021);
    const task = this.repository.getTask(taskId);
    if (task.status !== 'created') {
      throw new LushError(`task ${taskId} is ${task.status}, expected created`, -32009);
    }
    if (this.active.has(taskId)) throw new LushError(`task ${taskId} is already running`, -32009);
    const provider = this.providerFor(task.sid);
    const entry = {
      taskId,
      sid: task.sid,
      callId: null,
      provider,
      agent: null,
      controller: new AbortController(),
      busy: true,
      reason: null,
      timer: null,
      promise: null,
      interactive: false,
    };
    this.active.set(taskId, entry);
    entry.promise = this._runTask(entry);
    // An abandoned waiter (detached CLI, dropped RPC connection) must not crash the daemon.
    entry.promise.catch(() => {});
    log.info(`task ${taskId} started on sid=${task.sid} with agent ${provider.name}`);
    return task;
  }

  /** Free the busy slot of one task's run. */
  _release(entry) {
    if (!entry.busy) return false;
    entry.busy = false;
    if (entry.timer) clearTimeout(entry.timer);
    if (this.active.get(entry.taskId) === entry) this.active.delete(entry.taskId);
    return true;
  }

  /** Finish the durable call row and close its live worker, if it had one. */
  _finishCall(entry, status, detail = {}) {
    if (entry.callId !== null) this.repository.finishCall(entry.callId, status, detail);
    closeAgent(this, entry.agent ?? null, status, detail.error ?? null);
    entry.agent = null;
  }

  /** Release the slot and record the call outcome. Returns false if already settled. */
  _settle(entry, status, detail = {}) {
    if (!this._release(entry)) return false;
    this._finishCall(entry, status, detail);
    return true;
  }

  async shutdown() {
    this.closing = true;
    const entries = [...this.active.values()].filter((entry) => entry.busy);
    for (const entry of entries) {
      entry.reason = 'shutdown';
      entry.controller.abort();
    }
    await Promise.allSettled(entries.map((entry) => entry.promise));
    // Interactive calls have no promise to wait for: their terminal outlives the
    // daemon, so their rows are settled here and the CLI reports back to nobody.
    for (const entry of entries) {
      this._settle(entry, 'interrupted', { error: 'daemon shut down' });
      const task = this.repository.findTask(entry.taskId);
      if (task !== null && this.manager.taskIsActive(task)) {
        this.manager.failTask(entry.taskId, 'daemon shut down');
      }
    }
    // Flush pending continuation callbacks before the composition root closes SQLite.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Everything was aborted and awaited above; nothing may still be running.
    this.active.clear();
  }
}

// The three behaviour layers, merged onto the single prototype every caller
// already holds. No getters and no `super` calls, so a plain assign is exact.
Object.assign(AgentRuntime.prototype, space, taskRun, interactive);
