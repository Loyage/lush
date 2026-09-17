/** Agent capability adapter: names/JSON schema only, Core owns business rules. */
import { invoke } from '../core/dispatch.js';
import { LushError, jsonLoad } from '../core/types.js';

const PID = { type: 'integer', minimum: 0 };
const STRING = { type: 'string', minLength: 1 };

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
  tool('process_self', 'Inspect this process: identity, goal, persistent context and recent history.'),
  tool('process_parent', "Read this process's current parent (may be PID 0 after adoption)."),
  tool('process_children', "List this process's direct children."),
  tool('process_inspect', 'Inspect another process.', { pid: PID }, ['pid']),
  tool('process_spawn', 'Create and start a child using an allowed template. Both tasks and services may create either kind. A singleton template fails while the parent already has an active instance; see available_child_templates for how to create each template and which variables it needs.',
    { template: STRING, name: STRING, goal: STRING, variables: { type: 'object' } }, ['template']),
  tool('process_call', 'Call another running process. Recursive and busy calls fail immediately.',
    { pid: PID, prompt: STRING }, ['pid', 'prompt']),
  tool('process_update_state', 'Shallow-merge JSON fields into your own persistent state, not lifecycle metadata. Cannot write process variables; use process_update_vars for those.',
    { patch: { type: 'object' } }, ['patch']),
  tool('process_update_vars', 'Change only the variables your own template declares in the mutable group (see the `declarations` field of your variables). Variables declared immutable, and names the template does not declare, are rejected.',
    { patch: { type: 'object' } }, ['patch']),
  tool('process_complete', 'Explicitly complete your own Task only when its goal is met. Active children are adopted by PID 0. Services cannot complete.',
    { result: {} }),
];

export const TOOL_PARAMS = {
  process_self: { required: [] },
  process_parent: { required: [] },
  process_children: { required: [] },
  process_inspect: { required: ['pid'] },
  process_spawn: { required: ['template'], optional: ['name', 'goal', 'variables'] },
  process_call: { required: ['pid', 'prompt'] },
  process_update_state: { required: ['patch'] },
  process_update_vars: { required: ['patch'] },
  process_complete: { required: [], optional: ['result'] },
};

export class AgentTools {
  constructor(manager, pid) {
    this.manager = manager;
    this.pid = pid;
    this.methods = {
      process_self: { params: TOOL_PARAMS.process_self, fn: () => this.self() },
      process_parent: { params: TOOL_PARAMS.process_parent, fn: () => this.parent() },
      process_children: { params: TOOL_PARAMS.process_children, fn: () => this.children() },
      process_inspect: { params: TOOL_PARAMS.process_inspect, fn: (pid) => manager.inspect(pid) },
      process_spawn: {
        params: TOOL_PARAMS.process_spawn,
        fn: (template, name, goal, variables) => this.spawn(template, name, goal, variables),
      },
      process_call: { params: TOOL_PARAMS.process_call, fn: (pid, prompt) => this.call(pid, prompt) },
      process_update_state: {
        params: TOOL_PARAMS.process_update_state,
        fn: (patch) => this.updateState(patch),
      },
      process_update_vars: {
        params: TOOL_PARAMS.process_update_vars,
        fn: (patch) => this.updateVars(patch),
      },
      process_complete: { params: TOOL_PARAMS.process_complete, fn: (result) => this.complete(result) },
    };
  }

  self() {
    return this.manager.inspect(this.pid);
  }

  parent() {
    return this.manager.parent(this.pid);
  }

  children() {
    return this.manager.children(this.pid);
  }

  spawn(template, name = undefined, goal = undefined, variables = undefined) {
    return this.manager.spawn(this.pid, template, name, goal, variables);
  }

  async call(pid, prompt) {
    this.manager.requireRunning(this.pid);
    return this.manager.call(pid, prompt);
  }

  updateState(patch) {
    return this.manager.updateState(this.pid, patch);
  }

  updateVars(patch) {
    return this.manager.updateVars(this.pid, patch);
  }

  complete(result = undefined) {
    return this.manager.complete(this.pid, result);
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
