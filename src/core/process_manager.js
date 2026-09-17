import fs from 'node:fs';
import path from 'node:path';
/** The shared business API used by RPC, Process handles and Agent Tools. */
import { ACTIVE, TASK_TERMINAL, validateTransition } from './lifecycle.js';
import { Process } from './process.js';
import { LushError, VIEW_SECTIONS, isPlainObject, jsonDump, text, validPid, viewSections } from './types.js';

/**
 * MVP stand-in for per-template argument declarations: creating these templates
 * requires the listed keys in `args` (see docs/process-model.md). Any `args.path`
 * is validated and later used as the external agent working directory.
 */
const REQUIRED_SPAWN_ARGS = { project: ['path'] };

/**
 * Snapshot fields that older databases were written without. Adding a template
 * field is a breaking change for template files, but persisted snapshots must
 * stay readable, so they are filled in once per daemon start. Only
 * `child_templates` is read back from a snapshot (creation-time permissions);
 * every other template field is read from the currently loaded definition.
 */
const BACKFILLED_FIELDS = ['child_templates'];

export class ProcessManager {
  constructor(repository, templates) {
    this.repository = repository;
    this.templates = templates;
    this.runtime = null; // composition root binds the AgentRuntime
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

  list() {
    return this.repository.list();
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
   * Validate explicit creation arguments: a JSON object with string keys, plus
   * the template's required keys, plus `path` (absolute existing directory).
   * Returns null when no arguments were given.
   */
  spawnArgs(template, args) {
    const required = REQUIRED_SPAWN_ARGS[template] ?? [];
    if (args === undefined || args === null) {
      if (required.length) {
        throw new LushError(`template ${template} requires spawn args: ${required.map((key) => `args.${key}`).join(', ')}`, -32602);
      }
      return null;
    }
    if (!isPlainObject(args) || Object.getOwnPropertySymbols(args).length) {
      throw new LushError('args must be a JSON object with string keys', -32602);
    }
    jsonDump(args);
    for (const key of required) {
      if (typeof args[key] !== 'string' || args[key].trim() === '') {
        throw new LushError(`template ${template} requires a non-empty args.${key}`, -32602);
      }
    }
    if (Object.hasOwn(args, 'path')) {
      if (typeof args.path !== 'string' || !path.isAbsolute(args.path)) {
        throw new LushError('args.path must be an absolute path', -32602);
      }
      let stat;
      try {
        stat = fs.statSync(args.path);
      } catch {
        throw new LushError(`args.path does not exist: ${args.path}`, -32602);
      }
      if (!stat.isDirectory()) throw new LushError(`args.path is not a directory: ${args.path}`, -32602);
    }
    return args;
  }

  spawn(parentPid, template, name = undefined, goal = undefined, args = undefined) {
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
    const params = this.spawnArgs(template, args);
    const finalName = name === undefined || name === null ? template : text(name, 'name', 200);
    const finalGoal = goal === undefined || goal === null ? finalName : text(goal, 'goal');
    return this.repository.create(parentPid, definition, finalName, finalGoal, { params });
  }

  _transition(pid, target, { cancel = true, result = undefined } = {}) {
    const process = this.repository.get(pid);
    if (pid === 0) throw new LushError('PID 0 is managed by the daemon; use lush daemon stop');
    if (process.status === target) return process;
    validateTransition(process, target);
    const terminal = !ACTIVE.has(target) && target !== 'reclaimed';
    const updated = this.repository.transition(pid, target, { adopt: terminal, result });
    if (cancel && terminal && this.runtime) this.runtime.cancel(pid);
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

  updateState(pid, patch) {
    this.requireRunning(pid);
    if (!isPlainObject(patch) || Object.getOwnPropertySymbols(patch).length) {
      throw new LushError('patch must be a JSON object with string keys', -32602);
    }
    jsonDump(patch);
    return this.repository.updateState(pid, patch);
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

  /** External agent session metadata for `pid` (read-only; any lifecycle status). */
  session(pid) {
    validPid(pid);
    if (this.runtime === null) throw new LushError('AgentRuntime is not bound', -32020);
    return this.runtime.session(pid);
  }
}
