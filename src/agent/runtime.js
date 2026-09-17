/**
 * The agent runtime: who may be invoked, under which guards, and what is
 * recorded for one invocation.
 *
 * One call at a time per process (`busy`), a recursion guard that travels with
 * the async call chain, and a timeout that frees the slot when a caller
 * disappears. The work itself is split out: the live-worker space lives in
 * `agent_space.js`, invocation descriptions in `invocation.js`, and the tool
 * loop in `loop.js`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '../log.js';
import { LushError, text } from '../core/types.js';
import {
  agentShow, agentSummary, agentsKill, agentsList, closeAgent, noteOsPid, openAgent,
} from './agent_space.js';
import { buildInvocation, describe, session } from './invocation.js';
import { execute } from './loop.js';

const log = createLogger('lush.agent.runtime');

export class AgentRuntime {
  constructor(manager, provider, builder, { timeout = 120, maxRounds = 12 } = {}) {
    this.manager = manager;
    this.repository = manager.repository;
    this.provider = provider;
    this.builder = builder;
    this.timeout = timeout;
    this.maxRounds = maxRounds;
    /** pid -> { pid, callId, agent, controller, busy, reason, timer, promise, interactive } */
    this.active = new Map();
    /**
     * The agent space: live workers keyed by `PID.N`. Agents are not logical
     * processes — no pid of their own, no persistence. `agentSeq` mints N per
     * process for this daemon run, `agentLog` keeps the last finished ones so
     * `agents list --all` can answer "what just ran?" without a schema.
     */
    this.agents = new Map();
    this.agentSeq = new Map();
    this.agentLog = [];
    this.closing = false;
    this.chain = new AsyncLocalStorage();
  }

  isBusy(pid) {
    const entry = this.active.get(pid);
    return Boolean(entry && entry.busy);
  }

  get activeCalls() {
    let count = 0;
    for (const entry of this.active.values()) if (entry.busy) count += 1;
    return count;
  }

  /**
   * Interrupt a running invocation. A plain call owns a pi subprocess and is
   * killed through its AbortController; an interactive call lives in a terminal
   * the daemon cannot signal, so it is only marked: it settles as interrupted
   * when that terminal reports back, or when the call timeout fires.
   */
  cancel(pid) {
    const entry = this.active.get(pid);
    if (entry && entry.busy) {
      entry.reason = 'cancelled';
      entry.controller.abort();
    }
  }

  // ── The agent space (see agent_space.js) ───────────────────────────────────

  agentsList({ pid = null, all = false } = {}) {
    return agentsList(this, { pid, all });
  }

  agentShow(id) {
    return agentShow(this, id);
  }

  agentsKill(id) {
    return agentsKill(this, id);
  }

  agentSummary(pid) {
    return agentSummary(this, pid);
  }

  // ── Invocation descriptions (see invocation.js) ────────────────────────────

  describe(pid, prompt) {
    return describe(this, pid, prompt);
  }

  session(pid) {
    return session(this, pid);
  }

  // ── One call ───────────────────────────────────────────────────────────────

  /** Free the busy slot of a call that ended, whatever ended it. */
  _release(pid, entry) {
    if (!entry.busy) return false;
    entry.busy = false;
    if (entry.timer) clearTimeout(entry.timer);
    if (this.active.get(pid) === entry) this.active.delete(pid);
    return true;
  }

  /** Finish the durable call row and close its live worker, if it had one. */
  _finishCall(entry, status, detail = {}) {
    this.repository.finishCall(entry.callId, status, detail);
    closeAgent(this, entry.agent ?? null, status, detail.error ?? null);
  }

  /** Release the slot and record the call outcome. Returns false if already settled. */
  _settle(pid, entry, status, detail = {}) {
    if (!this._release(pid, entry)) return false;
    this._finishCall(entry, status, detail);
    return true;
  }

  async call(pid, prompt) {
    if (this.closing) throw new LushError('runtime is shutting down', -32021);
    this.manager.requireRunning(pid);
    const chain = this.chain.getStore() ?? [];
    if (chain.includes(pid)) {
      throw new LushError(`recursive process.call chain: ${[...chain, pid].join(' -> ')}`);
    }
    if (this.isBusy(pid)) throw new LushError(`process ${pid} agent is busy`);

    const callId = this.repository.beginCall(pid, prompt);
    const entry = {
      pid,
      callId,
      agent: openAgent(this, pid, callId),
      controller: new AbortController(),
      busy: true,
      reason: null,
      timer: null,
      promise: null,
      interactive: false,
    };
    entry.promise = this.chain.run([...chain, pid], () => execute(this, pid, callId, entry, prompt));
    this.active.set(pid, entry);
    // An abandoned waiter (detached CLI, dropped RPC connection) must not crash the daemon.
    entry.promise.catch(() => {});
    if (this.timeout > 0) {
      entry.timer = setTimeout(() => {
        if (entry.busy) {
          entry.reason = 'timeout';
          entry.controller.abort();
        }
      }, this.timeout * 1000);
      entry.timer.unref?.();
    }

    try {
      return await entry.promise;
    } finally {
      this._release(pid, entry);
    }
  }

  /**
   * Open a call that this terminal runs itself instead of the daemon: the same
   * guards, the same call row and the same busy flag as `call`, but the caller
   * receives the interactive argv and settles the call with `settleInteractive`
   * once its terminal is done. Only external agents (pi) have a command to hand
   * over; in-process providers have no terminal to enter.
   */
  openInteractive(pid, prompt) {
    if (this.closing) throw new LushError('runtime is shutting down', -32021);
    if (typeof this.provider.interactiveArgs !== 'function') {
      throw new LushError(`agent ${this.provider.name} runs in-process; there is no external agent to enter`, -32020);
    }
    this.manager.requireRunning(pid);
    text(prompt, 'prompt');
    const chain = this.chain.getStore() ?? [];
    if (chain.includes(pid)) {
      throw new LushError(`recursive process.call chain: ${[...chain, pid].join(' -> ')}`);
    }
    if (this.isBusy(pid)) throw new LushError(`process ${pid} agent is busy`);

    const context = this.builder.build(this.manager.load(pid), null);
    const invocation = buildInvocation(this, pid, null, prompt, context);
    // Build the argv before opening the call: a rejected invocation must not leave a running row.
    const preview = this.provider.preview(invocation, { interactive: true });
    const callId = this.repository.beginCall(pid, prompt);
    const entry = {
      pid,
      callId,
      agent: openAgent(this, pid, callId, { interactive: true }),
      controller: new AbortController(),
      busy: true,
      reason: null,
      timer: null,
      promise: null,
      interactive: true,
    };
    this.active.set(pid, entry);
    // No daemon-side process exists to abort, so the timeout is the only thing
    // that can free a terminal that never came back (closed window, SIGKILL).
    if (this.timeout > 0) {
      entry.timer = setTimeout(() => {
        if (!entry.busy) return;
        // A call already cancelled keeps that verdict; otherwise the terminal is presumed gone.
        if (entry.reason === null) {
          entry.reason = 'timeout';
          this._settle(pid, entry, 'failed', { error: 'interactive invocation timed out; inspect before retrying' });
        } else {
          this._settle(pid, entry, 'interrupted', { error: `invocation ${callId} interrupted` });
        }
      }, this.timeout * 1000);
      entry.timer.unref?.();
    }
    log.info(`interactive call ${callId} handed to the caller's terminal for pid=${pid} as agent ${entry.agent.id}`);
    return { pid, call_id: callId, agent_id: entry.agent.id, agent: this.provider.name, prompt, interactive: true, ...preview };
  }

  /**
   * The interactive caller reports the OS pid of the pi process it runs, right
   * after spawning it. The daemon did not spawn that process, so this is its
   * only handle on it — without it `agents kill` and `agents show` could not
   * reach an agent that lives in someone else's terminal.
   */
  noteAgentOsPid(pid, callId, osPid) {
    const entry = this.active.get(pid);
    if (!entry || entry.callId !== callId || !entry.busy || !entry.agent) {
      // Already settled (kill, timeout, daemon shutdown): nothing to attach to.
      return { pid, call_id: callId, recorded: false, agent_id: null };
    }
    noteOsPid(entry.agent, osPid);
    log.info(`agent ${entry.agent.id} runs as os pid ${osPid} (reported by the caller's terminal)`);
    return { pid, call_id: callId, recorded: true, agent_id: entry.agent.id };
  }

  /**
   * Settle a call opened by `openInteractive`: record what that terminal
   * reported and free the process. Returns false when the call was already
   * settled (timeout, cancel, daemon shutdown) — the daemon is the authority on
   * the call row, the terminal only on the process it still runs.
   */
  settleInteractive(pid, callId, status, { output, error } = {}) {
    const entry = this.active.get(pid);
    if (!entry || !entry.interactive || entry.callId !== callId || !entry.busy) return false;
    // A cancelled or timed-out call stays interrupted, whatever pi itself exited with.
    if (entry.reason !== null) {
      return this._settle(pid, entry, 'interrupted', { error: `invocation ${callId} interrupted` });
    }
    return this._settle(pid, entry, status, { output, error });
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
      this._settle(entry.pid, entry, 'interrupted', { error: 'daemon shut down' });
    }
    // Flush pending continuation callbacks before the composition root closes SQLite.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Everything was aborted and awaited above; nothing may still be running.
    this.active.clear();
  }
}
