/**
 * Agent capability adapter: names/JSON schema only, Core owns business rules.
 *
 * The agent works *as a task* on a service: `task_*` tools move work (delegate
 * to a child service, wait for the children, finish), `service_*` tools read
 * and shape the passive node it runs on (identity, permissions, variables,
 * persistent state, and spawning child services).
 */
import { invoke } from '../core/dispatch.js';
import { LushError, jsonLoad } from '../core/types.js';

const SID = { type: 'integer', minimum: 0 };
const STRING = { type: 'string', minLength: 1 };

/** One answer-form field the reporter declares for the user to fill in. */
const NOTICE_FIELD = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Key the answer comes back under (identifier).' },
    label: { type: 'string', description: 'What to show the user; defaults to name.' },
    type: { type: 'string', enum: ['text', 'textarea', 'choice', 'boolean'] },
    required: { type: 'boolean' },
    options: { type: 'array', items: { type: 'string' }, description: 'Allowed values for a choice field.' },
    default: { description: 'Value used when the user leaves an optional field empty.' },
  },
  required: ['name'],
  additionalProperties: false,
};

function tool(name, description, properties = {}, required = []) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
  };
}

export const TOOL_DEFINITIONS = [
  tool('task_self', 'Inspect the task you are working on: its goal, status, result, and the service it is mounted on.'),
  tool('task_children', 'List the child tasks you have delegated to child services (id, service, status, result).'),
  tool('task_spawn', 'Delegate work downstream: create a child task on service `sid`. `sid` must be a direct child of your own service (spawn the service first with service_spawn if it does not exist yet). The child task starts running immediately; collect it later with task_wait. One active task per service: a busy child service refuses the delegation.',
    { sid: SID, goal: STRING }, ['sid', 'goal']),
  tool('task_wait', 'Block until one of your child tasks (or one of their descendants) is finished, then return its status and result. Waiting is what makes delegation observable and keeps the task tree settled.',
    { task_id: SID }, ['task_id']),
  tool('task_cancel', 'Cancel one of your child tasks; its own child tasks are cancelled with it.',
    { task_id: SID }, ['task_id']),
  tool('task_complete', 'Finish your task. Only call this once the goal is really met; every child task must be finished (or cancelled) first. The result you pass is stored on the task and returned to whoever is waiting.',
    { result: {} }),
  tool('task_update_state', 'Shallow-merge JSON fields into your task\'s own scratch state (progress notes for this piece of work). The service has a separate, long-lived state.',
    { patch: { type: 'object' } }, ['patch']),
  tool('service_self', 'Inspect the passive node you run on: identity, variables, persistent state and child services.'),
  tool('service_parent', "Read your service's current parent (may be SID 0 after adoption)."),
  tool('service_children', "List your service's direct child services."),
  tool('service_inspect', 'Inspect another service.', { sid: SID }, ['sid']),
  tool('service_spawn', 'Create and start a child service using an allowed template, so work can be delegated to it with task_spawn. A singleton template fails while the parent already has an active instance; see available_child_templates for how to create each template and which variables it needs. A template that declares a reserved `name` variable (dev-task does) makes that variable the service name, so `name` is required and is checked against the declared pattern.',
    { template: STRING, name: STRING, goal: STRING, variables: { type: 'object' } }, ['template']),
  tool('service_update_state', 'Shallow-merge JSON fields into your service\'s long-lived state (knowledge that outlives this task). Variables are not writable here; use service_update_vars.',
    { patch: { type: 'object' } }, ['patch']),
  tool('service_update_vars', 'Change only the variables your service\'s template declares in the mutable group (see the `declarations` field of your variables). Variables declared immutable, names the template does not declare, and values that do not satisfy the declared format (pattern / max_length / single_line) are rejected.',
    { patch: { type: 'object' } }, ['patch']),
  tool('notice', 'Report to the user through Lush and, by default, wait for their answer. Use it when you are blocked and cannot proceed, when a decision only the user can make is required, or when a human must receive a result. `title` is one line, `body` is the full context; declare what you need filled in with `fields`. The user answers or dismisses it and the answer comes back as this tool\'s result (`answer`, `status`). With wait=false it is only recorded and returns immediately, for status reports you do not need an answer to. A notice the user never answers blocks you indefinitely; keep the reporter and the ask small and specific.',
    {
      kind: { type: 'string', enum: ['report', 'decision', 'blocked'] },
      title: STRING,
      body: { type: 'string' },
      fields: { type: 'array', items: NOTICE_FIELD },
      wait: { type: 'boolean' },
    }, ['title']),
];

export const TOOL_PARAMS = {
  task_self: { required: [] },
  task_children: { required: [] },
  task_spawn: { required: ['sid', 'goal'] },
  task_wait: { required: ['task_id'] },
  task_cancel: { required: ['task_id'] },
  task_complete: { required: [], optional: ['result'] },
  task_update_state: { required: ['patch'] },
  service_self: { required: [] },
  service_parent: { required: [] },
  service_children: { required: [] },
  service_inspect: { required: ['sid'] },
  service_spawn: { required: ['template'], optional: ['name', 'goal', 'variables'] },
  service_update_state: { required: ['patch'] },
  service_update_vars: { required: ['patch'] },
  notice: { required: ['title'], optional: ['kind', 'body', 'fields', 'wait'] },
};

export class AgentTools {
  /** `taskId` is who the agent is; `sid` is the passive node it runs on. */
  constructor(manager, taskId, sid) {
    this.manager = manager;
    this.taskId = taskId;
    this.sid = sid;
    this.methods = {
      task_self: { params: TOOL_PARAMS.task_self, fn: () => this.self() },
      task_children: { params: TOOL_PARAMS.task_children, fn: () => this.children() },
      task_spawn: { params: TOOL_PARAMS.task_spawn, fn: (sid, goal) => this.spawn(sid, goal) },
      task_wait: { params: TOOL_PARAMS.task_wait, fn: (taskId) => this.wait(taskId) },
      task_cancel: { params: TOOL_PARAMS.task_cancel, fn: (taskId) => this.cancel(taskId) },
      task_complete: { params: TOOL_PARAMS.task_complete, fn: (result) => this.complete(result) },
      task_update_state: {
        params: TOOL_PARAMS.task_update_state,
        fn: (patch) => this.updateTaskState(patch),
      },
      service_self: { params: TOOL_PARAMS.service_self, fn: () => manager.inspect(this.sid) },
      service_parent: { params: TOOL_PARAMS.service_parent, fn: () => manager.parent(this.sid) },
      service_children: { params: TOOL_PARAMS.service_children, fn: () => manager.children(this.sid) },
      service_inspect: { params: TOOL_PARAMS.service_inspect, fn: (sid) => manager.inspect(sid) },
      service_spawn: {
        params: TOOL_PARAMS.service_spawn,
        fn: (template, name, goal, variables) => this.spawnService(template, name, goal, variables),
      },
      service_update_state: {
        params: TOOL_PARAMS.service_update_state,
        fn: (patch) => manager.updateState(this.sid, patch),
      },
      service_update_vars: {
        params: TOOL_PARAMS.service_update_vars,
        fn: (patch) => manager.updateVars(this.sid, patch),
      },
      notice: {
        params: TOOL_PARAMS.notice,
        fn: (title, kind, body, fields, wait) => this.notice(title, kind, body, fields, wait),
      },
    };
  }

  self() {
    return this.manager.taskInspect(this.taskId);
  }

  children() {
    return this.manager.listChildTasks(this.taskId);
  }

  spawn(sid, goal) {
    return this.manager.spawnTask(this.taskId, sid, goal);
  }

  async wait(taskId) {
    // Validated first: an unusable target must not park the task in `waiting`.
    const pending = this.manager.waitForTask(taskId, this.taskId);
    this.manager.taskWaiting(this.taskId, true);
    this.manager.runtime?.pauseTimer(this.taskId);
    try {
      const settled = await pending;
      return this.manager.taskResult(settled.id);
    } finally {
      this.manager.runtime?.resumeTimer(this.taskId);
      this.manager.taskWaiting(this.taskId, false);
    }
  }

  cancel(taskId) {
    return this.manager.cancelChildTask(this.taskId, taskId);
  }

  complete(result = undefined) {
    return this.manager.completeTask(this.taskId, result);
  }

  updateTaskState(patch) {
    return this.manager.updateTaskState(this.taskId, patch);
  }

  spawnService(template, name = undefined, goal = undefined, variables = undefined) {
    return this.manager.spawn(this.sid, template, name, goal, variables);
  }

  /**
   * Report to the user and — unless `wait` is false — park this task until they
   * answer or dismiss it. The same park-and-wake shape the task layer uses for
   * child results: the task goes to `waiting` and its hang timeout is paused,
   * because waiting on a human is not the agent hanging.
   */
  async notice(title, kind = 'report', body = '', fields = undefined, wait = true) {
    const posted = this.manager.postNotice({ taskId: this.taskId, kind, title, body, fields, wait });
    if (!posted.wait) return { notice: posted, waited: false };
    this.manager.taskWaiting(this.taskId, true);
    this.manager.runtime?.pauseTimer(this.taskId);
    try {
      const settled = await this.manager.waitForNotice(posted.id, this.taskId);
      if (settled === null) return { notice: posted, waited: false, status: 'removed' };
      return {
        notice: { ...posted, status: settled.status, note: settled.note },
        waited: true,
        status: settled.status,
        answer: settled.answer,
      };
    } finally {
      this.manager.runtime?.resumeTimer(this.taskId);
      this.manager.taskWaiting(this.taskId, false);
    }
  }

  async execute(name, args) {
    try {
      const method = this.methods[name];
      if (!method) throw new LushError(`unknown tool: ${name}`, -32601);
      let params;
      try {
        params = jsonLoad(args);
      } catch {
        throw new LushError('tool arguments must be a valid JSON object', -32602);
      }
      return { result: await invoke(method.fn, params, method.params) };
    } catch (err) {
      if (err instanceof LushError) return { error: { code: err.code, message: err.message } };
      throw err;
    }
  }
}
