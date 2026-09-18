/**
 * Context, persistent state, events and history — the process's durable memory
 * as the class exposes it. Every method forwards to `repository_state.js`, which
 * holds the statements; the class surface stays where callers expect it.
 *
 * Exported as a method group: `index.js` merges it into `Repository`.
 */
import {
  backfillSnapshot, context, event, events, history, replaceContextPrompt, stateAgent, updateState, updateVars,
} from '../repository_state.js';

export const state = {
  /** The agent profile this process selected at spawn time (null when unset). */
  stateAgent(pid) {
    return stateAgent(this, pid);
  },

  event(pid, kind, data) {
    return event(this, pid, kind, data);
  },

  events(pid, limit = 20) {
    return events(this, pid, limit);
  },

  context(pid) {
    return context(this, pid);
  },

  /** Replace a Context system prompt (see `repository_state.replaceContextPrompt`). */
  replaceContextPrompt(pid, systemPrompt) {
    return replaceContextPrompt(this, pid, systemPrompt);
  },

  updateState(pid, patch) {
    return updateState(this, pid, patch);
  },

  updateVars(pid, patch) {
    return updateVars(this, pid, patch);
  },

  history(pid, after = 0, limit = 100) {
    return history(this, pid, after, limit);
  },

  backfillSnapshot(pid, fields) {
    return backfillSnapshot(this, pid, fields);
  },
};
