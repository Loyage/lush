/**
 * The agent layer: which backend answers for a process, and the forwarding of
 * the agent verbs (`agents list / show / kill`, `call`, `session`) to the bound
 * runtime.
 *
 * Profiles are resolved *now*, not at spawn time: editing a file under
 * `$LUSH_HOME/agents/` takes effect on the next task, without a daemon restart.
 * The one exception is the *name* a process selected, which is recorded at
 * creation and stays visible even if the profile is later deleted.
 *
 * Exported as a method group: `index.js` merges it into `ProcessManager`.
 */
import { LushError } from '../types.js';
import { checkAgentName, DEFAULT_AGENT_NAME } from '../../agent/profiles.js';
import {
  agentInfo, agentShow, agentsKill, agentsList, call as runtimeCall, callEnd, callOsPid, describe,
  session as runtimeSession,
} from '../agent_calls.js';

export const agents = {
  /**
   * Which agent profile a new process uses: `--agent` wins over the template's
   * optional `agent` field, and both are validated here (name syntax, and that
   * the profile exists when a catalog is bound) so a typo fails at creation
   * time instead of at the first task.
   */
  resolveAgentProfile(template, requested = undefined) {
    const name = requested === undefined || requested === null ? (template.agent ?? null) : requested;
    if (name === null || name === undefined) return null;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new LushError('agent must be a non-empty string', -32602);
    }
    checkAgentName(name);
    // `default` is built in: it exists even when no override file was written.
    if (this.agentCatalog !== null && name !== DEFAULT_AGENT_NAME && !this.agentCatalog.store.exists(name)) {
      throw new LushError(`agent profile not found: ${name} (see 'lush agent list')`, -32004);
    }
    return name;
  },

  // ── Which agent answers for one process (see agent/catalog.js) ───────────

  /** The profile name a process selected at spawn time (`state.agent`), or null. */
  selectedAgent(pid) {
    return this.repository.stateAgent(pid);
  },

  /** The profile name to show for a process: its explicit choice, or `default`. */
  agentProfileName(pid, selected = undefined) {
    return (selected === undefined ? this.selectedAgent(pid) : selected) ?? DEFAULT_AGENT_NAME;
  },

  /**
   * The provider *name* of one process without building a provider, so
   * `process tree` / `inspect` stay cheap. `selected` lets a caller that already
   * decoded the process row skip the extra state read. A profile that no longer
   * resolves (file deleted by hand) must not break the read models: the recorded
   * name stays visible and the failure is reported separately by
   * `agentProfileError`.
   */
  agentProviderName(pid, selected = undefined) {
    const name = selected === undefined ? this.selectedAgent(pid) : selected;
    if (name === null || this.agentCatalog === null || this.runtime === null) {
      return this.runtime === null ? 'unbound' : this.runtime.provider.name;
    }
    try {
      return this.agentCatalog.spec(name).provider;
    } catch {
      return this.runtime.provider.name;
    }
  },

  /** Why a process's selected agent profile cannot be resolved, or null. */
  agentProfileError(pid, selected = undefined) {
    const name = selected === undefined ? this.selectedAgent(pid) : selected;
    if (name === null || this.agentCatalog === null) return null;
    try {
      this.agentCatalog.spec(name);
      return null;
    } catch (err) {
      return err?.message ?? String(err);
    }
  },

  /**
   * The provider of one process. A process that selected no agent uses the
   * daemon's fallback provider (environment over the built-in default); an
   * explicit choice is resolved from `$LUSH_HOME/agents/` *now*, so editing a
   * profile takes effect on the next task without restarting the daemon.
   */
  agentProvider(pid) {
    const name = this.selectedAgent(pid);
    if (name === null || this.agentCatalog === null) return this.runtime.provider;
    return this.agentCatalog.provider(this.agentCatalog.spec(name));
  },

  // ── Agents, forwarded to the bound runtime (see agent_calls.js) ────────────

  agentInfo(pid) {
    return agentInfo(this, pid);
  },

  /** Positional like the wire signature: `agents_list {task_id, pid, all}`. */
  agentsList(taskId = null, pid = null, all = false) {
    return agentsList(this, { taskId, pid, all });
  },

  agentShow(id) {
    return agentShow(this, id);
  },

  agentsKill(id) {
    return agentsKill(this, id);
  },

  callOsPid(taskId, callId, osPid) {
    return callOsPid(this, taskId, callId, osPid);
  },

  callEnd(taskId, callId, status, output = null, error = null) {
    return callEnd(this, taskId, callId, status, output, error);
  },

  // `call` is async like the original method: a rejected argument must be a
  // rejected promise, not a synchronous throw. Positional for the wire
  // signature (`call {pid, goal, detach, interactive}`).
  async call(pid, goal, detach = false, interactive = false) {
    return runtimeCall(this, pid, goal, { detach, interactive });
  },

  // Async like `call`: a rejected argument must be a rejected promise, not a
  // synchronous throw.
  async callDescribe(pid, prompt) {
    return describe(this, pid, prompt);
  },

  session(taskId) {
    return runtimeSession(this, taskId);
  },
};
