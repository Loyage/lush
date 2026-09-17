import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '../log.js';
import { AgentResponse } from './provider.js';
import { AgentTools, TOOL_DEFINITIONS } from './tools.js';
import { LushError, jsonDump } from '../core/types.js';

const log = createLogger('lush.agent.runtime');

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
    /** pid -> { callId, controller, busy, reason, timer, promise } */
    this.active = new Map();
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

  cancel(pid) {
    const entry = this.active.get(pid);
    if (entry && entry.busy) {
      entry.reason = 'cancelled';
      entry.controller.abort();
    }
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
    const entry = { callId, controller: new AbortController(), busy: true, reason: null, timer: null, promise: null };
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
      entry.busy = false;
      if (entry.timer) clearTimeout(entry.timer);
      if (this.active.get(pid) === entry) this.active.delete(pid);
    }
  }

  /**
   * Structured description of one invocation. In-process providers read
   * `messages`; external backends (pi) read the system prompt, the shared Lush
   * guide, the runtime data and the working directory.
   */
  _invocation(pid, callId, prompt, context) {
    const state = this.repository.context(pid).state;
    const workdir = state?.params?.path;
    return {
      pid,
      call_id: callId,
      prompt,
      system_prompt: context.context.systemPrompt,
      guide: context.guide,
      context: context.data,
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
        const invocation = this._invocation(pid, callId, prompt, context);
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
          this.repository.finishCall(callId, 'succeeded', { output: response.content });
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
        this.repository.finishCall(callId, 'failed', { error });
        throw new LushError(error, -32020);
      }
      if (entry.reason) {
        this.repository.finishCall(callId, 'interrupted', { error: 'invocation cancelled' });
        throw new LushError(`invocation ${callId} interrupted`, -32021);
      }
      const error = err instanceof LushError ? err.message : 'agent runtime error; see daemon.log';
      if (!(err instanceof LushError)) log.exception(`agent invocation ${callId} failed`, err);
      this.repository.finishCall(callId, 'failed', { error });
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
    // Flush pending continuation callbacks before the composition root closes SQLite.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Everything was aborted and awaited above; nothing may still be running.
    this.active.clear();
  }
}
