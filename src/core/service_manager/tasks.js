/**
 * The work layer: the task verbs as the RPC / CLI / agent-tool surface sees
 * them. Every one of them is a guard plus a call into `core/tasks.js`, which
 * owns the rules — this layer exists so the wire signatures (`task_list {sid,
 * status, roots, limit}`, `cancelChildTask(from, id)`) stay exactly where
 * callers expect them.
 *
 * Exported as a method group: `index.js` merges it into `ServiceManager`.
 */
import { LushError, jsonDump } from '../types.js';
import { ACTIVE_TASK_STATUS } from '../lifecycle.js';
import { history } from '../queries.js';
import { agentShow, agentsKill, agentsList, session as runtimeSession } from '../agent_calls.js';
import * as tasks from '../tasks.js';

export const taskLayer = {
  /**
   * Create one task: `parentTaskId === null` for a user-facing root. `start`
   * is false only for an interactive handover, where the caller's terminal
   * runs the agent.
   */
  spawnTask(parentTaskId, sid, goal, start = true) {
    return tasks.spawn(this, { parentTaskId, sid, goal, start });
  },

  /** Is this task row still able to run (created / running / waiting)? */
  taskIsActive(task) {
    return ACTIVE_TASK_STATUS.includes(task.status);
  },

  /** `created → running`, or back to running after a wait. */
  taskRunning(taskId) {
    return tasks.start(this, taskId);
  },

  /** Park a task whose agent is blocked on its child tasks (and back). */
  taskWaiting(taskId, waiting = true) {
    return tasks.markWaiting(this, taskId, waiting);
  },

  taskWaitable(taskId, fromTaskId) {
    return tasks.waitForTask(this, taskId, { fromTaskId });
  },

  waitForTask(taskId, fromTaskId = null) {
    return this.taskWaitable(taskId, fromTaskId);
  },

  /** Resolve once none of `taskId`'s child tasks is active any more. */
  waitForChildren(taskId) {
    return tasks.waitForChildren(this, taskId);
  },

  activeChildTasks(taskId) {
    return this.repository.childTasks(taskId).filter((task) => this.taskIsActive(task));
  },

  listChildTasks(taskId) {
    this.repository.getTask(taskId);
    return this.repository.childTasks(taskId).map((task) => tasks.summary(task));
  },

  completeTask(taskId, result = undefined) {
    jsonDump(result ?? null);
    return tasks.complete(this, taskId, result);
  },

  settleTaskFromAnswer(taskId, output) {
    return tasks.settleFromAnswer(this, taskId, output);
  },

  failTask(taskId, error) {
    return tasks.fail(this, taskId, error);
  },

  cancelTask(taskId) {
    return tasks.cancel(this, taskId);
  },

  /** `task_cancel` from inside a task: only its own subtree may be cancelled. */
  cancelChildTask(fromTaskId, taskId) {
    this.repository.getTask(fromTaskId);
    this.repository.getTask(taskId);
    if (taskId === fromTaskId) throw new LushError(`task ${taskId} cannot cancel itself`, -32010);
    if (!this.repository.taskSubtree(fromTaskId).includes(taskId)) {
      throw new LushError(
        `task ${taskId} is not part of task ${fromTaskId}'s own tree; a task may only cancel downstream work`,
        -32010,
      );
    }
    return tasks.cancel(this, taskId);
  },

  updateTaskState(taskId, patch) {
    return tasks.updateState(this, taskId, patch);
  },

  /** Positional like the wire signature: `task_list {sid, status, roots, limit}`. */
  taskList(sid = null, status = null, roots = null, limit = 200) {
    return tasks.list(this, { sid, status, roots, limit });
  },

  /** `task.wait`: block until the task is terminal, then report it. */
  async taskWait(taskId) {
    await this.waitForTask(taskId);
    return tasks.inspect(this, taskId);
  },

  /** `task.spawn`: create a task without waiting for it (the tool path uses this). */
  taskSpawn(sid, goal, parentTaskId = null) {
    return this.spawnTask(parentTaskId, sid, goal);
  },

  /** Remove one finished task (and, with `recursive`, its finished subtree). */
  taskDelete(taskId, recursive = false) {
    return tasks.remove(this, taskId, recursive);
  },

  taskAgentsList(taskId = null, sid = null, all = false) {
    return agentsList(this, { taskId, sid, all });
  },

  taskAgentShow(id) {
    return agentShow(this, id);
  },

  taskAgentsKill(id) {
    return agentsKill(this, id);
  },

  taskSession(taskId) {
    return runtimeSession(this, taskId);
  },

  taskInspect(taskId) {
    return tasks.inspect(this, taskId);
  },

  taskTree(taskId) {
    return tasks.tree(this, taskId);
  },

  taskResult(taskId) {
    return tasks.result(this, taskId);
  },

  taskHistory(taskId, after = 0, limit = 100) {
    return history(this, taskId, after, limit);
  },

  taskEvents(taskId, limit = 20) {
    return this.repository.taskEvents(taskId, limit);
  },

  tasksOfService(sid) {
    return tasks.tasksOfService(this, sid);
  },

  activeTasks() {
    return tasks.activeTasks(this);
  },
};
