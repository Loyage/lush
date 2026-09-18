/**
 * The agent layer: which backend answers for a service, and the forwarding of
 * the agent verbs (`agents list / show / kill`, `session`, and the internal
 * `callRoot`) to the bound runtime.
 *
 * Profiles are resolved *now*, not at construct time: editing a file under
 * `$LUSH_HOME/agents/` takes effect on the next task, without a daemon restart.
 * The one exception is the *name* a service selected, which is recorded at
 * creation and stays visible even if the profile is later deleted.
 *
 * Exported as a method group: `index.js` merges it into `ServiceManager`.
 */
import { LushError } from '../types.js';
import { checkAgentName, DEFAULT_AGENT_NAME } from '../../agent/profiles.js';
import {
  agentInfo, agentShow, agentsKill, agentsList, callEnd, callOsPid, callRoot as runtimeCall, describe,
  session as runtimeSession,
} from '../agent_calls.js';

export const agents = {
  /**
   * Which agent profile a new service uses: `--agent` wins over the template's
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

  // ── Which agent answers for one service (see agent/catalog.js) ───────────

  /** The profile name a service selected at construct time (`state.agent`), or null. */
  selectedAgent(sid) {
    return this.repository.stateAgent(sid);
  },

  /** The profile name to show for a service: its explicit choice, or `default`. */
  agentProfileName(sid, selected = undefined) {
    return (selected === undefined ? this.selectedAgent(sid) : selected) ?? DEFAULT_AGENT_NAME;
  },

  /**
   * The provider *name* of one service without building a provider, so
   * `service tree` / `inspect` stay cheap. `selected` lets a caller that already
   * decoded the service row skip the extra state read. A profile that no longer
   * resolves (file deleted by hand) must not break the read models: the recorded
   * name stays visible and the failure is reported separately by
   * `agentProfileError`.
   */
  agentProviderName(sid, selected = undefined) {
    const name = selected === undefined ? this.selectedAgent(sid) : selected;
    if (name === null || this.agentCatalog === null || this.runtime === null) {
      return this.runtime === null ? 'unbound' : this.runtime.provider.name;
    }
    try {
      return this.agentCatalog.spec(name).provider;
    } catch {
      return this.runtime.provider.name;
    }
  },

  /** Why a service's selected agent profile cannot be resolved, or null. */
  agentProfileError(sid, selected = undefined) {
    const name = selected === undefined ? this.selectedAgent(sid) : selected;
    if (name === null || this.agentCatalog === null) return null;
    try {
      this.agentCatalog.spec(name);
      return null;
    } catch (err) {
      return err?.message ?? String(err);
    }
  },

  /**
   * The provider of one service. A service that selected no agent uses the
   * daemon's fallback provider (environment over the built-in default); an
   * explicit choice is resolved from `$LUSH_HOME/agents/` *now*, so editing a
   * profile takes effect on the next task without restarting the daemon.
   */
  agentProvider(sid) {
    const name = this.selectedAgent(sid);
    if (name === null || this.agentCatalog === null) return this.runtime.provider;
    return this.agentCatalog.provider(this.agentCatalog.spec(name));
  },

  // ── Agents, forwarded to the bound runtime (see agent_calls.js) ────────────

  agentInfo(sid) {
    return agentInfo(this, sid);
  },

  /** Positional like the wire signature: `agents_list {task_id, sid, all}`. */
  agentsList(taskId = null, sid = null, all = false) {
    return agentsList(this, { taskId, sid, all });
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

  /**
   * **Internal** root-task entry (see `core/agent_calls.js`): async like the
   * original method, so a rejected argument is a rejected promise rather than a
   * synchronous throw.
   */
  async callRoot(sid, goal, detach = false, interactive = false) {
    return runtimeCall(this, sid, goal, { detach, interactive });
  },

  /**
   * **Internal** preview of a node's first invocation (`call.describe` is gone
   * from the wire): async so a rejected argument is a rejected promise rather
   * than a synchronous throw.
   */
  async callDescribe(sid, prompt) {
    return describe(this, sid, prompt);
  },

  session(taskId) {
    return runtimeSession(this, taskId);
  },
};
