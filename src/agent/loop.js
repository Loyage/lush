/**
 * One invocation's tool loop: ask the provider, persist the assistant message,
 * run every tool call in order, and repeat until the agent answers without
 * tools or the round budget runs out.
 *
 * Only the loop lives here; opening/closing the call (busy flag, call row,
 * timeout) stays in `runtime.js`.
 */
import { createLogger } from '../log.js';
import { AgentResponse } from './provider.js';
import { AgentTools, TOOL_DEFINITIONS } from './tools.js';
import { LushError, jsonDump } from '../core/types.js';
import { buildInvocation } from './invocation.js';
import { noteOsPid } from './agent_space.js';

// Same name as the runtime's logger: one call produces one continuous log line stream.
const log = createLogger('lush.agent.runtime');

export function abortError() {
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
export function raceAbort(promise, signal) {
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

export async function execute(runtime, pid, callId, entry, prompt) {
  const signal = entry.controller.signal;
  const tools = new AgentTools(runtime.manager, pid);
  try {
    if (entry.reason) throw abortError();
    for (let round = 0; round < runtime.maxRounds; round += 1) {
      const context = runtime.builder.build(runtime.manager.load(pid), callId);
      // The provider reports the OS process it spawns, so the agent space can
      // name (and kill) what is actually running.
      const invocation = buildInvocation(runtime, pid, callId, prompt, context,
        { on_spawn: (osPid) => noteOsPid(entry.agent, osPid) });
      const response = await raceAbort(runtime.provider.call(context.messages, TOOL_DEFINITIONS, signal, invocation), signal);
      if (!(response instanceof AgentResponse) || typeof response.content !== 'string') {
        throw new LushError('provider returned invalid AgentResponse', -32020);
      }
      const ids = response.toolCalls.map((tool) => tool.id);
      if (ids.length !== new Set(ids).size || ids.length > 32) {
        throw new LushError('invalid or excessive tool calls', -32020);
      }
      runtime.repository.addMessage(pid, callId, response.asMessage());
      if (response.toolCalls.length === 0) {
        runtime._finishCall(entry, 'succeeded', { output: response.content });
        return { pid, call_id: callId, output: response.content };
      }
      // Tools of one response run in order: lifecycle and mutation tools must not race.
      for (const tool of response.toolCalls) {
        const result = await raceAbort(tools.execute(tool.name, tool.arguments), signal);
        runtime.repository.addMessage(pid, callId, {
          role: 'tool', tool_call_id: tool.id, content: jsonDump(result),
        });
      }
    }
    throw new LushError(`agent exceeded ${runtime.maxRounds} rounds`, -32020);
  } catch (err) {
    if (entry.reason === 'timeout') {
      const error = 'agent invocation timed out; inspect before retrying';
      runtime._finishCall(entry, 'failed', { error });
      throw new LushError(error, -32020);
    }
    if (entry.reason) {
      runtime._finishCall(entry, 'interrupted', { error: 'invocation cancelled' });
      throw new LushError(`invocation ${callId} interrupted`, -32021);
    }
    const error = err instanceof LushError ? err.message : 'agent runtime error; see daemon.log';
    if (!(err instanceof LushError)) log.exception(`agent invocation ${callId} failed`, err);
    runtime._finishCall(entry, 'failed', { error });
    throw new LushError(error, -32020);
  }
}
