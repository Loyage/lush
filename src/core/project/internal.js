import { createHash } from 'node:crypto';
import { LushError } from '../types.js';
import { AGENT_BACKENDS } from '../../agent/settings.js';

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
  return { agent: profile.agent, config_mode: profile.config_mode === 'pi' ? 'pi' : 'lush',
    connection_id: profile.connection_id || null, model: profile.model || '',
    thinking: profile.thinking || '', explicit: Boolean(task.retry_profile) };
}

/** Secret-free projection of a task-local run profile for lifecycle events. */
export function profileEvent(profile) {
  return { agent: profile.agent, config_mode: profile.config_mode === 'pi' ? 'pi' : 'lush',
    model: profile.model || null, thinking: profile.thinking || null,
    default_prompt_overridden: Boolean(profile.default_prompt), append_prompt: Boolean(profile.append_prompt),
    extensions: profile.extensions.length, skills: profile.skills.length, soft_budget: profile.soft_budget || null,
    ...(profile.connection_id ? { connection_id: profile.connection_id } : {}) };
}

/**
 * A child Worker freezes the parent's effective run profile at spawn, in priority order:
 * the profile of the parent's current invocation, then its task-local override, then the effective
 * role/project default. This keeps a chosen mode/source/model from drifting when defaults change.
 * A test/offline backend has no configurable profile, so it keeps following the live default.
 */
export function inheritedRunProfile(project, parent, run = null) {
  const running = run?.agent;
  if (running && AGENT_BACKENDS.includes(running.agent)) return project.agentSettings.retryProfile(parent.role, running);
  if (parent.retry_profile !== null && parent.retry_profile !== undefined) {
    try { return project.agentSettings.retryProfile(parent.role, JSON.parse(parent.retry_profile)); }
    catch { throw new LushError('worker run configuration unavailable'); }
  }
  if (running) return null; // mock/offline invocation profile is not configurable; follow the live default
  const fallback = project.agentSettings.resolve(parent.role);
  if (!AGENT_BACKENDS.includes(fallback.agent) || !AGENT_BACKENDS.includes(project.config.provider)) return null;
  return fallback;
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
