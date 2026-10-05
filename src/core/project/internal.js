import { createHash } from 'node:crypto';
import { LushError } from '../types.js';

/** Internal only: never expose the full task-local runtime profile in a Worker read model. */
export function workerRunProfile(project, task) {
  try {
    return task.retry_profile
      ? project.agentSettings.retryProfile(task.role, JSON.parse(task.retry_profile))
      : project.agentSettings.resolve(task.role);
  } catch { throw new LushError('worker run configuration unavailable'); }
}

/** Next-invocation choice, not evidence of the current invocation's actual connection. */
export function workerModelSelection(project, task, profile = null) {
  // Retired showcase rows remain readable, but have no next invocation to configure.
  if (task.role === 'showcase' || task.task_kind === 'showcase') return null;
  profile ??= workerRunProfile(project, task);
  return { agent: profile.agent, connection_id: profile.connection_id || null, model: profile.model || '',
    thinking: profile.thinking || '', explicit: Boolean(task.retry_profile) };
}

// 两个跨模块的私有助手：
/** One task owns exactly one agent for its whole life; only the credential rotates per wake. */
export function agentView(task, run = null, latestRun = null) {
  const selected = run?.agent || (latestRun ? {
    agent: latestRun.provider || null, model: latestRun.model || '', thinking: latestRun.thinking || '',
  } : null);
  return { id: `${task.role}#${task.id}`, task_id: task.id, role: task.role, wakes: task.agent_wakes,
    created_at: task.created_at, last_seen_at: task.agent_last_seen_at, active: Boolean(run), pid: run?.pid ?? null,
    backend: selected?.agent || null, model: selected?.model || '', thinking: selected?.thinking || '',
    connection_id: !run?.invocationEnded && !run?.parked && !run?.controller?.signal?.aborted
      && typeof run?.connectionBinding?.id === 'string' ? run.connectionBinding.id : null };
}
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
