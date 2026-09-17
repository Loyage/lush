/** Shared named-argument validation for Core adapters (RPC methods and Agent tools). */
import { LushError, isPlainObject } from './types.js';

/** Maps RPC/manager methods to their declared named parameters. */
export const PARAMS = {
  list: { required: [] },
  tree: { required: [], optional: ['agents'] },
  agents_list: { required: [], optional: ['pid', 'all'] },
  agents_show: { required: ['id'] },
  agents_kill: { required: ['id'] },
  call_os_pid: { required: ['pid', 'call_id', 'os_pid'] },
  inspect: { required: ['pid'] },
  parent: { required: ['pid'] },
  children: { required: ['pid'] },
  view: { required: ['pid'], optional: ['sections'] },
  spawn: { required: ['parent_pid', 'template'], optional: ['name', 'goal', 'args'] },
  call: { required: ['pid', 'prompt'], optional: ['dry_run'] },
  call_begin: { required: ['pid', 'prompt'] },
  call_end: { required: ['pid', 'call_id', 'status'], optional: ['output', 'error'] },
  session: { required: ['pid'] },
  start: { required: ['pid'] },
  stop: { required: ['pid'] },
  kill: { required: ['pid'] },
  reclaim: { required: ['pid'] },
  update_state: { required: ['pid', 'patch'] },
  complete: { required: ['pid'], optional: ['result'] },
  history: { required: ['pid'], optional: ['after', 'limit'] },
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
