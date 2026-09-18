/**
 * The agent space and the invocation *descriptions*, as the runtime exposes
 * them: `task agents …` reads the live workers, `task session` / `call
 * --dry-run` ask what command would run. All pure delegation — the state lives
 * in `agent_space.js` and `invocation.js`.
 *
 * Exported as a method group: `runner.js` merges it into `AgentRuntime`.
 */
import { agentShow, agentSummary, agentsKill, agentsList } from '../agent_space.js';
import { describe, session } from '../invocation.js';

export const space = {
  agentsList({ taskId = null, pid = null, all = false } = {}) {
    return agentsList(this, { taskId, pid, all });
  },

  agentShow(id) {
    return agentShow(this, id);
  },

  agentsKill(id) {
    return agentsKill(this, id);
  },

  agentSummary(pid, profile = undefined) {
    return agentSummary(this, pid, profile);
  },

  describe(taskId, prompt = null) {
    return describe(this, taskId, prompt);
  },

  session(taskId) {
    return session(this, taskId);
  },
};
