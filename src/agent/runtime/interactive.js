/**
 * The interactive handover: a task whose agent runs in the *caller's* terminal
 * instead of the daemon (`call --interactive`).
 *
 * Same guards and the same call row as a normal run, but the daemon never
 * spawns the agent process — so it has no handle on it until the terminal
 * reports the OS PID (`noteAgentOsPid`), and it learns the outcome only when
 * the terminal reports back (`settleInteractive`). The hang timeout is the one
 * thing that can free a terminal that never came back.
 *
 * Exported as a methods group: `runner.js` merges it into `AgentRuntime`.
 */
import { createLogger } from '../../log.js';
import { LushError } from '../../core/types.js';
import { noteOsPid, openAgent } from '../agent_space.js';
import { buildInvocation } from '../invocation.js';

const log = createLogger('lush.agent.runtime');

export const interactive = {
  /**
   * Open a task whose agent runs in the caller's terminal instead of the
   * daemon (`call --interactive`): the same guards and the same call row, but
   * the caller receives the interactive argv and settles it with
   * `settleInteractive`. Only external agents (pi) have a command to hand over.
   */
  openInteractive(taskId) {
    if (this.closing) throw new LushError('runtime is shutting down', -32021);
    const task = this.repository.getTask(taskId);
    if (this.manager.taskIsActive(task) === false) {
      throw new LushError(`task ${taskId} is ${task.status}, expected created`, -32009);
    }
    if (task.status !== 'created') {
      throw new LushError(`task ${taskId} is ${task.status}, expected created`, -32009);
    }
    const provider = this.providerFor(task.sid);
    if (typeof provider.interactiveArgs !== 'function') {
      throw new LushError(`agent ${provider.name} runs in-service; there is no external agent to enter`, -32020);
    }
    const context = this.builder.build(task, null, provider.contextMode);
    const invocation = buildInvocation(this, task, null, task.goal, context);
    // Build the argv before opening the call: a rejected invocation must not leave a running row.
    const preview = provider.preview(invocation, { interactive: true });
    const callId = this.repository.beginCall(task.sid, taskId, task.goal);
    const entry = {
      taskId,
      sid: task.sid,
      callId,
      provider,
      agent: openAgent(this, taskId, task.sid, callId, { interactive: true, provider }),
      controller: new AbortController(),
      busy: true,
      reason: null,
      timer: null,
      promise: null,
      interactive: true,
    };
    this.active.set(taskId, entry);
    this.manager.taskRunning(taskId, { interactive: true });
    // No daemon-side service exists to abort, so the timeout is the only thing
    // that can free a terminal that never came back (closed window, SIGKILL).
    if (this.timeout > 0) {
      entry.timer = setTimeout(() => {
        if (!entry.busy) return;
        // A call already cancelled keeps that verdict; otherwise the terminal is presumed gone.
        if (entry.reason === null) {
          entry.reason = 'timeout';
          this._settle(entry, 'failed', { error: 'interactive invocation timed out; inspect before retrying' });
          this.manager.failTask(taskId, 'interactive invocation timed out');
        } else {
          this._settle(entry, 'interrupted', { error: `invocation ${callId} interrupted` });
        }
      }, this.timeout * 1000);
      entry.timer.unref?.();
    }
    log.info(`interactive call ${callId} handed to the caller's terminal for task ${taskId} as agent ${entry.agent.id}`);
    return {
      task_id: taskId,
      sid: task.sid,
      call_id: callId,
      agent_id: entry.agent.id,
      agent: provider.name,
      prompt: task.goal,
      interactive: true,
      ...preview,
    };
  },

  /**
   * The interactive caller reports the OS PID of the pi process it runs, right
   * after spawning it. The daemon did not spawn that service, so this is its
   * only handle on it — without it `agents kill` and `agents show` could not
   * reach an agent that lives in someone else's terminal.
   */
  noteAgentOsPid(taskId, callId, osPid) {
    const entry = this.active.get(taskId);
    if (!entry || entry.callId !== callId || !entry.busy || !entry.agent) {
      // Already settled (kill, timeout, daemon shutdown): nothing to attach to.
      return { task_id: taskId, call_id: callId, recorded: false, agent_id: null };
    }
    noteOsPid(entry.agent, osPid);
    log.info(`agent ${entry.agent.id} runs as OS PID ${osPid} (reported by the caller's terminal)`);
    return { task_id: taskId, call_id: callId, recorded: true, agent_id: entry.agent.id };
  },

  /**
   * Settle a call opened by `openInteractive`: record what that terminal
   * reported, finish or fail the task, and free the slot. Returns false when
   * the call was already settled (timeout, cancel, daemon shutdown).
   */
  settleInteractive(taskId, callId, status, { output, error } = {}) {
    const entry = this.active.get(taskId);
    if (!entry || !entry.interactive || entry.callId !== callId || !entry.busy) return false;
    // A cancelled or timed-out call stays interrupted, whatever pi itself exited with.
    if (entry.reason !== null) {
      this._settle(entry, 'interrupted', { error: `invocation ${callId} interrupted` });
      this.manager.cancelTask(taskId);
      return true;
    }
    this._settle(entry, status, { output, error });
    // The daemon never runs this task's loop, so queued input has no later
    // turn to be delivered in; drop it rather than let the completion guard
    // reject a call the user already finished.
    this.manager.takeTaskInput(taskId);
    if (status === 'succeeded') this.manager.settleTaskFromAnswer(taskId, output ?? '');
    else this.manager.failTask(taskId, error ?? 'interactive invocation failed');
    return true;
  },
};
