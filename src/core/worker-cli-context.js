import { check } from './types.js';
import { CONTEXT_PARAMETERS, validateContextCall, contextTarget } from './worker-context.js';

/** Called only by the dispatcher after matching a live, user-authorized CLI lease.
 * No synthetic actor or token: the final call goes through ordinary user authorization. */
export function userCLIContext(project, lease, method, params, run) {
  check(lease.contextMethod === method && lease.userRPC, 'CLI command has no user equivalent');
  check(!Object.hasOwn(params, '_token') && Object.keys(params).every(key => CONTEXT_PARAMETERS[method]?.includes(key)),
    'invalid user CLI context parameters');
  validateContextCall(method, params);
  let target;
  if (['context.inspect','context.history','context.transcript','context.message','context.accept'].includes(method))
    target = contextTarget(project, lease.taskId, method === 'context.accept' ? { relation: 'child', child: params.child } : params,
      method === 'context.message' ? ['parent','child'] : ['self','parent','child']);
  const pagination = Object.fromEntries(['after','limit'].filter(key => params[key] !== undefined).map(key => [key, params[key]]));
  let mapped;
  switch (method) {
    case 'context.inspect': mapped = { id: target.id }; break;
    case 'context.history': case 'context.transcript': mapped = { id: target.id, ...pagination }; break;
    case 'context.children': mapped = { id: lease.taskId, ...pagination }; break;
    case 'context.message': mapped = { id: target.id, body: params.body }; break;
    case 'context.accept': mapped = { id: target.id }; break;
    case 'context.spawn': mapped = { parent: lease.taskId, goal: params.goal, ...(params.name === undefined ? {} : { name: params.name }) }; break;
    case 'context.notice': mapped = { ...params, task: lease.taskId }; break;
    default: check(false, 'CLI command has no user equivalent');
  }
  check(!lease.contextUsed, 'user CLI context was already dispatched; do not replay');
  lease.contextUsed = true;
  return Promise.resolve(run(lease.userRPC, mapped)).then(value => method === 'context.children' ? value.children : value);
}
