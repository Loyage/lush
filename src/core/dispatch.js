/** Shared named-argument validation for Core adapters (RPC methods and Agent tools). */
import { LushError, isPlainObject } from './types.js';

/** Maps RPC/manager methods to their declared named parameters. */
export const PARAMS = {
  // processes: passive nodes
  list: { required: [] },
  tree: { required: [], optional: ['agents'] },
  inspect: { required: ['pid'] },
  parent: { required: ['pid'] },
  children: { required: ['pid'] },
  view: { required: ['pid'], optional: ['sections'] },
  spawn: { required: ['parent_pid', 'template'], optional: ['name', 'goal', 'variables', 'agent'] },
  start: { required: ['pid'] },
  stop: { required: ['pid'] },
  delete: { required: ['pid'], optional: ['recursive'] },
  purge: { required: ['pid'], optional: ['recursive'] },
  update_state: { required: ['pid', 'patch'] },
  update_vars: { required: ['pid', 'patch'] },
  orphans: { required: [] },
  orphan_sweep: { required: [] },
  // tasks: units of work mounted on a process
  task_list: { required: [], optional: ['pid', 'status', 'roots', 'limit'] },
  task_tree: { required: ['task_id'] },
  task_inspect: { required: ['task_id'] },
  task_result: { required: ['task_id'] },
  task_history: { required: ['task_id'], optional: ['after', 'limit'] },
  task_wait: { required: ['task_id'] },
  task_spawn: { required: ['pid', 'goal'], optional: ['parent_task_id'] },
  task_complete: { required: ['task_id'], optional: ['result'] },
  task_cancel: { required: ['task_id'] },
  task_update_state: { required: ['task_id', 'patch'] },
  task_delete: { required: ['task_id'], optional: ['recursive'] },
  // the agent that works on a task (runtime data)
  agents_list: { required: [], optional: ['task_id', 'pid', 'all'] },
  agents_show: { required: ['id'] },
  agents_kill: { required: ['id'] },
  session: { required: ['task_id'] },
  // the user-facing entry: a root task on a process
  call: { required: ['pid', 'goal'], optional: ['detach', 'interactive'] },
  call_describe: { required: ['pid', 'prompt'] },
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
