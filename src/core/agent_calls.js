/**
 * Everything `ServiceManager` forwards to the `AgentRuntime`: creating a task's
 * run, the live workers of one daemon run, and the calls that open or settle an
 * invocation.
 *
 * This module is the boundary between "the business API" and "the runtime bound
 * to it": it only validates the wire-level arguments and the
 * runtime-is-bound precondition, then delegates. Every function operates on the
 * `ServiceManager` passed in; the class in `service_manager.js` is the only
 * caller.
 */
import { LushError, text, validSid } from './types.js';

/** Agents live in their own space: `TASK.N`, minted per daemon run, never persisted. */
export function validAgentId(id) {
  if (typeof id !== 'string' || !/^\d+\.\d+$/.test(id)) {
    throw new LushError("agent id must look like 'TASK.N' (see 'lush task agents list')", -32602);
  }
  return id;
}

/** The composition root binds the runtime right after construction; nothing works before that. */
export function requireRuntime(manager) {
  if (manager.runtime === null) throw new LushError('AgentRuntime is not bound', -32020);
  return manager.runtime;
}

/** Live-worker summary for one service, or null while no runtime is bound. */
export function agentInfo(manager, sid, profile = undefined) {
  return manager.runtime === null ? null : manager.runtime.agentSummary(sid, profile);
}

/**
 * `task agents list`: live workers, optionally of one task or one service, plus
 * this daemon run's finished ones when `all` is set. Agents are runtime data —
 * nothing here is persisted, and the durable record of the same work is the
 * call row (`agent_calls.id`).
 */
export function agentsList(manager, { taskId = null, sid = null, all = false } = {}) {
  if (sid !== null) manager.repository.get(sid); // a missing service reports -32004
  if (taskId !== null) manager.repository.getTask(taskId); // a missing task reports -32004
  if (typeof all !== 'boolean') throw new LushError('all must be a boolean', -32602);
  return requireRuntime(manager).agentsList({ taskId, sid, all });
}

/** `task agents show`: one agent, with its session on disk and its durable call row. */
export function agentShow(manager, id) {
  validAgentId(id);
  return requireRuntime(manager).agentShow(id);
}

/** `task agents kill`: kill one worker, which cancels the task it was working on. */
export function agentsKill(manager, id) {
  validAgentId(id);
  return requireRuntime(manager).agentsKill(id);
}

/**
 * A terminal running `call --interactive` reports the OS PID of the pi process
 * it constructed: the daemon did not create it, so this is the only way the agent
 * space can show or kill it.
 */
export function callOsPid(manager, taskId, callId, osPid) {
  validSid(taskId);
  if (!Number.isInteger(callId) || callId < 1) throw new LushError('call_id must be a positive integer', -32602);
  if (!Number.isInteger(osPid) || osPid < 1) throw new LushError('os_pid must be a positive integer', -32602);
  return requireRuntime(manager).noteAgentOsPid(taskId, callId, osPid);
}

/**
 * `callRoot`: open a root task on `sid` and (unless `detach`) block until it —
 * and therefore its whole subtree of delegated tasks — is finished.
 * `interactive` hands the task's agent to the caller's terminal instead.
 *
 * **Internal.** What a user says is an intension now (`intent.submit`), and the
 * only root task the user side creates is the parse task the queue dispatches
 * on the parsing node (`core/intensions.js`). This entry point exists for the
 * tests and an embedding caller: it is not reachable over RPC, CLI or the
 * agent tools.
 */
export async function callRoot(manager, sid, goal, { detach = false, interactive = false } = {}) {
  validSid(sid);
  text(goal, 'goal');
  if (typeof detach !== 'boolean' || typeof interactive !== 'boolean') {
    throw new LushError('detach and interactive must be booleans', -32602);
  }
  if (detach && interactive) throw new LushError('detach and interactive cannot be combined', -32602);
  // An interactive task is not started here: the caller's terminal runs it.
  const task = manager.constructRootTask(sid, goal, !interactive);
  if (interactive) return requireRuntime(manager).openInteractive(task.id);
  if (detach) return manager.taskInspect(task.id);
  await manager.waitForTask(task.id);
  const settled = manager.repository.findTask(task.id);
  if (settled === null) {
    // `purge` removed the row while this caller was waiting: report that instead
    // of failing the command with a confusing "task not found".
    return {
      id: task.id,
      sid: task.sid,
      goal: task.goal,
      status: 'removed',
      result: null,
      error: 'task was removed while its caller was waiting',
    };
  }
  return manager.taskInspect(task.id);
}

/**
 * Internal preview: what a node's first invocation would run, without running
 * it. Used by the tests and an embedding caller; the user-facing preview of an
 * argv is the interactive handover (`intent submit --interactive`).
 */
export function describe(manager, sid, prompt) {
  validSid(sid);
  text(prompt, 'prompt');
  return requireRuntime(manager).describe(sid, prompt);
}

/**
 * Settle a call opened by `call --interactive`. The terminal outlives the
 * caller, so any status may arrive here; `settled: false` means the daemon
 * settled it first (timeout, cancel, daemon shutdown).
 */
export function callEnd(manager, taskId, callId, status, output = null, error = null) {
  validSid(taskId);
  if (!Number.isInteger(callId) || callId < 1) throw new LushError('call_id must be a positive integer', -32602);
  if (status !== 'succeeded' && status !== 'failed') {
    throw new LushError("status must be 'succeeded' or 'failed'", -32602);
  }
  if (output !== null) text(output, 'output');
  if (error !== null) text(error, 'error');
  const settled = requireRuntime(manager).settleInteractive(taskId, callId, status, { output, error });
  const task = manager.repository.findTask(taskId);
  return { task_id: taskId, call_id: callId, settled, status: task?.status ?? null };
}

/** External agent session metadata for a task's agent (read-only, any status). */
export function session(manager, taskId) {
  validSid(taskId);
  return requireRuntime(manager).session(taskId);
}
