/**
 * One task's run, in the background: invoke the agent, hand it whatever landed
 * in its inbox, park when it has nothing to do, and finish when it is done.
 *
 * The agent never blocks on its children: `task_wait` is gone. After every
 * invocation the **task layer** decides, in this order:
 *
 *   1. queued input (a parent / child message, or a child that settled) →
 *      synthesize the next prompt from it and invoke again;
 *   2. nothing queued but children still active → park the task in `waiting`
 *      (the hang timeout does not run while parked) until something arrives;
 *   3. nothing queued and no active children → the last answer is the result.
 *
 * That is what keeps blocking on the task instead of inside the agent, and why
 * a message can never cut an invocation short: it waits its turn in the inbox.
 *
 * Exported as a method group and the timeout guard: `runner.js` merges the
 * methods into `AgentRuntime`.
 */
import { createLogger } from '../../log.js';
import { LushError, text } from '../../core/types.js';
import { openAgent } from '../agent_space.js';
import { inputPrompt } from '../../core/tasks/messages.js';
import { execute } from '../loop.js';

const log = createLogger('lush.agent.runtime');

export const taskRun = {
  /** One task's whole life: invoke, deliver input, park, finish. */
  async _runTask(entry) {
    const { taskId } = entry;
    let prompt = this.repository.getTask(taskId).goal;
    try {
      for (let call = 0; call < this.maxCalls; call += 1) {
        const current = this.repository.getTask(taskId);
        if (!this.manager.taskIsActive(current)) return; // cancelled or settled while we were away
        this.manager.taskRunning(taskId);
        const output = await this._invoke(entry, prompt);
        const after = this.repository.getTask(taskId);
        if (!this.manager.taskIsActive(after)) return;

        // Input that arrived while the agent was working is delivered first.
        let input = this.manager.takeTaskInput(taskId);
        while (input.length === 0 && this.manager.activeChildTasks(taskId).length > 0) {
          this.manager.taskWaiting(taskId, true);
          await this.manager.waitForTaskInput(taskId);
          this.manager.taskWaiting(taskId, false);
          if (!this.manager.taskIsActive(this.repository.getTask(taskId))) return;
          input = this.manager.takeTaskInput(taskId);
        }
        if (input.length === 0) {
          this.manager.settleTaskFromAnswer(taskId, output);
          return;
        }
        prompt = inputPrompt(this.manager, input);
      }
      this.manager.failTask(taskId, `task exceeded ${this.maxCalls} agent calls`);
    } catch (err) {
      const current = this.repository.getTask(taskId);
      if (this.manager.taskIsActive(current)) {
        // A daemon shutdown aborts the invocation, so the task's failure says
        // why rather than quoting the abort.
        const error = this.closing
          ? 'daemon shut down'
          : (err instanceof LushError ? err.message : 'agent runtime error; see daemon.log');
        if (!(err instanceof LushError)) log.exception(`task ${taskId} failed`, err);
        this.manager.failTask(taskId, error);
      }
    } finally {
      this._release(entry);
    }
  },

  /**
   * One invocation of a task's agent: a call row, an agent record, a timeout
   * that frees the slot when the agent hangs, and the tool loop itself.
   */
  async _invoke(entry, prompt) {
    const { taskId, sid } = entry;
    text(prompt, 'prompt');
    entry.reason = null;
    entry.controller = new AbortController();
    entry.callId = this.repository.beginCall(sid, taskId, prompt);
    entry.agent = openAgent(this, taskId, sid, entry.callId, { provider: entry.provider });
    if (this.timeout > 0) {
      entry.timer = setTimeout(() => {
        if (entry.busy) {
          entry.reason = 'timeout';
          entry.controller.abort();
        }
      }, this.timeout * 1000);
      entry.timer.unref?.();
    }
    try {
      return await execute(this, entry, prompt);
    } finally {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    }
  },

  /**
   * Pause the hang timeout while the agent is legitimately parked on a human
   * (a blocking `notice`): it is not consuming the model, so wall clock should
   * not count against it.
   */
  pauseTimer(taskId) {
    const entry = this.active.get(taskId);
    if (!entry || entry.timer === null) return;
    clearTimeout(entry.timer);
    entry.timer = null;
  },

  resumeTimer(taskId) {
    const entry = this.active.get(taskId);
    if (!entry || !entry.busy || entry.timer !== null || this.timeout <= 0 || entry.interactive) return;
    entry.timer = setTimeout(() => {
      if (entry.busy) {
        entry.reason = 'timeout';
        entry.controller.abort();
      }
    }, this.timeout * 1000);
    entry.timer.unref?.();
  },
};
