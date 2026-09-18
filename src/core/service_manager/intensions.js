/**
 * The intension verbs as RPC / CLI / agent-tool callers see them. Each one is a
 * thin signature plus a call into `core/intensions.js`, which owns the rules —
 * this layer exists so the wire names (`intent.submit {content, sid, source}`,
 * `intent.settle {status, response, reason, intension_id, from_task_id}`) stay
 * exactly where callers expect them.
 *
 * Two addresses appear everywhere: `intension_id` (the row) and `from_task_id`
 * (the parse task holding it). A parser knows its own task and not the row, so
 * the agent tools and the CLI fill in `from_task_id` and nobody has to copy an
 * id out of a goal string.
 *
 * Exported as a method group: `index.js` merges it into `ServiceManager`.
 */
import { requireRuntime } from '../agent_calls.js';
import {
  afterTaskSettled, attachNotice, context, contextOfTask, defer, drain, handedOver, inspect, list,
  openCount, resumeFromTask, settle, submit, waitForIntension, withdraw, INTENSION_NODE_SID,
} from '../intensions.js';
import { LushError } from '../types.js';

export const intensionLayer = {
  /**
   * `intent.submit`: record the user's words and let the queue move. Three
   * shapes come back, one per question the caller asked:
   *
   * - plain → the row, right now (it may already be `parsing`);
   * - `wait` → block until the row is closed, then the row with its outcome;
   * - `interactive` → the row plus the argv to run its parse task in *this*
   *   terminal (`agent/runtime/interactive.js`); the row stays `parsing` while
   *   the caller's agent works on it.
   *
   * `wait` and `interactive` are mutually exclusive: one means "do it for me
   * and tell me", the other "I'll do it myself".
   */
  async submitIntension(content, sid = null, source = null, wait = false, interactive = false) {
    if (typeof wait !== 'boolean' || typeof interactive !== 'boolean') {
      throw new LushError('wait and interactive must be booleans', -32602);
    }
    if (wait && interactive) {
      throw new LushError('wait and interactive cannot be combined', -32602);
    }
    // Check the handover *before* anything is recorded: an agent that cannot be
    // entered must not leave a held parse task behind.
    if (interactive) requireRuntime(this).interactiveSupport(INTENSION_NODE_SID);
    const row = submit(this, { content, sid, source: source ?? 'rpc', hold: interactive });
    if (interactive) {
      if (row.parse_task_id === null) {
        throw new LushError('the parsing node is busy: an intension is already being parsed;'
          + ' wait for it to settle and submit again', -32010);
      }
      return { intension: row, interactive: requireRuntime(this).openInteractive(row.parse_task_id) };
    }
    if (!wait) return row;
    await waitForIntension(this, row.id);
    return inspect(this, row.id);
  },

  /** `intent.list`: the queue and its history, newest first. */
  intensionList(status = null, sid = undefined, open = false, limit = 200) {
    return list(this, { status, sid, open, limit });
  },

  intensionInspect(intensionId) {
    return inspect(this, intensionId);
  },

  /** `intent.context`: the architecture as the parser must see it, plus the mechanical precheck. */
  intensionContext(intensionId = null, fromTaskId = null) {
    return context(this, { intensionId, fromTaskId });
  },

  /** The parser's own view: the row it holds, by the task it holds it with. */
  intensionContextOfTask(taskId) {
    return contextOfTask(this, taskId);
  },

  /** `intent.settle`: close the row the parser holds (arranged, or refused). */
  intensionSettle(status, response = null, reason = null, intensionId = null, fromTaskId = null) {
    return settle(this, { intensionId, fromTaskId, status, response, reason });
  },

  intensionSettleFromTask(taskId, status, response = null, reason = null) {
    return settle(this, { fromTaskId: taskId, status, response, reason });
  },

  /** `intent.defer`: the user's "let that task finish first". */
  intensionDefer(blockedByTaskId, reason = null, intensionId = null, fromTaskId = null) {
    return defer(this, { intensionId, fromTaskId, blockedByTaskId, reason });
  },

  intensionDeferFromTask(taskId, blockedByTaskId, reason = null) {
    return defer(this, { fromTaskId: taskId, blockedByTaskId, reason });
  },

  intensionWithdraw(intensionId, reason = null) {
    return withdraw(this, intensionId, reason);
  },

  /** `intent.wait`: block until the row is closed. */
  async intensionWait(intensionId) {
    await waitForIntension(this, intensionId);
    return inspect(this, intensionId);
  },

  openIntensionCount() {
    return openCount(this);
  },

  /**
   * The hooks the rest of Core drives the queue with. They are manager methods
   * for the same reason `terminateNotices` and `resumeTask` are: the caller
   * (the task layer, the notice channel, the runtime) knows *when*, and this
   * layer knows *what*.
   */
  drainIntensions() {
    return drain(this);
  },

  intensionAfterTaskSettled(task, status) {
    return afterTaskSettled(this, task, status);
  },

  intensionAttachNotice(notice) {
    return attachNotice(this, notice);
  },

  intensionResumeFromTask(taskId) {
    return resumeFromTask(this, taskId);
  },

  /** A terminal reported the outcome of a parse it ran itself (interactive handover). */
  intensionHandedOver(taskId, output = null) {
    return handedOver(this, taskId, output);
  },
};
