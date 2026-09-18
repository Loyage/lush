/**
 * Agent calls and messages — the conversation record. Every method forwards to
 * `repository_calls.js`, which holds the statements.
 *
 * Exported as a method group: `index.js` merges it into `Repository`.
 */
import { addMessage, beginCall, callById, calls, callsOfTask, conversation, finishCall } from '../repository_calls.js';

export const callMethods = {
  beginCall(pid, taskId, prompt) {
    return beginCall(this, pid, taskId, prompt);
  },

  addMessage(pid, taskId, callId, body) {
    return addMessage(this, pid, taskId, callId, body);
  },

  finishCall(callId, status, detail = {}) {
    return finishCall(this, callId, status, detail);
  },

  calls(pid, limit = 20) {
    return calls(this, pid, limit);
  },

  callsOfTask(taskId, limit = 20) {
    return callsOfTask(this, taskId, limit);
  },

  callById(callId) {
    return callById(this, callId);
  },

  conversation(taskId, currentCall) {
    return conversation(this, taskId, currentCall);
  },
};
