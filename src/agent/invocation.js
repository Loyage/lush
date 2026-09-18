/**
 * Building invocations, and answering questions about them without running one.
 *
 * An invocation is the structured description of "one agent call for one task":
 * what the provider gets, plus the working directory the process's immutable
 * `path` variable pins. In-process providers read `messages`; external backends
 * (pi) read the system prompt, the shared Lush guide, the runtime data and the
 * working directory. `describe` and `session` use the same builder as a real
 * run, so `--dry-run` and `session --open` cannot drift from what a task does.
 */
import { LushError } from '../core/types.js';
import { DEFAULT_AGENT_NAME } from './profiles.js';

/**
 * Structured description of one invocation. `task_id` is the work this agent is
 * doing, `pid` the passive node it runs on (its `path` variable decides the
 * working directory). `agent_profile` is the profile this invocation runs
 * under: the argv already carries that profile's flags, and the name makes the
 * choice traceable.
 */
export function buildInvocation(runtime, task, callId, prompt, context, { on_spawn = null } = {}) {
  const state = runtime.repository.context(task.pid).state;
  // The immutable `path` variable (declared by the template) is this process's
  // working directory; without it the agent works in $LUSH_HOME.
  const workdir = state?.params?.path;
  const profile = state?.agent;
  return {
    task_id: task.id,
    pid: task.pid,
    call_id: callId,
    prompt,
    system_prompt: context.context.systemPrompt,
    guide: context.guide,
    context: context.data,
    on_spawn,
    cwd: typeof workdir === 'string' ? workdir : null,
    agent_profile: typeof profile === 'string' && profile !== '' ? profile : DEFAULT_AGENT_NAME,
  };
}

/**
 * Describe the invocation a root task on `pid` would perform, without performing
 * it: no task row, no call row, no messages, no provider request. Only external
 * backends produce a command; in-process providers report null and how many
 * messages they would send.
 */
export function describe(runtime, pid, prompt) {
  if (runtime.closing) throw new LushError('runtime is shutting down', -32021);
  const process = runtime.manager.requireActive(pid);
  // The agent a process selected decides both the backend and the shared Lush
  // layer, so the dry run and the real task are described by the same provider.
  const provider = runtime.providerFor(pid);
  const context = runtime.builder.preview(process, prompt, provider.contextMode);
  const previewTask = { id: null, pid, goal: prompt, status: 'created' };
  const invocation = buildInvocation(runtime, previewTask, null, prompt, context);
  const preview = provider.preview
    ? provider.preview(invocation)
    : { argv: null, command: null, cwd: null, env: null, messages: context.messages.length };
  return {
    pid,
    dry_run: true,
    agent: provider.name,
    profile: runtime.agentProfile(pid),
    prompt,
    ...preview,
  };
}

/**
 * Describe one task's external agent session (pi): dir, id, files on disk and
 * the interactive command that opens it. Read-only and allowed for any status;
 * in-process providers have no session and return nulls.
 */
export function session(runtime, taskId) {
  if (runtime.closing) throw new LushError('runtime is shutting down', -32021);
  const task = runtime.repository.getTask(taskId);
  const process = runtime.manager.repository.get(task.pid);
  const provider = runtime.providerFor(task.pid);
  const context = runtime.builder.build(task, null, provider.contextMode);
  const invocation = buildInvocation(runtime, task, null, '', context);
  const info = provider.sessionInfo
    ? provider.sessionInfo(invocation)
    : { session_dir: null, session_id: null, files: [], file: null, argv: null, command: null, cwd: null, env: null, path_prefix: undefined };
  return {
    task_id: task.id,
    pid: task.pid,
    name: process.name,
    task_status: task.status,
    agent: provider.name,
    profile: process.agent_profile ?? DEFAULT_AGENT_NAME,
    busy: runtime.isTaskBusy(taskId),
    ...info,
  };
}
