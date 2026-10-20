import { check, isPlainObject } from '../../core/types.js';
import { userQuery } from './server-query.js';
import { normalizeProjectElevation, PROJECT_ELEVATION_HTTP, PROJECT_ELEVATION_RPC } from '../../administrator/project-protocol.js';
import { signProjectElevation } from '../../administrator/project-elevation-proof.js';

/** Host is the only password holder. The project receives a content-bound proof, never a password. */
export async function projectElevationRoute(context, binding) {
  const { request, url, json, user } = context;
  const submit = request.method === 'POST' && url.pathname === PROJECT_ELEVATION_HTTP.submit;
  const receipt = request.method === 'GET' && url.pathname === PROJECT_ELEVATION_HTTP.receipt;
  if (!submit && !receipt) return null;
  check(user?.kind === 'user_session' && typeof user.sessionBinding === 'string' && /^[a-f0-9]{64}$/.test(user.sessionBinding), 'project elevation requires a logged-in user');
  check(binding?.config?.project && binding.client && !request.headers.has('authorization') && !request.headers.has('x-lush-agent-token'), 'Agent credentials cannot authorize project elevation');
  if (receipt) {
    const params = userQuery(url, ['client_request_id']);
    check(typeof params.client_request_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(params.client_request_id), 'elevation request identity required');
    return json(await binding.client.request(PROJECT_ELEVATION_RPC.receipt, params));
  }
  check(!url.search && request.headers.get('content-type')?.split(';')[0] === 'application/json', 'elevation requires JSON without query parameters');
  let body;
  try { body = await request.json(); } catch { throw new Error('invalid elevation JSON request'); }
  check(isPlainObject(body) && Object.keys(body).sort().join(',') === 'confirm,definition,password' && body.confirm === true, 'explicit exact elevation confirmation required');
  const definition = normalizeProjectElevation(body.definition);
  check(typeof context.verifyElevationPassword === 'function', 'trusted password verifier required');
  let password = body.password; delete body.password;
  let verified;
  try { verified = await context.verifyElevationPassword(password); } finally { password = ''; }
  if (verified?.ok !== true) {
    return json({ error: verified?.error || '提权密码验证未通过；未提交执行。',
      code: verified?.code === 'elevation_password_rate_limited' ? 'elevation_password_rate_limited' : 'elevation_password_rejected',
      execution: 'not_started' }, [401, 403, 429].includes(verified?.status) ? verified.status : 403);
  }
  const proof = signProjectElevation(binding.config, definition, user.sessionBinding);
  // Explicit RPC names, no client-selected method and no generic /api/action password forwarding.
  return json(await binding.client.request(definition.kind === 'submit' ? PROJECT_ELEVATION_RPC.submit : PROJECT_ELEVATION_RPC.append, { proof }));
}
