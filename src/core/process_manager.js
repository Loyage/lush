/** The shared business API used by RPC, Process handles and Agent Tools. */
import { ACTIVE, TASK_TERMINAL, validateTransition } from './lifecycle.js';
import { Process } from './process.js';
import { LushError, isPlainObject, jsonDump, text, validPid } from './types.js';

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

  requireRunning(pid) {
    const process = this.repository.get(pid);
    if (process.status !== 'running') {
      throw new LushError(`process ${pid} is ${process.status}, expected running`);
    }
    return process;
  }

  spawn(parentPid, template, name = undefined, goal = undefined) {
    const parent = this.requireRunning(parentPid);
    const definition = this.templates.get(template);
    if (template === 'lush-root') throw new LushError('lush-root is reserved for PID 0', -32010);
    const allowed = parent.template_snapshot.allowed_child_templates;
    if (!allowed.includes('*') && !allowed.includes(template)) {
      throw new LushError(`process ${parentPid} cannot create template ${template}`, -32010);
    }
    const finalName = name === undefined || name === null ? template : text(name, 'name', 200);
    const finalGoal = goal === undefined || goal === null ? finalName : text(goal, 'goal');
    return this.repository.create(parentPid, definition, finalName, finalGoal);
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

  async call(pid, prompt) {
    this.requireRunning(pid);
    text(prompt, 'prompt');
    if (this.runtime === null) throw new LushError('AgentRuntime is not bound', -32020);
    return this.runtime.call(pid, prompt);
  }
}
