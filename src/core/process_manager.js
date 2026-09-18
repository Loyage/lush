/**
 * The shared business API used by RPC, Process handles and Agent Tools.
 *
 * This class is the single entry point (`process.*` / `task.*` on the wire maps
 * to its methods), and it keeps the parts that are about *nodes and work*:
 * process creation, the process transition machine, orphan supervision, and the
 * task layer that rides on it (see `tasks.js`). The other concerns live in
 * sibling modules and are delegated to from here, so the signatures and the
 * error codes stay exactly where callers expect them: the read models
 * (`queries.js`), the variables (`variables.js`), hard removal (`removal.js`),
 * everything forwarded to the runtime (`agent_calls.js`) and the task rules
 * themselves (`tasks.js`).
 */
import { ACTIVE_PROCESS_STATUS, ACTIVE_TASK_STATUS, validateProcessTransition } from './lifecycle.js';
import { DEFAULT_ORPHAN_POLICY, OrphanSupervisor } from './orphans.js';
import { checkAgentName, DEFAULT_AGENT_NAME } from '../agent/profiles.js';
import { LushError, VIEW_SECTIONS, jsonDump, text } from './types.js';
import {
  agentInfo, agentShow, agentsKill, agentsList, call as runtimeCall, callEnd, callOsPid, describe,
  session as runtimeSession,
} from './agent_calls.js';
import { remove, subtree } from './removal.js';
import * as tasks from './tasks.js';
import { checkWorkdir, declaredProcessName, spawnVariables, updateState, updateVars, withProcessName } from './variables.js';
import { backfillTemplateSnapshots, children, history, inspect, list, load, parent, requireActive, tree, view } from './queries.js';

export class ProcessManager {
  constructor(repository, templates, orphanPolicy = DEFAULT_ORPHAN_POLICY) {
    this.repository = repository;
    this.templates = templates;
    this.runtime = null; // composition root binds the AgentRuntime
    /**
     * Agent profile catalog (`agent/catalog.js`) used to resolve which backend
     * answers for one process. The composition root binds it like `runtime`;
     * when unbound (embedded use) every process uses the runtime's provider.
     */
    this.agentCatalog = null;
    /** PID 0's orphan supervision: policy plus the read model behind it. */
    this.orphanSupervisor = new OrphanSupervisor(repository, this, orphanPolicy);
    /**
     * Task waiters, in memory: `taskWaiters` is keyed by the task being awaited
     * and `childWaiters` by the parent task that wants to know when any of its
     * children settles. A restarted daemon fails unfinished tasks instead of
     * resuming them (`Repository.recover`), so nothing here needs to persist.
     */
    this.taskWaiters = new Map();
    this.childWaiters = new Map();
  }

  ensureRoot() {
    if (!this.repository.exists(0)) {
      this.repository.create(null, this.templates.get('lush-root'), 'lush', '管理 Lush 进程与收养孤儿进程', { root: true });
    }
  }

  /**
   * PID 0 is the one exception to "snapshots are creation-time": its permissions
   * and prompt follow the currently loaded `lush-root` template, refreshed once
   * per daemon start. Only PID 0 — every other process keeps its snapshot.
   */
  refreshRootTemplate() {
    if (!this.repository.exists(0)) return { refreshed: false, changed: [], missing: false };
    const template = this.templates.find('lush-root');
    if (template === null) return { refreshed: false, changed: [], missing: true };
    const changed = this.repository.replaceSnapshot(0, template);
    // The snapshot carries `system_prompt`, but a task's prompt is read from the
    // persisted Context (`buildInvocation`), so the Context has to follow the
    // template too — otherwise editing `templates/lush-root.json` would only
    // show up in `inspect` and never reach the agent.
    const promptChanged = this.repository.replaceContextPrompt(0, template.system_prompt);
    if (promptChanged && !changed.includes('system_prompt')) {
      changed.push('system_prompt');
      this.repository.event(0, 'template_refreshed', { template: template.name, fields: ['system_prompt'] });
    }
    return { refreshed: changed.length > 0, changed, missing: false };
  }

  // ── Process read models (see queries.js) ────────────────────────────────

  load(pid) {
    return load(this, pid);
  }

  list() {
    return list(this);
  }

  tree(agents = true) {
    return tree(this, agents);
  }

  inspect(pid) {
    return inspect(this, pid);
  }

  parent(pid) {
    return parent(this, pid);
  }

  children(pid) {
    return children(this, pid);
  }

  view(pid, sections = VIEW_SECTIONS) {
    return view(this, pid, sections);
  }

  backfillTemplateSnapshots() {
    return backfillTemplateSnapshots(this);
  }

  /** The read every mutating verb starts with: the process must be active. */
  requireActive(pid) {
    return requireActive(this, pid);
  }

  /**
   * Which agent profile a new process uses: `--agent` wins over the template's
   * optional `agent` field, and both are validated here (name syntax, and that
   * the profile exists when a catalog is bound) so a typo fails at creation
   * time instead of at the first task.
   */
  resolveAgentProfile(template, requested = undefined) {
    const name = requested === undefined || requested === null ? (template.agent ?? null) : requested;
    if (name === null || name === undefined) return null;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new LushError('agent must be a non-empty string', -32602);
    }
    checkAgentName(name);
    // `default` is built in: it exists even when no override file was written.
    if (this.agentCatalog !== null && name !== DEFAULT_AGENT_NAME && !this.agentCatalog.store.exists(name)) {
      throw new LushError(`agent profile not found: ${name} (see 'lush agent list')`, -32004);
    }
    return name;
  }

  // ── Which agent answers for one process (see agent/catalog.js) ───────────

  /** The profile name a process selected at spawn time (`state.agent`), or null. */
  selectedAgent(pid) {
    return this.repository.stateAgent(pid);
  }

  /** The profile name to show for a process: its explicit choice, or `default`. */
  agentProfileName(pid, selected = undefined) {
    return (selected === undefined ? this.selectedAgent(pid) : selected) ?? DEFAULT_AGENT_NAME;
  }

  /**
   * The provider *name* of one process without building a provider, so
   * `process tree` / `inspect` stay cheap. `selected` lets a caller that already
   * decoded the process row skip the extra state read. A profile that no longer
   * resolves (file deleted by hand) must not break the read models: the recorded
   * name stays visible and the failure is reported separately by
   * `agentProfileError`.
   */
  agentProviderName(pid, selected = undefined) {
    const name = selected === undefined ? this.selectedAgent(pid) : selected;
    if (name === null || this.agentCatalog === null || this.runtime === null) {
      return this.runtime === null ? 'unbound' : this.runtime.provider.name;
    }
    try {
      return this.agentCatalog.spec(name).provider;
    } catch {
      return this.runtime.provider.name;
    }
  }

  /** Why a process's selected agent profile cannot be resolved, or null. */
  agentProfileError(pid, selected = undefined) {
    const name = selected === undefined ? this.selectedAgent(pid) : selected;
    if (name === null || this.agentCatalog === null) return null;
    try {
      this.agentCatalog.spec(name);
      return null;
    } catch (err) {
      return err?.message ?? String(err);
    }
  }

  /**
   * The provider of one process. A process that selected no agent uses the
   * daemon's fallback provider (environment over the built-in default); an
   * explicit choice is resolved from `$LUSH_HOME/agents/` *now*, so editing a
   * profile takes effect on the next task without restarting the daemon.
   */
  agentProvider(pid) {
    const name = this.selectedAgent(pid);
    if (name === null || this.agentCatalog === null) return this.runtime.provider;
    return this.agentCatalog.provider(this.agentCatalog.spec(name));
  }

  // ── Processes ───────────────────────────────────────────────────────────

  spawn(parentPid, template, name = undefined, goal = undefined, variables = undefined, agent = undefined) {
    const parent = this.requireActive(parentPid);
    const definition = this.templates.get(template);
    if (template === 'lush-root') throw new LushError('lush-root is reserved for PID 0', -32010);
    // Permissions come from the parent's creation-time snapshot, not the live file.
    const allowed = parent.template_snapshot.child_templates ?? [];
    if (!allowed.includes('*') && !allowed.includes(template)) {
      throw new LushError(`process ${parentPid} cannot create template ${template}`, -32010);
    }
    // Singleton is per parent PID and only counts active instances.
    if (definition.singleton && this.repository.activeCount(parentPid, template) > 0) {
      throw new LushError(
        `process ${parentPid} already has an active singleton instance of template ${template}`,
        -32010,
      );
    }
    const resolved = this.spawnVariables(definition, withProcessName(definition, name, variables));
    // A template that reserves `name` as a variable names its processes with
    // it: `--name` seeds it, `variables.name` names the process, and either way
    // the declaration decides the format. Only templates without it keep the
    // generic free-form process name.
    const declared = declaredProcessName(definition, resolved);
    const finalName = declared === null
      ? (name === undefined || name === null ? template : text(name, 'name', 200))
      : text(declared, 'name', 200);
    const profile = this.resolveAgentProfile(definition, agent);
    const finalGoal = goal === undefined || goal === null ? finalName : text(goal, 'goal');
    return this.repository.create(parentPid, definition, finalName, finalGoal, { variables: resolved, agent: profile });
  }

  /**
   * Orphan supervision policy in its internal camelCase shape (the daemon
   * reads `sweepSeconds` to decide whether to arm its timer).
   */
  get orphanPolicy() {
    return this.orphanSupervisor.policy;
  }

  /** The same policy in wire shape (snake_case) for status reports; no query. */
  orphanPolicyReport() {
    return this.orphanSupervisor.policyReport();
  }

  /** `process.orphans`: PID 0's orphan pool with busy/idle facts. Read-only. */
  orphans() {
    return this.orphanSupervisor.pool();
  }

  /** Run one orphan supervision pass now (also what the daemon timer calls). */
  superviseOrphans(trigger = 'manual') {
    return this.orphanSupervisor.supervise({ trigger });
  }

  /**
   * Freeze one orphan on the supervisor's behalf: → stopped, with `reason`
   * (orphan_ttl / orphan_limit) kept in the transition event. Supervised
   * processes are frozen, never deleted, and this is the only entry point that
   * may do it — the caller is always OrphanSupervisor, which has already
   * checked busy state and policy. Freezing a node cancels the task it is
   * working on: an evicted orphan must not keep an agent running.
   */
  orphanEvict(pid, reason) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new LushError('orphan eviction reason must be a non-empty string', -32602);
    }
    const busy = this.repository.activeTaskOfProcess(pid);
    if (busy !== null) tasks.cancel(this, busy.id);
    return this._transition(pid, 'stopped', { cause: reason });
  }

  _transition(pid, target, { cancel = true, adopt = null, cause = undefined } = {}) {
    const process = this.repository.get(pid);
    if (pid === 0) throw new LushError('PID 0 is managed by the daemon; use lush daemon stop');
    if (process.status === target) return process;
    validateProcessTransition(process, target);
    const terminal = target === 'stopped';
    // The policy decides what happens to active children. `adopt === false`
    // turns the whole thing off (removal is about to delete them anyway), and
    // PID 0 is never subject to it: its own terminal transition must not touch
    // anything but PID 0.
    const mode = this.orphanSupervisor.policy.adopt;
    const policyApplies = terminal && pid !== 0 && adopt !== false;
    const effects = [];
    const updated = this.repository.transition(pid, target, {
      adopt: policyApplies && (adopt === true || mode === 'adopt'),
      terminate: policyApplies && mode === 'terminate',
      cause,
      effects,
    });
    const terminated = effects.filter((effect) => effect.kind === 'terminated');
    if (terminated.length) {
      // Children were frozen in the same transaction as their parent; their
      // agents are cancelled after it. The window between the two is covered by
      // `recover()` on the next daemon start.
      for (const effect of terminated) {
        this._cancelTasksOf(effect.pid);
        // Each frozen child applies the same policy to its own children, which
        // is what walks an active chain all the way down.
        for (const child of this.repository.children(effect.pid)) {
          if (ACTIVE_PROCESS_STATUS.includes(child.status)) this._transition(child.pid, 'stopped');
        }
      }
    }
    if (cancel && terminal) this._cancelTasksOf(pid);
    // Adoptions just landed under PID 0: if a limit is configured it applies
    // immediately (the supervisor ignores reentrant calls).
    if (this.orphanSupervisor.policy.limit > 0
      && effects.some((effect) => effect.kind === 'adopted')) {
      this.orphanSupervisor.supervise({ trigger: 'adoption' });
    }
    return updated;
  }

  /** Cancel every task still active on one process (stopping a node stops its work). */
  _cancelTasksOf(pid) {
    for (const task of this.repository.activeTasks({ pid })) tasks.cancel(this, task.id);
  }

  start(pid) {
    return this._transition(pid, 'active');
  }

  /** Stop one process. Its children keep running: they become orphans of PID 0. */
  stop(pid) {
    const busy = this.repository.activeTaskOfProcess(pid);
    if (busy !== null) {
      throw new LushError(
        `process ${pid} is working on task ${busy.id}; cancel it first (lush task cancel ${busy.id})`,
        -32010,
      );
    }
    return this._transition(pid, 'stopped');
  }

  /**
   * Subtract a process from the record for good: metadata, Context, its tasks
   * (with their calls, messages and events) and its own events. Only an already
   * stopped process may go, or `purge` both steps. Without `recursive`, a
   * surviving child is an error, because its `parent_pid` would point at a row
   * that no longer exists.
   */
  delete(pid, recursive = false) {
    return remove(this, pid, recursive, false);
  }

  /** `process purge`: cancel the tasks on it (and on its subtree), then delete it. */
  purge(pid, recursive = false) {
    return remove(this, pid, recursive, true);
  }

  /** Children before parents; see `removal.js`. */
  subtree(pid) {
    return subtree(this, pid);
  }

  // ── Variables and process state (see variables.js) ─────────────────────────

  spawnVariables(template, variables) {
    return spawnVariables(template, variables);
  }

  checkWorkdir(value) {
    return checkWorkdir(value);
  }

  updateState(pid, patch) {
    return updateState(this, pid, patch);
  }

  updateVars(pid, patch) {
    return updateVars(this, pid, patch);
  }

  // ── Agents, forwarded to the bound runtime (see agent_calls.js) ────────────

  agentInfo(pid) {
    return agentInfo(this, pid);
  }

  /** Positional like the wire signature: `agents_list {task_id, pid, all}`. */
  agentsList(taskId = null, pid = null, all = false) {
    return agentsList(this, { taskId, pid, all });
  }

  agentShow(id) {
    return agentShow(this, id);
  }

  agentsKill(id) {
    return agentsKill(this, id);
  }

  callOsPid(taskId, callId, osPid) {
    return callOsPid(this, taskId, callId, osPid);
  }

  callEnd(taskId, callId, status, output = null, error = null) {
    return callEnd(this, taskId, callId, status, output, error);
  }

  // `call` is async like the original method: a rejected argument must be a
  // rejected promise, not a synchronous throw. Positional for the wire
  // signature (`call {pid, goal, detach, interactive}`).
  async call(pid, goal, detach = false, interactive = false) {
    return runtimeCall(this, pid, goal, { detach, interactive });
  }

  // Async like `call`: a rejected argument must be a rejected promise, not a
  // synchronous throw.
  async callDescribe(pid, prompt) {
    return describe(this, pid, prompt);
  }

  session(taskId) {
    return runtimeSession(this, taskId);
  }

  // ── Tasks (see tasks.js) ───────────────────────────────────────────────────

  /**
   * Create one task: `parentTaskId === null` for a user-facing root. `start`
   * is false only for an interactive handover, where the caller's terminal
   * runs the agent.
   */
  spawnTask(parentTaskId, pid, goal, start = true) {
    return tasks.spawn(this, { parentTaskId, pid, goal, start });
  }

  /** Is this task row still able to run (created / running / waiting)? */
  taskIsActive(task) {
    return ACTIVE_TASK_STATUS.includes(task.status);
  }

  /** `created → running`, or back to running after a wait. */
  taskRunning(taskId) {
    return tasks.start(this, taskId);
  }

  /** Park a task whose agent is blocked on its child tasks (and back). */
  taskWaiting(taskId, waiting = true) {
    return tasks.markWaiting(this, taskId, waiting);
  }

  taskWaitable(taskId, fromTaskId) {
    return tasks.waitForTask(this, taskId, { fromTaskId });
  }

  waitForTask(taskId, fromTaskId = null) {
    return this.taskWaitable(taskId, fromTaskId);
  }

  /** Resolve once none of `taskId`'s child tasks is active any more. */
  waitForChildren(taskId) {
    return tasks.waitForChildren(this, taskId);
  }

  activeChildTasks(taskId) {
    return this.repository.childTasks(taskId).filter((task) => this.taskIsActive(task));
  }

  listChildTasks(taskId) {
    this.repository.getTask(taskId);
    return this.repository.childTasks(taskId).map((task) => tasks.summary(task));
  }

  completeTask(taskId, result = undefined) {
    jsonDump(result ?? null);
    return tasks.complete(this, taskId, result);
  }

  settleTaskFromAnswer(taskId, output) {
    return tasks.settleFromAnswer(this, taskId, output);
  }

  failTask(taskId, error) {
    return tasks.fail(this, taskId, error);
  }

  cancelTask(taskId) {
    return tasks.cancel(this, taskId);
  }

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
  }

  updateTaskState(taskId, patch) {
    return tasks.updateState(this, taskId, patch);
  }

  /** Positional like the wire signature: `task_list {pid, status, roots, limit}`. */
  taskList(pid = null, status = null, roots = null, limit = 200) {
    return tasks.list(this, { pid, status, roots, limit });
  }

  /** `task.wait`: block until the task is terminal, then report it. */
  async taskWait(taskId) {
    await this.waitForTask(taskId);
    return tasks.inspect(this, taskId);
  }

  /** `task.spawn`: create a task without waiting for it (the tool path uses this). */
  taskSpawn(pid, goal, parentTaskId = null) {
    return this.spawnTask(parentTaskId, pid, goal);
  }

  /** Remove one finished task (and, with `recursive`, its finished subtree). */
  taskDelete(taskId, recursive = false) {
    return tasks.remove(this, taskId, recursive);
  }

  taskAgentsList(taskId = null, pid = null, all = false) {
    return agentsList(this, { taskId, pid, all });
  }

  taskAgentShow(id) {
    return agentShow(this, id);
  }

  taskAgentsKill(id) {
    return agentsKill(this, id);
  }

  taskSession(taskId) {
    return runtimeSession(this, taskId);
  }

  taskInspect(taskId) {
    return tasks.inspect(this, taskId);
  }

  taskTree(taskId) {
    return tasks.tree(this, taskId);
  }

  taskResult(taskId) {
    return tasks.result(this, taskId);
  }

  taskHistory(taskId, after = 0, limit = 100) {
    return history(this, taskId, after, limit);
  }

  taskEvents(taskId, limit = 20) {
    return this.repository.taskEvents(taskId, limit);
  }

  tasksOfProcess(pid) {
    return tasks.tasksOfProcess(this, pid);
  }

  activeTasks() {
    return tasks.activeTasks(this);
  }
}
