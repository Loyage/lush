/** Shared named-argument validation for Core adapters (RPC methods and Agent tools). */
import { LushError, isPlainObject } from './types.js';

/** Maps RPC/manager methods to their declared named parameters. */
export const PARAMS = {
  // services: passive nodes
  list: { required: [] },
  tree: { required: [], optional: ['agents'] },
  inspect: { required: ['sid'] },
  parent: { required: ['sid'] },
  children: { required: ['sid'] },
  view: { required: ['sid'], optional: ['sections'] },
  construct: { required: ['parent_sid', 'template'], optional: ['name', 'goal', 'variables', 'agent'] },
  start: { required: ['sid'] },
  stop: { required: ['sid'] },
  delete: { required: ['sid'], optional: ['recursive'] },
  purge: { required: ['sid'], optional: ['recursive'] },
  update_state: { required: ['sid', 'patch'] },
  update_vars: { required: ['sid', 'patch'] },
  orphans: { required: [] },
  orphan_sweep: { required: [] },
  // tasks: units of work mounted on a service
  task_list: { required: [], optional: ['sid', 'status', 'roots', 'limit'] },
  task_tree: { required: ['task_id'] },
  task_inspect: { required: ['task_id'] },
  task_result: { required: ['task_id'] },
  task_history: { required: ['task_id'], optional: ['after', 'limit'] },
  task_wait: { required: ['task_id'] },
  task_construct: { required: ['sid', 'goal'], optional: ['parent_task_id'] },
  task_message: { required: ['from_task_id', 'to_task_id', 'body'] },
  task_inbox: { required: ['task_id'], optional: ['after', 'limit'] },
  task_complete: { required: ['task_id'], optional: ['result'] },
  task_cancel: { required: ['task_id'] },
  task_update_state: { required: ['task_id', 'patch'] },
  task_delete: { required: ['task_id'], optional: ['recursive'] },
  // the agent that works on a task (runtime data)
  agents_list: { required: [], optional: ['task_id', 'sid', 'all'] },
  agents_show: { required: ['id'] },
  agents_kill: { required: ['id'] },
  session: { required: ['task_id'] },
  // notices: a task's agent reporting to the user
  notice_list: { required: [], optional: ['status', 'task_id', 'sid', 'limit'] },
  notice_inspect: { required: ['notice_id'] },
  notice_post: { required: ['task_id', 'title'], optional: ['kind', 'body', 'fields', 'wait'] },
  notice_answer: { required: ['notice_id', 'answer'] },
  notice_dismiss: { required: ['notice_id'], optional: ['reason'] },
  // the user-facing entry: a root task on a service
  call: { required: ['sid', 'goal'], optional: ['detach', 'interactive'] },
  call_describe: { required: ['sid', 'prompt'] },
  call_end: { required: ['task_id', 'call_id', 'status'], optional: ['output', 'error'] },
  call_os_pid: { required: ['task_id', 'call_id', 'os_pid'] },
};
/**
 * Bind a JSON object of named arguments to a positional call: unknown and
 * missing arguments are rejected instead of silently ignored or defaulted.
 */
export function bindParams(params, signature = { required: [], optional: [] }) {
  if (!isPlainObject(params)) throw new LushError('params must be an object', -32602);
  if (Object.getOwnPropertySymbols(params).length) {
    throw new LushError('params must be an object with string keys', -32602);
  }
  const required = signature.required ?? [];
  const optional = signature.optional ?? [];
  const known = new Set([...required, ...optional]);
  for (const key of Object.keys(params)) {
    if (!known.has(key)) throw new LushError(`invalid params: unexpected argument '${key}'`, -32602);
  }
  const args = [];
  for (const key of required) {
    if (!Object.hasOwn(params, key)) {
      throw new LushError(`invalid params: missing required argument '${key}'`, -32602);
    }
    args.push(params[key]);
  }
  for (const key of optional) args.push(params[key]);
  return args;
}

export async function invoke(fn, params, signature) {
  const args = bindParams(params, signature);
  const value = fn(...args);
  return value !== null && typeof value === 'object' && typeof value.then === 'function'
    ? await value
    : value;
}
