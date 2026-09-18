/**
 * The intension rows, exposed on `Repository`.
 *
 * Exported as a method group: `index.js` merges it into `Repository`. Signatures
 * are the persistence-level ones (camelCase, no wire validation) — Core decides
 * who may submit, defer or settle a row, and what a settle may claim.
 */
import {
  beginParsing, createIntension, deferIntension, detachServiceIntensions, detachTaskIntensions,
  findIntension, getIntension, listIntensions, nextQueuedIntension, openIntensionCount,
  openIntensionOfTask, openIntensions, parkAwaiting, recordIntensionResponse, requeueIntension,
  requeueParsingIntensions, resumeParsing, settleIntension, silentIntensionOfTask,
} from '../repository_intensions.js';

export const intensionMethods = {
  /** Record one piece of user input; `content` is stored verbatim. */
  createIntension({ sid, content, source }) {
    return createIntension(this, { sid, content, source });
  },

  getIntension(intensionId) {
    return getIntension(this, intensionId);
  },

  findIntension(intensionId) {
    return findIntension(this, intensionId);
  },

  /** `intent.list`. `sid: undefined` means "any target", `null` means "none named". */
  listIntensions(options = {}) {
    return listIntensions(this, options);
  },

  /** Every row still in the queue, oldest first. */
  openIntensions() {
    return openIntensions(this);
  },

  /** The next row that may be parsed (oldest, nothing left to wait for). */
  nextQueuedIntension() {
    return nextQueuedIntension(this);
  },

  openIntensionCount() {
    return openIntensionCount(this);
  },

  beginIntensionParsing(intensionId, taskId) {
    return beginParsing(this, intensionId, taskId);
  },

  resumeIntensionParsing(intensionId) {
    return resumeParsing(this, intensionId);
  },

  parkIntensionAwaiting(intensionId) {
    return parkAwaiting(this, intensionId);
  },

  settleIntension(intensionId, detail) {
    return settleIntension(this, intensionId, detail);
  },

  deferIntension(intensionId, detail) {
    return deferIntension(this, intensionId, detail);
  },

  /** A parse that never happened: back to the queue, nothing to wait for. */
  requeueIntension(intensionId, detail) {
    return requeueIntension(this, intensionId, detail);
  },

  /** The row a parse task still owes (parsing / awaiting), if any. */
  openIntensionOfTask(taskId) {
    return openIntensionOfTask(this, taskId);
  },

  /** A row this task settled without an answer — a second chance at one. */
  silentIntensionOfTask(taskId) {
    return silentIntensionOfTask(this, taskId);
  },

  /** Record an answer on a row that has none (never overwrite one). */
  recordIntensionResponse(intensionId, response) {
    return recordIntensionResponse(this, intensionId, response);
  },

  /** `Repository.recover`: parse tasks just died, so their rows go back. */
  requeueParsingIntensions(note) {
    return requeueParsingIntensions(this, note);
  },

  detachTaskIntensions(taskId) {
    return detachTaskIntensions(this, taskId);
  },

  detachServiceIntensions(sid) {
    return detachServiceIntensions(this, sid);
  },
};
