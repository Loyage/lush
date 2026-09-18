/**
 * Context, persistent state, events and history — the service's durable memory
 * as the class exposes it. Every method forwards to `repository_state.js`, which
 * holds the statements; the class surface stays where callers expect it.
 *
 * Exported as a method group: `index.js` merges it into `Repository`.
 */
import {
  backfillSnapshot, context, event, events, history, replaceContextPrompt, stateAgent, updateState, updateVars,
} from '../repository_state.js';

export const state = {
  /** The agent profile this service selected at construct time (null when unset). */
  stateAgent(sid) {
    return stateAgent(this, sid);
  },

  event(sid, kind, data) {
    return event(this, sid, kind, data);
  },

  events(sid, limit = 20) {
    return events(this, sid, limit);
  },

  context(sid) {
    return context(this, sid);
  },

  /** Replace a Context system prompt (see `repository_state.replaceContextPrompt`). */
  replaceContextPrompt(sid, systemPrompt) {
    return replaceContextPrompt(this, sid, systemPrompt);
  },

  updateState(sid, patch) {
    return updateState(this, sid, patch);
  },

  updateVars(sid, patch) {
    return updateVars(this, sid, patch);
  },

  history(sid, after = 0, limit = 100) {
    return history(this, sid, after, limit);
  },

  backfillSnapshot(sid, fields) {
    return backfillSnapshot(this, sid, fields);
  },
};
