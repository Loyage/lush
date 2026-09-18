/**
 * The process lifecycle: creation, the one transition machine every mutating
 * verb goes through, and PID 0's orphan supervision.
 *
 * The rule that shapes this layer: stopping a node does *not* stop its subtree
 * — children are adopted by PID 0 (or frozen, per policy) and the task layer is
 * told about it afterwards, because cancelling agents is a runtime side effect
 * that cannot be part of the status transaction.
 *
 * Exported as a method group: `index.js` merges it into `ProcessManager`.
 */
import { LushError, text } from '../types.js';
import { ACTIVE_PROCESS_STATUS, validateProcessTransition } from '../lifecycle.js';
import { remove, subtree } from '../removal.js';
import { declaredProcessName, withProcessName } from '../variables.js';
import * as tasks from '../tasks.js';

export const nodes = {
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
  },

  /**
   * Orphan supervision policy in its internal camelCase shape (the daemon
   * reads `sweepSeconds` to decide whether to arm its timer).
   */
  orphanPolicyReport() {
    return this.orphanSupervisor.policyReport();
  },

  /** `process.orphans`: PID 0's orphan pool with busy/idle facts. Read-only. */
  orphans() {
    return this.orphanSupervisor.pool();
  },

  /** Run one orphan supervision pass now (also what the daemon timer calls). */
  superviseOrphans(trigger = 'manual') {
    return this.orphanSupervisor.supervise({ trigger });
  },

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
  },

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
  },

  /** Cancel every task still active on one process (stopping a node stops its work). */
  _cancelTasksOf(pid) {
    for (const task of this.repository.activeTasks({ pid })) tasks.cancel(this, task.id);
  },

  start(pid) {
    return this._transition(pid, 'active');
  },

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
  },

  /**
   * Subtract a process from the record for good: metadata, Context, its tasks
   * (with their calls, messages and events) and its own events. Only an already
   * stopped process may go, or `purge` both steps. Without `recursive`, a
   * surviving child is an error, because its `parent_pid` would point at a row
   * that no longer exists.
   */
  delete(pid, recursive = false) {
    return remove(this, pid, recursive, false);
  },

  /** `process purge`: cancel the tasks on it (and on its subtree), then delete it. */
  purge(pid, recursive = false) {
    return remove(this, pid, recursive, true);
  },

  /** Children before parents; see `removal.js`. */
  subtree(pid) {
    return subtree(this, pid);
  },
};
