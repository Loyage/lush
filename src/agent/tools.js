/**
 * Agent capability adapter: names/JSON schema only, Core owns business rules.
 *
 * The agent works *as a task* on a service: `task_*` tools move work (delegate
 * to a child service, message a parent or child, finish), `service_*` tools read
 * and shape the passive node it runs on (identity, permissions, variables,
 * persistent state, and constructing child services), and `notice` reports to the
 * user — the answer comes back as the task's next input, not as the tool's
 * result. The agent never blocks on its children, nor on the user.
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
  tool('task_construct', 'Delegate work downstream: create a child task on service `sid`. `sid` must be a direct child of your own service (construct the service first with service_construct if it does not exist yet). The child task starts running immediately; you are woken with its result when it settles.',
    { sid: SID, goal: STRING }, ['sid', 'goal']),
  tool('task_message', 'Send a message to your direct parent task or one of your direct child tasks (task_id). Use it to steer a child that is still working, to ask your parent something, or to report progress — it is queued on the receiver and delivered between two of its agent invocations, so it never interrupts work in flight. A parked task is woken by your message.',
    { task_id: SID, body: STRING }, ['task_id', 'body']),
  tool('task_cancel', 'Cancel one of your child tasks; its own child tasks are cancelled with it.',
    { task_id: SID }, ['task_id']),
  tool('task_complete', 'Finish your task. Only call this once the goal is really met; every child task must be finished (or cancelled) and every message read first. The result you pass is stored on the task and handed to your parent.',
    { result: {} }),
  tool('task_update_state', 'Shallow-merge JSON fields into your task\'s own scratch state (progress notes for this piece of work). The service has a separate, long-lived state.',
    { patch: { type: 'object' } }, ['patch']),
  tool('service_self', 'Inspect the passive node you run on: identity, variables, persistent state and child services.'),
  tool('service_parent', "Read your service's current parent (may be SID 0 after adoption)."),
  tool('service_children', "List your service's direct child services."),
  tool('service_inspect', 'Inspect another service.', { sid: SID }, ['sid']),
  tool('service_construct', 'Create and start a child service using an allowed template, so work can be delegated to it with task_construct. A singleton template fails while the parent already has an active instance; see available_child_templates for how to create each template and which variables it needs. A template that declares a reserved `name` variable (dev-task does) makes that variable the service name, so `name` is required and is checked against the declared pattern.',
    { template: STRING, name: STRING, goal: STRING, variables: { type: 'object' } }, ['template']),
  tool('service_update_state', 'Shallow-merge JSON fields into your service\'s long-lived state (knowledge that outlives this task). Variables are not writable here; use service_update_vars.',
    { patch: { type: 'object' } }, ['patch']),
  tool('service_update_vars', 'Change only the variables your service\'s template declares in the mutable group (see the `declarations` field of your variables). Variables declared immutable, names the template does not declare, and values that do not satisfy the declared format (pattern / max_length / single_line) are rejected.',
    { patch: { type: 'object' } }, ['patch']),
  tool('notice', 'Report to the user through Lush: use it when you are blocked and cannot proceed, when a decision only the user can make is required, or when a human must receive a result. `title` is one line, `body` is the full context; declare what you need filled in with `fields`. This tool returns immediately — with wait=true (the default) you are attached to the notice: end your turn and you will be woken with the user\'s answer (`answer`, `status`), so do not call task_complete while it is open. With wait=false it is only recorded, for status reports you do not need an answer to. A notice the user never answers leaves you waiting indefinitely; keep the ask small and specific.',
    {
      kind: { type: 'string', enum: ['report', 'decision', 'blocked'] },
      title: STRING,
      body: { type: 'string' },
      fields: { type: 'array', items: NOTICE_FIELD },
      wait: { type: 'boolean' },
    }, ['title']),
  tool('intent_context', 'Only for the task that is parsing a piece of user input: read that intension and the architecture it has to be judged against — the loaded template tree, the service tree with each node\'s active task, the whole open intension queue, the notices already waiting for the user, and `precheck`, the mechanical facts about the service the user named (exists / status / adopted / busy / duplicates in the queue). A precheck fact is a conflict candidate, not a verdict.'),
  tool('intent_settle', "Only for the task that is parsing a piece of user input: close it. `settled` means it was arranged (the tasks you delegated are recorded automatically) or answered; `rejected` means it is refused or the user chose to drop it — then `reason` is what the user reads. `response` is what the user is shown for this input; if you never call this, your final answer becomes the response.",
    {
      status: { type: 'string', enum: ['settled', 'rejected'] },
      response: { type: 'string' },
      reason: { type: 'string' },
    }, ['status']),
  tool('intent_defer', 'Only for the task that is parsing a piece of user input: the user chose "let that task finish first". The input goes back into the queue behind `task_id` and is parsed again once that task settles; nothing new is created now.',
    { task_id: SID, reason: { type: 'string' } }, ['task_id']),
];

export const TOOL_PARAMS = {
  task_self: { required: [] },
  task_children: { required: [] },
  task_construct: { required: ['sid', 'goal'] },
  task_message: { required: ['task_id', 'body'] },
  task_cancel: { required: ['task_id'] },
  task_complete: { required: [], optional: ['result'] },
  task_update_state: { required: ['patch'] },
  service_self: { required: [] },
  service_parent: { required: [] },
  service_children: { required: [] },
  service_inspect: { required: ['sid'] },
  service_construct: { required: ['template'], optional: ['name', 'goal', 'variables'] },
  service_update_state: { required: ['patch'] },
  service_update_vars: { required: ['patch'] },
  notice: { required: ['title'], optional: ['kind', 'body', 'fields', 'wait'] },
  intent_context: { required: [] },
  intent_settle: { required: ['status'], optional: ['response', 'reason'] },
  intent_defer: { required: ['task_id'], optional: ['reason'] },
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
      task_construct: { params: TOOL_PARAMS.task_construct, fn: (sid, goal) => this.construct(sid, goal) },
      task_message: { params: TOOL_PARAMS.task_message, fn: (taskId, body) => this.sendMessage(taskId, body) },
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
      service_construct: {
        params: TOOL_PARAMS.service_construct,
        fn: (template, name, goal, variables) => this.constructService(template, name, goal, variables),
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
      intent_context: {
        params: TOOL_PARAMS.intent_context,
        fn: () => manager.intensionContextOfTask(this.taskId),
      },
      intent_settle: {
        params: TOOL_PARAMS.intent_settle,
        fn: (status, response, reason) => manager.intensionSettleFromTask(this.taskId, status, response, reason),
      },
      intent_defer: {
        params: TOOL_PARAMS.intent_defer,
        fn: (taskId, reason) => manager.intensionDeferFromTask(this.taskId, taskId, reason),
      },
    };
  }

  self() {
    return this.manager.taskInspect(this.taskId);
  }

  children() {
    return this.manager.listChildTasks(this.taskId);
  }

  construct(sid, goal) {
    return this.manager.constructTask(this.taskId, sid, goal);
  }

  /** Message a direct parent / child task; it is queued and wakes a parked task. */
  sendMessage(taskId, body) {
    return this.manager.taskMessage(this.taskId, taskId, body);
  }

  cancel(taskId) {
    return this.manager.cancelChildTask(this.taskId, taskId);
  }

  complete(result = undefined) {
    // A message that arrived while this turn was running would be dropped by
    // finishing now; end the turn instead and it is delivered next invocation.
    const unread = this.manager.pendingTaskInput(this.taskId);
    if (unread > 0) {
      throw new LushError(
        `you have ${unread} unread message(s); end this turn and they will be delivered to you`,
        -32010,
      );
    }
    // An unsettled notice is the same shape of debt: the answer arrives as the
    // next input, so finishing now would have nowhere to hand it.
    const awaited = this.manager.awaitingNoticeCount(this.taskId);
    if (awaited > 0) {
      throw new LushError(
        `you have ${awaited} notice(s) the user has not settled; end this turn and you will be woken with the answer`,
        -32010,
      );
    }
    return this.manager.completeTask(this.taskId, result);
  }

  updateTaskState(patch) {
    return this.manager.updateTaskState(this.taskId, patch);
  }

  constructService(template, name = undefined, goal = undefined, variables = undefined) {
    return this.manager.construct(this.sid, template, name, goal, variables);
  }

  /**
   * Report to the user. The notice is recorded and returned immediately; when
   * `wait` is true the task is bound to it, and the runtime parks the task in
   * `awaiting` at the end of this turn so the user's answer arrives as the
   * task's next input. Nothing blocks inside the tool call.
   */
  notice(title, kind = 'report', body = '', fields = undefined, wait = true) {
    const posted = this.manager.postNotice({ taskId: this.taskId, kind, title, body, fields, wait });
    return { notice: posted, waiting: posted.wait };
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
