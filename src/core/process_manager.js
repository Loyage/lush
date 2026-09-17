/**
 * The shared business API used by RPC, Process handles and Agent Tools.
 *
 * This class is the single entry point (`process.*` on the wire maps to its
 * methods), and it keeps the parts that are about *processes*: creation,
 * the transition machine and orphan supervision. Four concerns live in
 * sibling modules and are delegated to from here, so the signatures and the
 * error codes stay exactly where callers expect them: the read models
 * (`queries.js`), the variables (`variables.js`), hard removal (`removal.js`)
 * and everything forwarded to the runtime (`agent_calls.js`).
 */
import { ACTIVE, TASK_TERMINAL, validateTransition } from './lifecycle.js';
import { DEFAULT_ORPHAN_POLICY, OrphanSupervisor } from './orphans.js';
import { LushError, VIEW_SECTIONS, jsonDump, text } from './types.js';
import {
  agentInfo, agentShow, agentsKill, agentsList, call as runtimeCall, callBegin, callEnd, callOsPid,
  session as runtimeSession,
} from './agent_calls.js';
import { remove, subtree } from './removal.js';
import { checkWorkdir, spawnVariables, updateState, updateVars } from './variables.js';
import { backfillTemplateSnapshots, children, history, inspect, list, load, parent, requireRunning, tree, view } from './queries.js';

export class ProcessManager {
  constructor(repository, templates, orphanPolicy = DEFAULT_ORPHAN_POLICY) {
    this.repository = repository;
    this.templates = templates;
    this.runtime = null; // composition root binds the AgentRuntime
    /** PID 0's orphan supervision: policy plus the read model behind it. */
    this.orphanSupervisor = new OrphanSupervisor(repository, this, orphanPolicy);
  }

  ensureRoot() {
    if (!this.repository.exists(0)) {
      this.repository.create(null, this.templates.get('lush-root'), 'lush', '管理 Lush 进程与收养孤儿进程', { root: true });
    }
  }

  // ── Read models (see queries.js) ────────────────────────────────────────

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

  requireRunning(pid) {
    return requireRunning(this, pid);
  }

  spawn(parentPid, template, name = undefined, goal = undefined, variables = undefined) {
    const parent = this.requireRunning(parentPid);
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
    const resolved = this.spawnVariables(definition, variables);
    const finalName = name === undefined || name === null ? template : text(name, 'name', 200);
    const finalGoal = goal === undefined || goal === null ? finalName : text(goal, 'goal');
    return this.repository.create(parentPid, definition, finalName, finalGoal, { variables: resolved });
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
   * Freeze one orphan on the supervisor's behalf: Service → stopped, Task →
   * cancelled, with `reason` (orphan_ttl / orphan_limit) kept in the transition
   * event. Supervised processes are frozen, never deleted, and this is the only
   * entry point that may do it — the caller is always OrphanSupervisor, which
   * has already checked busy state and policy.
   */
  orphanEvict(pid, reason) {
    const process = this.repository.get(pid);
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new LushError('orphan eviction reason must be a non-empty string', -32602);
    }
    return this._transition(pid, process.type === 'service' ? 'stopped' : 'cancelled', { cause: reason });
  }

  _transition(pid, target, { cancel = true, result = undefined, adopt = null, cause = undefined } = {}) {
    const process = this.repository.get(pid);
    if (pid === 0) throw new LushError('PID 0 is managed by the daemon; use lush daemon stop');
    if (process.status === target) return process;
    validateTransition(process, target);
    const terminal = !ACTIVE.has(target) && target !== 'reclaimed';
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
      result,
      cause,
      effects,
    });
    const terminated = effects.filter((effect) => effect.kind === 'terminated');
    if (terminated.length) {
      // Children were frozen in the same transaction as their parent; their
      // running calls are cancelled after it. The window between the two is
      // covered by `recover()` on the next daemon start.
      for (const effect of terminated) {
        if (this.runtime) this.runtime.cancel(effect.pid);
        // Each frozen child applies the same policy to its own children, which
        // is what walks an active chain all the way down.
        for (const child of this.repository.children(effect.pid)) {
          if (ACTIVE.has(child.status)) {
            this._transition(child.pid, child.type === 'service' ? 'stopped' : 'cancelled');
          }
        }
      }
    }
    if (cancel && terminal && this.runtime) this.runtime.cancel(pid);
    // Adoptions just landed under PID 0: if a limit is configured it applies
    // immediately (the supervisor ignores reentrant calls).
    if (this.orphanSupervisor.policy.limit > 0
      && effects.some((effect) => effect.kind === 'adopted')) {
      this.orphanSupervisor.supervise({ trigger: 'adoption' });
    }
    return updated;
  }

  start(pid) {
    return this._transition(pid, 'running');
  }

  stop(pid) {
    if (this.repository.get(pid).type !== 'service') {
      throw new LushError('stop only applies to services; use kill to cancel a task');
    }
    return this._transition(pid, 'stopped');
  }

  kill(pid) {
    const process = this.repository.get(pid);
    if (process.type === 'task' && TASK_TERMINAL.has(process.status)) return process;
    return this._transition(pid, process.type === 'service' ? 'stopped' : 'cancelled');
  }

  fail(pid) {
    return this._transition(pid, 'failed');
  }

  complete(pid, result = undefined) {
    const process = this.requireRunning(pid);
    if (process.type !== 'task') throw new LushError('only tasks can complete');
    jsonDump(result ?? null);
    return this._transition(pid, 'completed', { cancel: false, result });
  }

  reclaim(pid) {
    if (this.repository.get(pid).type !== 'task') throw new LushError('only tasks can be reclaimed');
    return this._transition(pid, 'reclaimed');
  }

  /**
   * Subtract a process from the record for good: metadata, Context, messages,
   * calls and its own events. Only an already finished process may go — a
   * running one must be stopped or cancelled first, or `purge` both steps.
   * Without `recursive`, a surviving child is an error, because its
   * `parent_pid` would point at a row that no longer exists.
   */
  delete(pid, recursive = false) {
    return remove(this, pid, recursive, false);
  }

  /** `process purge`: stop/cancel the process (interrupting its agent call), then delete it. */
  purge(pid, recursive = false) {
    return remove(this, pid, recursive, true);
  }

  /** Children before parents; see `removal.js`. */
  subtree(pid) {
    return subtree(this, pid);
  }

  // ── Variables (see variables.js) ───────────────────────────────────────────

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

  history(pid, after = 0, limit = 100) {
    return history(this, pid, after, limit);
  }

  // ── Agents and calls, forwarded to the bound runtime (see agent_calls.js) ──

  agentInfo(pid) {
    return agentInfo(this, pid);
  }

  agentsList(pid = null, all = false) {
    return agentsList(this, pid, all);
  }

  agentShow(id) {
    return agentShow(this, id);
  }

  agentsKill(id) {
    return agentsKill(this, id);
  }

  callOsPid(pid, callId, osPid) {
    return callOsPid(this, pid, callId, osPid);
  }

  // `call` stays async like the original method: a rejected argument must be a
  // rejected promise, not a synchronous throw.
  async call(pid, prompt, dryRun = false) {
    return runtimeCall(this, pid, prompt, dryRun);
  }

  callBegin(pid, prompt) {
    return callBegin(this, pid, prompt);
  }

  callEnd(pid, callId, status, output = null, error = null) {
    return callEnd(this, pid, callId, status, output, error);
  }

  session(pid) {
    return runtimeSession(this, pid);
  }
}
