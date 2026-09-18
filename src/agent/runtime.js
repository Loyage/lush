/**
 * The agent runtime: which task's agent may run, under which guards, and what
 * is recorded for one invocation.
 *
 * Agents belong to **tasks**, not to processes. `startTask` opens a task's run
 * in the background; within it, `_runTask` invokes the agent, and when the
 * agent answers while its child tasks are still running, waits for them and
 * wakes the agent again with their results (that is `waiting`). One task at a
 * time per process is enforced by the task layer before a task exists, so the
 * runtime only has to keep one invocation per task in flight.
 *
 * The work itself is split out: the live-worker space lives in
 * `agent_space.js`, invocation descriptions in `invocation.js`, and the tool
 * loop in `loop.js`.
 */
import { createLogger } from '../log.js';
import { LushError, text } from '../core/types.js';
import {
  agentShow, agentSummary, agentsKill, agentsList, closeAgent, noteOsPid, openAgent,
} from './agent_space.js';
import { buildInvocation, describe, session } from './invocation.js';
import { execute } from './loop.js';

const log = createLogger('lush.agent.runtime');

/** What an agent that just woke up after its children settled is told. */
export function continuationPrompt(repository, taskId) {
  const children = repository.childTasks(taskId);
  const lines = children.map((child) => {
    const outcome = child.status === 'completed'
      ? (child.result === null ? '(no result)' : child.result)
      : `${child.status}: ${child.error ?? '(no error recorded)'}`;
    return `- task #${child.id} on process ${child.pid} → ${outcome}`;
  });
  return '[Lush] 你的子 task 已经结束：\n'
    + `${lines.join('\n')}\n`
    + '请据此继续：要么取用/汇总这些结果，要么再派新的子 task；'
    + '确认目标达成后用 task_complete 结束本 task。';
}

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
    /** task id -> { taskId, pid, callId, agent, controller, busy, reason, timer, promise, interactive } */
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

  /** A process is busy while one of its tasks is being worked on. */
  isBusy(pid) {
    for (const entry of this.active.values()) {
      if (entry.busy && entry.pid === pid) return true;
    }
    return false;
  }

  isTaskBusy(taskId) {
    const entry = this.active.get(taskId);
    return Boolean(entry && entry.busy);
  }

  // ── Which agent answers for one process ───────────────────────────────────

  /** The profile name a process selected at spawn time (`state.agent`), or null. */
  selectedAgent(pid) {
    return this.manager.selectedAgent(pid);
  }

  /** The profile name to show for a process: its explicit choice, or `default`. */
  agentProfile(pid, selected = undefined) {
    return this.manager.agentProfileName(pid, selected);
  }

  /**
   * The effective provider of one process: the agent profile it selected, or the
   * daemon's fallback provider. See `ProcessManager.agentProvider`.
   */
  providerFor(pid) {
    return this.manager.agentProvider(pid);
  }

  /**
   * The provider *name* of one process, without building a provider. `selected`
   * lets a caller that already decoded the process row skip the extra read.
   */
  providerName(pid, selected = undefined) {
    return this.manager.agentProviderName(pid, selected);
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

  // ── The agent space (see agent_space.js) ───────────────────────────────────

  agentsList({ taskId = null, pid = null, all = false } = {}) {
    return agentsList(this, { taskId, pid, all });
  }

  agentShow(id) {
    return agentShow(this, id);
  }

  agentsKill(id) {
    return agentsKill(this, id);
  }

  agentSummary(pid, profile = undefined) {
    return agentSummary(this, pid, profile);
  }

  // ── Invocation descriptions (see invocation.js) ────────────────────────────

  describe(taskId, prompt = null) {
    return describe(this, taskId, prompt);
  }

  session(taskId) {
    return session(this, taskId);
  }

  // ── One task's run ─────────────────────────────────────────────────────────

  /**
   * Open a task's run in the background and return immediately: the caller
   * (a `call`, a `task_spawn` tool) gets the task id, and the work proceeds in
   * this daemon. The promise is kept on the entry so `shutdown` can await it.
   */
  startTask(taskId) {
    if (this.closing) throw new LushError('runtime is shutting down', -32021);
    const task = this.repository.getTask(taskId);
    if (task.status !== 'created') {
      throw new LushError(`task ${taskId} is ${task.status}, expected created`, -32009);
    }
    if (this.active.has(taskId)) throw new LushError(`task ${taskId} is already running`, -32009);
    const provider = this.providerFor(task.pid);
    const entry = {
      taskId,
      pid: task.pid,
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
    log.info(`task ${taskId} started on pid=${task.pid} with agent ${provider.name}`);
    return task;
  }

  /** One task's whole life: invoke, wake when children settle, finish. */
  async _runTask(entry) {
    const { taskId } = entry;
    let prompt = this.repository.getTask(taskId).goal;
    try {
      for (let call = 0; call < this.maxCalls; call += 1) {
        const current = this.repository.getTask(taskId);
        if (!this.manager.taskIsActive(current)) return; // cancelled or settled while we were away
        this.manager.taskRunning(taskId);
        const output = await this._invoke(entry, prompt);
        const after = this.repository.getTask(taskId);
        if (!this.manager.taskIsActive(after)) return;
        const children = this.manager.activeChildTasks(taskId);
        if (children.length > 0) {
          // The agent answered before its children were done: park the task and
          // wake it again with their results.
          this.manager.taskWaiting(taskId, true);
          await this.manager.waitForChildren(taskId);
          this.manager.taskWaiting(taskId, false);
          prompt = continuationPrompt(this.repository, taskId);
          continue;
        }
        this.manager.settleTaskFromAnswer(taskId, output);
        return;
      }
      this.manager.failTask(taskId, `task exceeded ${this.maxCalls} agent calls`);
    } catch (err) {
      const current = this.repository.getTask(taskId);
      if (this.manager.taskIsActive(current)) {
        // A daemon shutdown aborts the invocation, so the task's failure says
        // why rather than quoting the abort.
        const error = this.closing
          ? 'daemon shut down'
          : (err instanceof LushError ? err.message : 'agent runtime error; see daemon.log');
        if (!(err instanceof LushError)) log.exception(`task ${taskId} failed`, err);
        this.manager.failTask(taskId, error);
      }
    } finally {
      this._release(entry);
    }
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

  /**
   * One invocation of a task's agent: a call row, an agent record, a timeout
   * that frees the slot when the agent hangs, and the tool loop itself.
   */
  async _invoke(entry, prompt) {
    const { taskId, pid } = entry;
    text(prompt, 'prompt');
    entry.reason = null;
    entry.controller = new AbortController();
    entry.callId = this.repository.beginCall(pid, taskId, prompt);
    entry.agent = openAgent(this, taskId, pid, entry.callId, { provider: entry.provider });
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
      return await execute(this, entry, prompt);
    } finally {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  /**
   * Pause the hang timeout while the agent is legitimately parked on its child
   * tasks (it is not consuming the model, so the wall clock should not count).
   */
  pauseTimer(taskId) {
    const entry = this.active.get(taskId);
    if (!entry || entry.timer === null) return;
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  resumeTimer(taskId) {
    const entry = this.active.get(taskId);
    if (!entry || !entry.busy || entry.timer !== null || this.timeout <= 0 || entry.interactive) return;
    entry.timer = setTimeout(() => {
      if (entry.busy) {
        entry.reason = 'timeout';
        entry.controller.abort();
      }
    }, this.timeout * 1000);
    entry.timer.unref?.();
  }

  /**
   * Open a task whose agent runs in the caller's terminal instead of the
   * daemon (`call --interactive`): the same guards and the same call row, but
   * the caller receives the interactive argv and settles it with
   * `settleInteractive`. Only external agents (pi) have a command to hand over.
   */
  openInteractive(taskId) {
    if (this.closing) throw new LushError('runtime is shutting down', -32021);
    const task = this.repository.getTask(taskId);
    if (this.manager.taskIsActive(task) === false) {
      throw new LushError(`task ${taskId} is ${task.status}, expected created`, -32009);
    }
    if (task.status !== 'created') {
      throw new LushError(`task ${taskId} is ${task.status}, expected created`, -32009);
    }
    const provider = this.providerFor(task.pid);
    if (typeof provider.interactiveArgs !== 'function') {
      throw new LushError(`agent ${provider.name} runs in-process; there is no external agent to enter`, -32020);
    }
    const context = this.builder.build(task, null, provider.contextMode);
    const invocation = buildInvocation(this, task, null, task.goal, context);
    // Build the argv before opening the call: a rejected invocation must not leave a running row.
    const preview = provider.preview(invocation, { interactive: true });
    const callId = this.repository.beginCall(task.pid, taskId, task.goal);
    const entry = {
      taskId,
      pid: task.pid,
      callId,
      provider,
      agent: openAgent(this, taskId, task.pid, callId, { interactive: true, provider }),
      controller: new AbortController(),
      busy: true,
      reason: null,
      timer: null,
      promise: null,
      interactive: true,
    };
    this.active.set(taskId, entry);
    this.manager.taskRunning(taskId, { interactive: true });
    // No daemon-side process exists to abort, so the timeout is the only thing
    // that can free a terminal that never came back (closed window, SIGKILL).
    if (this.timeout > 0) {
      entry.timer = setTimeout(() => {
        if (!entry.busy) return;
        // A call already cancelled keeps that verdict; otherwise the terminal is presumed gone.
        if (entry.reason === null) {
          entry.reason = 'timeout';
          this._settle(entry, 'failed', { error: 'interactive invocation timed out; inspect before retrying' });
          this.manager.failTask(taskId, 'interactive invocation timed out');
        } else {
          this._settle(entry, 'interrupted', { error: `invocation ${callId} interrupted` });
        }
      }, this.timeout * 1000);
      entry.timer.unref?.();
    }
    log.info(`interactive call ${callId} handed to the caller's terminal for task ${taskId} as agent ${entry.agent.id}`);
    return {
      task_id: taskId,
      pid: task.pid,
      call_id: callId,
      agent_id: entry.agent.id,
      agent: provider.name,
      prompt: task.goal,
      interactive: true,
      ...preview,
    };
  }

  /**
   * The interactive caller reports the OS pid of the pi process it runs, right
   * after spawning it. The daemon did not spawn that process, so this is its
   * only handle on it — without it `agents kill` and `agents show` could not
   * reach an agent that lives in someone else's terminal.
   */
  noteAgentOsPid(taskId, callId, osPid) {
    const entry = this.active.get(taskId);
    if (!entry || entry.callId !== callId || !entry.busy || !entry.agent) {
      // Already settled (kill, timeout, daemon shutdown): nothing to attach to.
      return { task_id: taskId, call_id: callId, recorded: false, agent_id: null };
    }
    noteOsPid(entry.agent, osPid);
    log.info(`agent ${entry.agent.id} runs as os pid ${osPid} (reported by the caller's terminal)`);
    return { task_id: taskId, call_id: callId, recorded: true, agent_id: entry.agent.id };
  }

  /**
   * Settle a call opened by `openInteractive`: record what that terminal
   * reported, finish or fail the task, and free the slot. Returns false when
   * the call was already settled (timeout, cancel, daemon shutdown).
   */
  settleInteractive(taskId, callId, status, { output, error } = {}) {
    const entry = this.active.get(taskId);
    if (!entry || !entry.interactive || entry.callId !== callId || !entry.busy) return false;
    // A cancelled or timed-out call stays interrupted, whatever pi itself exited with.
    if (entry.reason !== null) {
      this._settle(entry, 'interrupted', { error: `invocation ${callId} interrupted` });
      this.manager.cancelTask(taskId);
      return true;
    }
    this._settle(entry, status, { output, error });
    if (status === 'succeeded') this.manager.settleTaskFromAnswer(taskId, output ?? '');
    else this.manager.failTask(taskId, error ?? 'interactive invocation failed');
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
