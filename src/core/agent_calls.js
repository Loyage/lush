/**
 * Everything `ProcessManager` forwards to the `AgentRuntime`: the running
 * workers of one process, and the calls (plain, dry-run and interactive) that
 * create them.
 *
 * This module is the boundary between "the business API" and "the runtime
 * bound to it": it only validates the wire-level arguments and the
 * runtime-is-bound precondition, then delegates. Every function operates on
 * the `ProcessManager` passed in; the class in `process_manager.js` is the
 * only caller.
 */
import { LushError, text, validPid } from './types.js';

/** Agents live in their own space: `PID.N`, minted per daemon run, never persisted. */
export function validAgentId(id) {
  if (typeof id !== 'string' || !/^\d+\.\d+$/.test(id)) {
    throw new LushError("agent id must look like 'PID.N' (see 'lush process agents list')", -32602);
  }
  return id;
}

/** The composition root binds the runtime right after construction; nothing works before that. */
export function requireRuntime(manager) {
  if (manager.runtime === null) throw new LushError('AgentRuntime is not bound', -32020);
  return manager.runtime;
}

/** Live-worker summary for one process, or null while no runtime is bound. */
export function agentInfo(manager, pid) {
  return manager.runtime === null ? null : manager.runtime.agentSummary(pid);
}

/**
 * `process agents list`: live workers (optionally of one process), plus this
 * daemon run's finished ones when `all` is set. Agents are runtime data —
 * nothing here is persisted, and the durable record of the same work is the
 * call row `agent_calls.id`.
 */
export function agentsList(manager, pid = null, all = false) {
  if (pid !== null) manager.repository.get(pid); // a missing process reports -32004
  if (typeof all !== 'boolean') throw new LushError('all must be a boolean', -32602);
  return requireRuntime(manager).agentsList({ pid, all });
}

/** `process agents show`: one agent, with its session on disk and its durable call row. */
export function agentShow(manager, id) {
  validAgentId(id);
  return requireRuntime(manager).agentShow(id);
}

/**
 * `process agents kill`: kill one worker, not the process. Unlike
 * `process kill PID`, the logical Process keeps its status and its goal.
 */
export function agentsKill(manager, id) {
  validAgentId(id);
  return requireRuntime(manager).agentsKill(id);
}

/**
 * A terminal running `call --interactive` reports the OS pid of the pi process
 * it spawned: the daemon did not create it, so this is the only way the agent
 * space can show or kill it.
 */
export function callOsPid(manager, pid, callId, osPid) {
  validPid(pid);
  if (!Number.isInteger(callId) || callId < 1) throw new LushError('call_id must be a positive integer', -32602);
  if (!Number.isInteger(osPid) || osPid < 1) throw new LushError('os_pid must be a positive integer', -32602);
  return requireRuntime(manager).noteAgentOsPid(pid, callId, osPid);
}

export function call(manager, pid, prompt, dryRun = false) {
  manager.requireRunning(pid);
  text(prompt, 'prompt');
  if (typeof dryRun !== 'boolean') throw new LushError('dry_run must be a boolean', -32602);
  const runtime = requireRuntime(manager);
  return dryRun ? runtime.describe(pid, prompt) : runtime.call(pid, prompt);
}

/**
 * `lush process call --interactive`: open a call that the caller's terminal
 * runs itself (pi TUI) and return what to run. The call row, the busy flag
 * and the running/busy/recursion guards are the same as `call`; the caller
 * reports the outcome with `callEnd`.
 */
export function callBegin(manager, pid, prompt) {
  manager.requireRunning(pid);
  text(prompt, 'prompt');
  return requireRuntime(manager).openInteractive(pid, prompt);
}

/**
 * Settle a call opened by `callBegin`. The terminal outlives the caller, so
 * any status may arrive here; `settled: false` means the daemon settled it
 * first (timeout, kill, stop or daemon shutdown).
 */
export function callEnd(manager, pid, callId, status, output = null, error = null) {
  validPid(pid);
  if (!Number.isInteger(callId) || callId < 1) throw new LushError('call_id must be a positive integer', -32602);
  if (status !== 'succeeded' && status !== 'failed') {
    throw new LushError("status must be 'succeeded' or 'failed'", -32602);
  }
  if (output !== null) text(output, 'output');
  if (error !== null) text(error, 'error');
  const settled = requireRuntime(manager).settleInteractive(pid, callId, status, { output, error });
  const call = manager.repository.calls(pid).find((row) => row.id === callId);
  return { pid, call_id: callId, settled, status: call?.status ?? null };
}

/** External agent session metadata for `pid` (read-only; any lifecycle status). */
export function session(manager, pid) {
  validPid(pid);
  return requireRuntime(manager).session(pid);
}
