import fs from 'node:fs';
import path from 'node:path';
/** The shared business API used by RPC, Process handles and Agent Tools. */
import { ACTIVE, TASK_TERMINAL, validateTransition } from './lifecycle.js';
import { DEFAULT_ORPHAN_POLICY, OrphanSupervisor } from './orphans.js';
import { Process } from './process.js';
import {
  LushError, VARIABLE_GROUPS, VIEW_SECTIONS, isPlainObject, jsonDump, text, validPid, viewSections,
} from './types.js';

/** Context state keys owned by the variable system; `update_state` must not touch them. */
const VARIABLE_STATE_KEYS = ['params', 'vars'];

/** Agents live in their own space: `PID.N`, minted per daemon run, never persisted. */
function validAgentId(id) {
  if (typeof id !== 'string' || !/^\d+\.\d+$/.test(id)) {
    throw new LushError("agent id must look like 'PID.N' (see 'lush process agents list')", -32602);
  }
  return id;
}

/**
 * Snapshot fields that older databases were written without. Adding a template
 * field is a breaking change for template files, but persisted snapshots must
 * stay readable, so they are filled in once per daemon start. Only
 * `child_templates` (creation-time permissions) and `variables`
 * (creation-time variable declaration) are read back from a snapshot; every
 * other template field is read from the currently loaded definition.
 */
const BACKFILLED_FIELDS = ['child_templates', 'variables'];

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

  load(pid) {
    this.repository.get(pid);
    return new Process(pid, this);
  }

  /**
   * Every process metadata row; `process tree` adds live-agent activity on top
   * (see `tree`). Rows are never duplicated or filtered here.
   */
  list() {
    return this.repository.list();
  }

  /**
   * `process tree`: the same rows as `list`, each with its live agents unless
   * `agents` is false. Only runtime facts are attached — no argv, no session
   * walk — so the tree stays one cheap read for N processes.
   */
  tree(agents = true) {
    if (typeof agents !== 'boolean') throw new LushError('agents must be a boolean', -32602);
    const rows = this.repository.list();
    if (!agents) return rows;
    return rows.map((row) => ({ ...row, agent: this.agentInfo(row.pid) }));
  }

  /** Live-worker summary for one process, or null while no runtime is bound. */
  agentInfo(pid) {
    return this.runtime === null ? null : this.runtime.agentSummary(pid);
  }

  /**
   * `process agents list`: live workers (optionally of one process), plus this
   * daemon run's finished ones when `all` is set. Agents are runtime data —
   * nothing here is persisted, and the durable record of the same work is the
   * call row `agent_calls.id`.
   */
  agentsList(pid = null, all = false) {
    if (pid !== null) this.repository.get(pid); // a missing process reports -32004
    if (typeof all !== 'boolean') throw new LushError('all must be a boolean', -32602);
    if (this.runtime === null) throw new LushError('AgentRuntime is not bound', -32020);
    return this.runtime.agentsList({ pid, all });
  }

  /** `process agents show`: one agent, with its session on disk and its durable call row. */
  agentShow(id) {
    validAgentId(id);
    if (this.runtime === null) throw new LushError('AgentRuntime is not bound', -32020);
    return this.runtime.agentShow(id);
  }

  /**
   * `process agents kill`: kill one worker, not the process. Unlike
   * `process kill PID`, the logical Process keeps its status and its goal.
   */
  agentsKill(id) {
    validAgentId(id);
    if (this.runtime === null) throw new LushError('AgentRuntime is not bound', -32020);
    return this.runtime.agentsKill(id);
  }

  /**
   * A terminal running `call --interactive` reports the OS pid of the pi process
   * it spawned: the daemon did not create it, so this is the only way the agent
   * space can show or kill it.
   */
  callOsPid(pid, callId, osPid) {
    validPid(pid);
    if (!Number.isInteger(callId) || callId < 1) throw new LushError('call_id must be a positive integer', -32602);
    if (!Number.isInteger(osPid) || osPid < 1) throw new LushError('os_pid must be a positive integer', -32602);
    if (this.runtime === null) throw new LushError('AgentRuntime is not bound', -32020);
    return this.runtime.noteAgentOsPid(pid, callId, osPid);
  }

  inspect(pid) {
    const process = this.repository.get(pid);
    return {
      ...process,
      context: this.repository.context(pid),
      agent: {
        status: this.runtime && this.runtime.isBusy(pid) ? 'busy' : 'idle',
        provider: this.runtime ? this.runtime.provider.name : 'unbound',
      },
      recent_calls: this.repository.calls(pid),
      recent_events: this.repository.events(pid),
    };
  }

  parent(pid) {
    const parentPid = this.repository.get(pid).parent_pid;
    return parentPid === null ? null : this.repository.get(parentPid);
  }

  children(pid) {
    return this.repository.children(pid);
  }

  /**
   * Unified "查看" read model. Sections are validated before any lookup, and a
   * missing process is reported the same way for every section.
   */
  view(pid, sections = VIEW_SECTIONS) {
    const requested = viewSections(sections);
    validPid(pid);
    this.repository.get(pid); // a missing process fails the same way for every section
    const result = { pid };
    for (const section of requested) {
      if (section === 'parent') result.parent = this.parent(pid);
      else if (section === 'children') result.children = this.children(pid);
      else if (section === 'prompt') result.call_prompt = this.repository.context(pid).system_prompt;
      else throw new LushError(`unhandled view section: ${section}`);
    }
    return result;
  }

  /**
   * Fill snapshot fields that predate this version from the currently loaded
   * template of the same name. Idempotent; templates that are gone are skipped
   * instead of failing startup, and no other snapshot key is modified.
   */
  backfillTemplateSnapshots() {
    const filled = [];
    const unknown_template = [];
    for (const process of this.repository.list()) {
      const missing = BACKFILLED_FIELDS.filter((field) => !Object.hasOwn(process.template_snapshot, field));
      if (missing.length === 0) continue;
      const template = this.templates.find(process.template);
      if (template === null) {
        unknown_template.push(process.pid);
        continue;
      }
      const fields = Object.fromEntries(missing.map((field) => [field, template[field]]));
      if (this.repository.backfillSnapshot(process.pid, fields).length) filled.push(process.pid);
    }
    return { filled, unknown_template };
  }

  requireRunning(pid) {
    const process = this.repository.get(pid);
    if (process.status !== 'running') {
      throw new LushError(`process ${pid} is ${process.status}, expected running`);
    }
    return process;
  }

  /**
   * Resolve creation-time variables against the template declaration. Only
   * declared names are accepted, required ones must be present, declared
   * defaults fill the rest, and the result is split into the two mutability
   * regions that `Repository.create` stores. `path` keeps its
   * working-directory contract: an absolute directory that must already exist.
   */
  spawnVariables(template, variables) {
    const declared = template.variables ?? {};
    const values = variables === undefined || variables === null ? {} : variables;
    if (!isPlainObject(values) || Object.getOwnPropertySymbols(values).length) {
      throw new LushError('variables must be a JSON object with string keys', -32602);
    }
    jsonDump(values);
    const specs = [];
    for (const group of VARIABLE_GROUPS) {
      for (const [name, spec] of Object.entries(declared[group] ?? {})) specs.push({ name, group, spec });
    }
    const known = new Set(specs.map((entry) => entry.name));
    for (const name of Object.keys(values)) {
      if (!known.has(name)) {
        throw new LushError(`template ${template.name} does not declare variable ${name}`, -32602);
      }
    }
    const resolved = { immutable: {}, mutable: {} };
    for (const { name, group, spec } of specs) {
      if (Object.hasOwn(values, name)) resolved[group][name] = values[name];
      else if (Object.hasOwn(spec, 'default')) resolved[group][name] = spec.default;
      else if (spec.required === true) {
        throw new LushError(`template ${template.name} requires variables.${name}`, -32602);
      }
    }
    if (Object.hasOwn(resolved.immutable, 'path')) this.checkWorkdir(resolved.immutable.path);
    return resolved;
  }

  /** The `path` variable is the agent working directory: absolute, and already a directory. */
  checkWorkdir(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new LushError('variable path must be an absolute path', -32602);
    }
    let stat;
    try {
      stat = fs.statSync(value);
    } catch {
      throw new LushError(`variable path does not exist: ${value}`, -32602);
    }
    if (!stat.isDirectory()) throw new LushError(`variable path is not a directory: ${value}`, -32602);
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
    return this._remove(pid, recursive, false);
  }

  /** `process purge`: stop/cancel the process (interrupting its agent call), then delete it. */
  purge(pid, recursive = false) {
    return this._remove(pid, recursive, true);
  }

  /**
   * The subtree rooted at `pid`, children before parents, so a row disappears
   * only after the rows that reference it. Iterative on purpose: logical trees
   * may be deeper than the call stack is tall.
   */
  subtree(pid) {
    const order = [];
    const stack = [pid];
    while (stack.length) {
      const current = stack.pop();
      order.push(current);
      for (const child of this.repository.children(current)) stack.push(child.pid);
    }
    return order.reverse();
  }

  /**
   * Shared body of `delete` and `purge`. Decisions, in order: PID 0 is never
   * removable (the daemon owns it), children need `recursive`, and unfinished
   * work is refused unless the caller asked to terminate it.
   */
  _remove(pid, recursive, terminate) {
    validPid(pid);
    if (typeof recursive !== 'boolean') throw new LushError('recursive must be a boolean', -32602);
    if (pid === 0) throw new LushError('PID 0 is managed by the daemon; it cannot be deleted', -32010);
    const root = this.repository.get(pid);
    const children = this.repository.children(pid).map((child) => child.pid);
    if (children.length && !recursive) {
      throw new LushError(
        `process ${pid} has children [${children.join(', ')}]; delete them first, or repeat with recursive deletion`,
        -32010,
      );
    }
    const doomed = this.subtree(pid).map((item) => this.repository.get(item));
    const active = doomed.filter((item) => ACTIVE.has(item.status));
    if (active.length && !terminate) {
      const detail = active.map((item) => `${item.pid} is ${item.status}`).join(', ');
      throw new LushError(`process ${detail}; stop or kill it first, or use 'lush process purge'`, -32010);
    }
    const terminated = [];
    for (const item of [...doomed].reverse()) {
      if (!ACTIVE.has(item.status)) continue;
      this._transition(item.pid, item.type === 'service' ? 'stopped' : 'cancelled', { adopt: false });
      terminated.push(item.pid);
    }
    // The parent outlives the child by construction (a subtree holds no
    // ancestor), so it is the one that keeps the record of what disappeared.
    const pids = doomed.map((item) => item.pid);
    const deleted = [...pids].sort((left, right) => left - right);
    const audit = root.parent_pid === null ? null : {
      pid: root.parent_pid,
      kind: 'child_deleted',
      data: { pid, name: root.name, template: root.template, status: root.status, deleted },
    };
    return {
      pid,
      deleted,
      status: root.status,
      terminated: terminated.sort((left, right) => left - right),
      rows: this.repository.remove(pids, audit),
    };
  }

  updateState(pid, patch) {
    this.requireRunning(pid);
    if (!isPlainObject(patch) || Object.getOwnPropertySymbols(patch).length) {
      throw new LushError('patch must be a JSON object with string keys', -32602);
    }
    for (const key of Object.keys(patch)) {
      if (VARIABLE_STATE_KEYS.includes(key)) {
        throw new LushError(
          `state.${key} holds process variables; use process.update_vars to change mutable ones`,
          -32602,
        );
      }
    }
    jsonDump(patch);
    return this.repository.updateState(pid, patch);
  }

  /**
   * Change mutable variables only. The declaration the process was created with
   * decides what may change, so immutability does not depend on the caller's
   * goodwill: an immutable or undeclared name is refused instead of written.
   */
  updateVars(pid, patch) {
    const process = this.requireRunning(pid);
    if (!isPlainObject(patch) || Object.getOwnPropertySymbols(patch).length) {
      throw new LushError('patch must be a JSON object with string keys', -32602);
    }
    const keys = Object.keys(patch);
    if (keys.length === 0) throw new LushError('patch must name at least one variable', -32602);
    jsonDump(patch);
    const declarations = process.variables.declarations;
    for (const key of keys) {
      if (Object.hasOwn(declarations.mutable, key)) continue;
      if (Object.hasOwn(declarations.immutable, key)) {
        throw new LushError(`variable ${key} is immutable in template ${process.template}`, -32602);
      }
      throw new LushError(`template ${process.template} does not declare variable ${key}`, -32602);
    }
    return this.repository.updateVars(pid, patch);
  }

  history(pid, after = 0, limit = 100) {
    validPid(pid);
    if (!Number.isInteger(after) || after < 0 || after > Number.MAX_SAFE_INTEGER
      || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new LushError('after must be nonnegative; limit must be 1..1000', -32602);
    }
    return this.repository.history(pid, after, limit);
  }

  async call(pid, prompt, dryRun = false) {
    this.requireRunning(pid);
    text(prompt, 'prompt');
    if (typeof dryRun !== 'boolean') throw new LushError('dry_run must be a boolean', -32602);
    if (this.runtime === null) throw new LushError('AgentRuntime is not bound', -32020);
    return dryRun ? this.runtime.describe(pid, prompt) : this.runtime.call(pid, prompt);
  }

  /**
   * `lush process call --interactive`: open a call that the caller's terminal
   * runs itself (pi TUI) and return what to run. The call row, the busy flag
   * and the running/busy/recursion guards are the same as `call`; the caller
   * reports the outcome with `callEnd`.
   */
  callBegin(pid, prompt) {
    this.requireRunning(pid);
    text(prompt, 'prompt');
    if (this.runtime === null) throw new LushError('AgentRuntime is not bound', -32020);
    return this.runtime.openInteractive(pid, prompt);
  }

  /**
   * Settle a call opened by `callBegin`. The terminal outlives the caller, so
   * any status may arrive here; `settled: false` means the daemon settled it
   * first (timeout, kill, stop or daemon shutdown).
   */
  callEnd(pid, callId, status, output = null, error = null) {
    validPid(pid);
    if (!Number.isInteger(callId) || callId < 1) throw new LushError('call_id must be a positive integer', -32602);
    if (status !== 'succeeded' && status !== 'failed') {
      throw new LushError("status must be 'succeeded' or 'failed'", -32602);
    }
    if (output !== null) text(output, 'output');
    if (error !== null) text(error, 'error');
    if (this.runtime === null) throw new LushError('AgentRuntime is not bound', -32020);
    const settled = this.runtime.settleInteractive(pid, callId, status, { output, error });
    const call = this.repository.calls(pid).find((row) => row.id === callId);
    return { pid, call_id: callId, settled, status: call?.status ?? null };
  }

  /** External agent session metadata for `pid` (read-only; any lifecycle status). */
  session(pid) {
    validPid(pid);
    if (this.runtime === null) throw new LushError('AgentRuntime is not bound', -32020);
    return this.runtime.session(pid);
  }
}
