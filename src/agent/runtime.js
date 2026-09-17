import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '../log.js';
import { AgentResponse } from './provider.js';
import { AgentTools, TOOL_DEFINITIONS } from './tools.js';
import { LushError, jsonDump, text } from '../core/types.js';

const log = createLogger('lush.agent.runtime');

/** Finished agents kept in memory for `process agents list --all`; cleared on daemon exit. */
const AGENT_LOG_LIMIT = 32;

/** Seconds-resolution duration for the CLI's agent lines. */
function elapsedMs(record) {
  const end = record.ended_at === undefined ? Date.now() : Date.parse(record.ended_at);
  return Math.max(0, end - Date.parse(record.started_at));
}

/** `PID.N` sorts by pid, then by the order the agent was minted. */
function byAgentId(left, right) {
  return Number(left.id.split('.')[0]) - Number(right.id.split('.')[0])
    || Number(left.id.split('.')[1]) - Number(right.id.split('.')[1]);
}

function killProcess(osPid) {
  try {
    process.kill(osPid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  error.aborted = true;
  return error;
}

/**
 * Await `promise`, but give up as soon as `signal` aborts. The underlying
 * promise keeps running: aborting a waiter must never kill an independent
 * invocation (a child call, or another process's agent).
 */
function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

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

  /** Free the busy slot of a call that ended, whatever ended it. */
  _release(pid, entry) {
    if (!entry.busy) return false;
    entry.busy = false;
    if (entry.timer) clearTimeout(entry.timer);
    if (this.active.get(pid) === entry) this.active.delete(pid);
    return true;
  }

  /**
   * Mint the next agent id for `pid` (`PID.N`) and register the live worker.
   * N is per process and per daemon run: ids are runtime identities — the
   * durable identity of the same work is the call row (`agent_calls.id`).
   */
  _openAgent(pid, callId, { interactive = false } = {}) {
    const seq = (this.agentSeq.get(pid) ?? 0) + 1;
    this.agentSeq.set(pid, seq);
    const record = {
      id: `${pid}.${seq}`,
      pid,
      provider: this.provider.name,
      call_id: callId,
      status: 'running',
      started_at: new Date().toISOString(),
      os_pid: null,
      interactive,
    };
    this.agents.set(record.id, record);
    return record;
  }

  /** The OS process behind a live agent (daemon-spawned pi, or a reported terminal one). */
  _noteOsPid(record, osPid) {
    if (record && record.status === 'running') record.os_pid = osPid;
  }

  /** Move a finished worker out of the live map into the bounded in-memory log. */
  _closeAgent(record, status, error = null) {
    if (!record || !this.agents.has(record.id)) return;
    record.status = status;
    record.ended_at = new Date().toISOString();
    if (error !== null) record.error = error;
    this.agents.delete(record.id);
    this.agentLog.unshift(record);
    if (this.agentLog.length > AGENT_LOG_LIMIT) this.agentLog.length = AGENT_LOG_LIMIT;
  }

  /** Finish the durable call row and close its live worker, if it had one. */
  _finishCall(entry, status, detail = {}) {
    this.repository.finishCall(entry.callId, status, detail);
    this._closeAgent(entry.agent ?? null, status, detail.error ?? null);
  }

  /** Release the slot and record the call outcome. Returns false if already settled. */
  _settle(pid, entry, status, detail = {}) {
    if (!this._release(pid, entry)) return false;
    this._finishCall(entry, status, detail);
    return true;
  }

  /** One worker as the CLI sees it: identity plus liveness, never a logical Process. */
  _agentView(record) {
    const running = record.status === 'running';
    return {
      id: record.id,
      pid: record.pid,
      name: this.repository.get(record.pid).name,
      provider: record.provider,
      status: record.status,
      call_id: record.call_id,
      interactive: record.interactive,
      // A daemon-spawned agent is interruptible through the runtime; an
      // interactive one only once its terminal reported the OS pid.
      cancellable: running && (!record.interactive || record.os_pid !== null),
      os_pid: record.os_pid,
      started_at: record.started_at,
      ended_at: record.ended_at ?? null,
      elapsed_ms: elapsedMs(record),
      error: record.error ?? null,
    };
  }

  /**
   * Live workers (`process agents list`), plus this daemon run's finished ones
   * when `all` is set. Deliberately runtime data: a restarted daemon has no
   * agents, and the durable record of the same work is its call row.
   */
  agentsList({ pid = null, all = false } = {}) {
    const keep = (record) => pid === null || record.pid === pid;
    const live = [...this.agents.values()].filter(keep).sort(byAgentId).map((record) => this._agentView(record));
    if (!all) return live;
    const finished = this.agentLog.filter(keep).sort(byAgentId).map((record) => this._agentView(record));
    return [...live, ...finished];
  }

  /** One agent: its runtime facts, the session it writes into, and its durable call row. */
  agentShow(id) {
    const record = this.agents.get(id) ?? this.agentLog.find((candidate) => candidate.id === id);
    if (record === undefined) throw new LushError(`agent not found: ${id}`, -32004);
    const call = this.repository.callById(record.call_id);
    const sessions = typeof this.provider.sessions === 'function' ? this.provider.sessions(record.pid) : null;
    const files = sessions?.files ?? [];
    return {
      ...this._agentView(record),
      session: sessions === null ? null : {
        session_dir: sessions.session_dir,
        session_id: sessions.session_id,
        files,
        file: files.length ? files[files.length - 1] : null,
      },
      call: call === null ? null : {
        id: call.id,
        prompt: call.prompt,
        status: call.status,
        output: call.output,
        error: call.error,
        started_at: call.started_at,
        finished_at: call.finished_at,
      },
    };
  }

  /**
   * Kill one live worker: the invocation ends as interrupted, the logical
   * process is untouched (that is `process kill PID`). A daemon-spawned pi is
   * killed through its abort path; an interactive one only through the OS pid
   * its terminal reported — the daemon has no other handle on it.
   */
  agentsKill(id) {
    const record = this.agents.get(id);
    const entry = record === undefined ? undefined : this.active.get(record.pid);
    if (record === undefined || entry === undefined || entry.agent !== record) {
      throw new LushError(`agent ${id} is not running`, -32009);
    }
    entry.reason = 'cancelled';
    const killed = record.os_pid === null ? false : killProcess(record.os_pid);
    entry.controller.abort();
    return { ...this._agentView(record), killed };
  }

  /**
   * Live-worker summary for one process, used by `process tree`: how many agents
   * are running and who they are. No Context, no argv, no session walk — the
   * tree answers "who is working right now", the session answers "what is on
   * disk", and both stay cheap.
   */
  agentSummary(pid) {
    const running = [...this.agents.values()].filter((record) => record.pid === pid).sort(byAgentId);
    return {
      provider: this.provider.name,
      running: running.length,
      agents: running.map((record) => ({
        id: record.id,
        call_id: record.call_id,
        interactive: record.interactive,
        os_pid: record.os_pid,
        started_at: record.started_at,
        elapsed_ms: elapsedMs(record),
      })),
    };
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
      agent: this._openAgent(pid, callId),
      controller: new AbortController(),
      busy: true,
      reason: null,
      timer: null,
      promise: null,
      interactive: false,
    };
    entry.promise = this.chain.run([...chain, pid], () => this._execute(pid, callId, entry, prompt));
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
    const invocation = this._invocation(pid, null, prompt, context);
    // Build the argv before opening the call: a rejected invocation must not leave a running row.
    const preview = this.provider.preview(invocation, { interactive: true });
    const callId = this.repository.beginCall(pid, prompt);
    const entry = {
      pid,
      callId,
      agent: this._openAgent(pid, callId, { interactive: true }),
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
    this._noteOsPid(entry.agent, osPid);
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

  /**
   * Structured description of one invocation. In-process providers read
   * `messages`; external backends (pi) read the system prompt, the shared Lush
   * guide, the runtime data and the working directory.
   */
  _invocation(pid, callId, prompt, context, { on_spawn = null } = {}) {
    const state = this.repository.context(pid).state;
    const workdir = state?.params?.path;
    return {
      pid,
      call_id: callId,
      prompt,
      system_prompt: context.context.systemPrompt,
      guide: context.guide,
      context: context.data,
      on_spawn,
      cwd: typeof workdir === 'string' ? workdir : null,
    };
  }

  /**
   * Describe the invocation `call` would perform, without performing it: no
   * agent_calls row, no messages, no busy marking, no provider request. Only
   * external backends produce a command; in-process providers report null and
   * how many messages they would send.
   */
  describe(pid, prompt) {
    if (this.closing) throw new LushError('runtime is shutting down', -32021);
    this.manager.requireRunning(pid);
    const context = this.builder.build(this.manager.load(pid), null);
    const invocation = this._invocation(pid, null, prompt, context);
    const preview = this.provider.preview
      ? this.provider.preview(invocation)
      : { argv: null, command: null, cwd: null, env: null, messages: context.messages.length };
    return { pid, dry_run: true, agent: this.provider.name, prompt, ...preview };
  }

  /**
   * Describe this process's external agent session (pi): dir, id, files on
   * disk and the interactive command that opens it. Read-only and allowed for
   * any status; in-process providers have no session and return nulls.
   */
  session(pid) {
    if (this.closing) throw new LushError('runtime is shutting down', -32021);
    const process = this.manager.repository.get(pid);
    const context = this.builder.build(this.manager.load(pid), null);
    const invocation = this._invocation(pid, null, '', context);
    const info = this.provider.sessionInfo
      ? this.provider.sessionInfo(invocation)
      : { session_dir: null, session_id: null, files: [], file: null, argv: null, command: null, cwd: null, env: null, path_prefix: undefined };
    return {
      pid,
      name: process.name,
      status: process.status,
      agent: this.provider.name,
      busy: this.isBusy(pid),
      ...info,
    };
  }

  async _execute(pid, callId, entry, prompt) {
    const signal = entry.controller.signal;
    const tools = new AgentTools(this.manager, pid);
    try {
      if (entry.reason) throw abortError();
      for (let round = 0; round < this.maxRounds; round += 1) {
        const context = this.builder.build(this.manager.load(pid), callId);
        // The provider reports the OS process it spawns, so the agent space can
        // name (and kill) what is actually running.
        const invocation = this._invocation(pid, callId, prompt, context,
          { on_spawn: (osPid) => this._noteOsPid(entry.agent, osPid) });
        const response = await raceAbort(this.provider.call(context.messages, TOOL_DEFINITIONS, signal, invocation), signal);
        if (!(response instanceof AgentResponse) || typeof response.content !== 'string') {
          throw new LushError('provider returned invalid AgentResponse', -32020);
        }
        const ids = response.toolCalls.map((tool) => tool.id);
        if (ids.length !== new Set(ids).size || ids.length > 32) {
          throw new LushError('invalid or excessive tool calls', -32020);
        }
        this.repository.addMessage(pid, callId, response.asMessage());
        if (response.toolCalls.length === 0) {
          this._finishCall(entry, 'succeeded', { output: response.content });
          return { pid, call_id: callId, output: response.content };
        }
        // Tools of one response run in order: lifecycle and mutation tools must not race.
        for (const tool of response.toolCalls) {
          const result = await raceAbort(tools.execute(tool.name, tool.arguments), signal);
          this.repository.addMessage(pid, callId, {
            role: 'tool', tool_call_id: tool.id, content: jsonDump(result),
          });
        }
      }
      throw new LushError(`agent exceeded ${this.maxRounds} rounds`, -32020);
    } catch (err) {
      if (entry.reason === 'timeout') {
        const error = 'agent invocation timed out; inspect before retrying';
        this._finishCall(entry, 'failed', { error });
        throw new LushError(error, -32020);
      }
      if (entry.reason) {
        this._finishCall(entry, 'interrupted', { error: 'invocation cancelled' });
        throw new LushError(`invocation ${callId} interrupted`, -32021);
      }
      const error = err instanceof LushError ? err.message : 'agent runtime error; see daemon.log';
      if (!(err instanceof LushError)) log.exception(`agent invocation ${callId} failed`, err);
      this._finishCall(entry, 'failed', { error });
      throw new LushError(error, -32020);
    }
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
