import { PARAMS, AGENT_ONLY, assertAllowed } from '../rpc/registry.js';
import { RETIRED_MANAGEMENT_METHODS } from '../rpc/management-policy.js';
import { check, isPlainObject } from '../core/types.js';
import { settleNoticeAnswer } from '../core/project/messages.js';
import { verifyAdministratorRequest, administratorRequestHash, safeAdministratorValue } from './delegation.js';

const excluded = new Set(['administrator.dispatch', 'management.permissions_update', 'agent.usage.configure', 'agent.connections.login.start', 'agent.connections.login.finish',
  'agent.connections.device.start', 'agent.connections.device.poll', 'agent.connections.device.cancel', 'agent.environment', 'agent.connections.save']);
export function administratorProjectMethods() {
  return Object.keys(PARAMS).filter(method => !AGENT_ONLY.has(method) && !RETIRED_MANAGEMENT_METHODS.has(method) && !excluded.has(method));
}
export function assertAdministratorBusinessCall(project, method, params) {
  check(administratorProjectMethods().includes(method), 'method unavailable to administrator execution');
  check(isPlainObject(params) && !Object.keys(params).some(key => key.startsWith('_')), 'administrator business parameters cannot contain transport credentials');
  assertAllowed(method, params, null);
  // Never turn this identity into a user's approval of someone else's management authorization.
  if (['notice.answer','notice.dismiss'].includes(method)) {
    const notice = project.store.get('SELECT task_id FROM notices WHERE id=?', params.id);
    check(notice && project.store.task(notice.task_id).task_kind !== 'management', 'administrator cannot answer or dismiss Valet authorization or decision notices');
  }
  // Refuse secret-bearing values, not all configuration. Credentials stay on the existing user's UI.
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

/** The signed identity is not a project Agent and never enters the ordinary manager permission engine. */
export async function dispatchAdministrator(project, params, invoke) {
  check(!Object.hasOwn(params, '_token'), 'administrator delegation does not accept Agent credentials');
  const { request, signature } = params;
  const identity = verifyAdministratorRequest(project.config, request, signature);
  assertAdministratorBusinessCall(project, request.method, request.params);
  const fingerprint = administratorRequestHash({ project: request.project, method: request.method, params: request.params, identity });
  const key = `administrator.call:${identity.service_id}:${identity.call_id}`;
  const prior = project.store.get('SELECT value FROM meta WHERE key=?', key);
  if (prior) {
    const receipt = JSON.parse(prior.value);
    check(receipt.fingerprint === fingerprint, 'administrator call identity already used for another request');
    return receipt.response ?? { version: 1, status: 'unknown', effect: 'unknown', identity, event_id: receipt.event_id, replayed: true,
      error: '管理员调用已开始但未观察到完成；禁止自动重放。' };
  }
  let receipt;
  project.store.transaction(() => {
    const eventId = project.store.event(null, 'administrator.call_started', { identity, method: request.method, fingerprint });
    receipt = { fingerprint, event_id: eventId };
    project.store.run('INSERT INTO meta(key,value) VALUES (?,?)', key, JSON.stringify(receipt));
  });
  let response;
  try {
    let result;
    if (['notice.answer','notice.dismiss'].includes(request.method)) {
      const p = request.params;
      result = project.store.transaction(() => {
        if (p.expected_identity !== undefined) check(project.store.get('SELECT identity FROM notice_sync_records WHERE notice_id=?', p.id)?.identity === p.expected_identity, 'Notice record changed');
        return settleNoticeAnswer(project, p.id, p.answer ?? '', request.method === 'notice.dismiss', 'administrator');
      });
    } else result = await invoke(request.method, request.params);
    response = { version: 1, status: 'succeeded', effect: 'applied', identity, event_id: receipt.event_id, result: safeAdministratorValue(result) };
  } catch (error) {
    response = { version: 1, status: 'unknown', effect: 'unknown', identity, event_id: receipt.event_id,
      error: safeAdministratorValue({ name: error?.name ?? 'Error', message: error?.message ?? 'unclassified execution failure', code: error?.code ?? null }) };
  }
  // Durable completion precedes response. Failure here leaves the durable started receipt unknown.
  project.store.transaction(() => {
    project.store.event(null, 'administrator.call_finished', { identity, method: request.method, event_id: receipt.event_id, status: response.status, effect: response.effect, error: response.error ?? null });
    const source = JSON.stringify(response);
    check(Buffer.byteLength(source) <= 512000, 'administrator result exceeds durable completion budget');
    project.store.run('UPDATE meta SET value=? WHERE key=?', JSON.stringify({ ...receipt, response }), key);
  });
  return response;
}
