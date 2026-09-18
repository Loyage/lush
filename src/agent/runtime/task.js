/**
 * One task's run, in the background: invoke the agent, wait when the agent
 * answered before its child tasks were done, and wake it again with their
 * results. Also the hang timeout that guards each of those invocations.
 *
 * Exported as a method group and a function: `runner.js` merges the methods
 * into `AgentRuntime`; `continuationPrompt` is what the woken agent is told.
 */
import { createLogger } from '../../log.js';
import { LushError, text } from '../../core/types.js';
import { openAgent } from '../agent_space.js';
import { execute } from '../loop.js';

const log = createLogger('lush.agent.runtime');

/** What an agent that just woke up after its children settled is told. */
export function continuationPrompt(repository, taskId) {
  const children = repository.childTasks(taskId);
  const lines = children.map((child) => {
    const outcome = child.status === 'completed'
      ? (child.result === null ? '(no result)' : child.result)
      : `${child.status}: ${child.error ?? '(no error recorded)'}`;
    return `- task #${child.id} on service ${child.sid} → ${outcome}`;
  });
  return '[Lush] 你的子 task 已经结束：\n'
    + `${lines.join('\n')}\n`
    + '请据此继续：要么取用/汇总这些结果，要么再派新的子 task；'
    + '确认目标达成后用 task_complete 结束本 task。';
}

export const taskRun = {
  /** One task's whole life: invoke, wake when children settle, finish. */
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
        const children = this.manager.activeChildTasks(taskId);
        if (children.length > 0) {
          // The agent answered before its children were done: park the task and
          // wake it again with their results.
          this.manager.taskWaiting(taskId, true);
          await this.manager.waitForChildren(taskId);
          this.manager.taskWaiting(taskId, false);
          prompt = continuationPrompt(this.repository, taskId);
          continue;
        }
        this.manager.settleTaskFromAnswer(taskId, output);
        return;
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
