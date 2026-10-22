import { PARAMS, AGENT_ONLY, assertAllowed } from '../rpc/registry.js';
import { RETIRED_MANAGEMENT_METHODS } from '../rpc/management-policy.js';
import { check, isPlainObject, LushError } from '../core/types.js';

const excluded = new Set(['agent.registered_models.save', 'agent.registered_models.remove', 'administrator.dispatch', 'management.permissions_update', 'agent.usage.configure', 'agent.connections.login.start', 'agent.connections.login.finish',
  'agent.connections.device.start', 'agent.connections.device.poll', 'agent.connections.device.cancel', 'agent.environment', 'agent.connections.save']);
/** Legacy catalogue helper, not a grant. Native project execution imposes its stricter project scope. */
export function administratorProjectMethods() {
  return Object.keys(PARAMS).filter(method => !AGENT_ONLY.has(method) && !RETIRED_MANAGEMENT_METHODS.has(method) && !excluded.has(method));
}
export function assertAdministratorBusinessCall(project, method, params) {
  check(administratorProjectMethods().includes(method), 'method unavailable to administrator execution');
  check(isPlainObject(params) && !Object.keys(params).some(key => key.startsWith('_')), 'administrator business parameters cannot contain transport credentials');
  assertAllowed(method, params, null);
  if (['notice.answer', 'notice.dismiss'].includes(method)) {
    const notice = project.store.get('SELECT task_id FROM notices WHERE id=?', params.id);
    check(notice && project.store.task(notice.task_id).task_kind !== 'management', 'administrator cannot answer or dismiss Valet authorization or decision notices');
  }
  function inspect(value, depth = 0) {
    check(depth < 32, 'administrator parameter nesting limit');
    if (Array.isArray(value)) return value.forEach(item => inspect(item, depth + 1));
    if (!isPlainObject(value)) return;
    for (const [key, item] of Object.entries(value)) {
      check(!/(?:^|_)(?:credential|password|secret|token|env|prompt|private_key|api_key)(?:$|_)/i.test(key)
        && !/^(?:default_prompt|append_prompt|accessToken|refreshToken|apiKey|privatePrompt|systemPrompt)$/i.test(key), 'private authentication and prompt fields are not administrator tool parameters');
      inspect(item, depth + 1);
    }
  }
  inspect(params);
}

/** D738 retires device-wide signed dispatch. A legacy key never grants a native occurrence. */
export async function dispatchAdministrator() {
  throw new LushError('global administrator dispatch is retired; use project-local password elevation', -32601);
}
