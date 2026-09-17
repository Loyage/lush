/**
 * Building invocations, and answering questions about them without running one.
 *
 * An invocation is the structured description of "one call": what the provider
 * gets, plus the working directory the process's immutable `path` variable
 * pins. In-process providers read `messages`; external backends (pi) read the
 * system prompt, the shared Lush guide, the runtime data and the working
 * directory. `describe` and `session` use the same builder as a real call, so
 * `--dry-run` and `session --open` cannot drift from what `call` would do.
 */
import { LushError } from '../core/types.js';

/**
 * Structured description of one invocation. In-process providers read
 * `messages`; external backends (pi) read the system prompt, the shared Lush
 * guide, the runtime data and the working directory.
 */
export function buildInvocation(runtime, pid, callId, prompt, context, { on_spawn = null } = {}) {
  const state = runtime.repository.context(pid).state;
  // The immutable `path` variable (declared by the template) is this process's
  // working directory; without it the agent works in $LUSH_HOME.
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
export function describe(runtime, pid, prompt) {
  if (runtime.closing) throw new LushError('runtime is shutting down', -32021);
  runtime.manager.requireRunning(pid);
  const context = runtime.builder.build(runtime.manager.load(pid), null);
  const invocation = buildInvocation(runtime, pid, null, prompt, context);
  const preview = runtime.provider.preview
    ? runtime.provider.preview(invocation)
    : { argv: null, command: null, cwd: null, env: null, messages: context.messages.length };
  return { pid, dry_run: true, agent: runtime.provider.name, prompt, ...preview };
}

/**
 * Describe this process's external agent session (pi): dir, id, files on
 * disk and the interactive command that opens it. Read-only and allowed for
 * any status; in-process providers have no session and return nulls.
 */
export function session(runtime, pid) {
  if (runtime.closing) throw new LushError('runtime is shutting down', -32021);
  const process = runtime.manager.repository.get(pid);
  const context = runtime.builder.build(runtime.manager.load(pid), null);
  const invocation = buildInvocation(runtime, pid, null, '', context);
  const info = runtime.provider.sessionInfo
    ? runtime.provider.sessionInfo(invocation)
    : { session_dir: null, session_id: null, files: [], file: null, argv: null, command: null, cwd: null, env: null, path_prefix: undefined };
  return {
    pid,
    name: process.name,
    status: process.status,
    agent: runtime.provider.name,
    busy: runtime.isBusy(pid),
    ...info,
  };
}
