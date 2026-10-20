import { check, isPlainObject } from '../../core/types.js';
import { ADMINISTRATOR_API, ADMINISTRATOR_ROUTES, ADMINISTRATOR_LIMITS } from '../../administrator/protocol.js';
import { userBody, userQuery } from './server-query.js';

function fields(value, keys) {
  check(isPlainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'invalid administrator request fields');
}
function identifier(value) {
  check(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'invalid administrator identity');
  return value;
}
function page(query) {
  if (Object.hasOwn(query, 'limit')) {
    check(/^[1-9]\d*$/.test(query.limit) && Number(query.limit) <= ADMINISTRATOR_LIMITS.page, 'administrator limit must be 1..100');
    query.limit = Number(query.limit);
  }
  if (Object.hasOwn(query, 'before')) identifier(query.before);
  return query;
}

/** Trusted Host adapter. call is server-owned, never a URL/body-supplied RPC or credential. */
export function createAdministratorHostRoutes(call) {
  check(typeof call === 'function', 'administrator control adapter required');
  return async function handle(context) {
    const { request, url, json, user } = context;
    // Root-only even in bound Hosts: never attach a project or forward to an older daemon.
    if (/^\/p\/[a-z0-9]{16}\/api\/host\/administrator(?:\/|$)/.test(url.pathname)) return json({ error: 'not found' }, 404);
    if (url.pathname !== ADMINISTRATOR_API && !url.pathname.startsWith(`${ADMINISTRATOR_API}/`)) return null;
    check(user?.kind === 'user_session' && typeof user.sessionBinding === 'string' && /^[a-f0-9]{64}$/.test(user.sessionBinding), 'administrator entrance requires an authenticated user session');
    check(!request.headers.has('authorization') && !request.headers.has('x-lush-agent-token'), 'agent credentials cannot authorize administrator entrances');
    const action = url.pathname.slice(ADMINISTRATOR_API.length + 1);
    const invoke = (operation, params, start = false) => call(operation, params, { userBinding: user.sessionBinding, start });
    if (request.method === 'GET') {
      if (action === ADMINISTRATOR_ROUTES.status) {
        userQuery(url, []);
        return json(await invoke('status', {}));
      }
      if (action === ADMINISTRATOR_ROUTES.list) return json(await invoke('list', page(userQuery(url, ['before', 'limit']))));
      if (action === ADMINISTRATOR_ROUTES.detail) {
        const query = page(userQuery(url, ['id', 'before', 'limit']));
        identifier(query.id);
        return json(await invoke('detail', query));
      }
      if (action === ADMINISTRATOR_ROUTES.receipt) {
        const query = userQuery(url, ['client_request_id']);
        identifier(query.client_request_id);
        return json(await invoke('receipt', query));
      }
    }
    if (request.method === 'POST') {
      if ([ADMINISTRATOR_ROUTES.preview, ADMINISTRATOR_ROUTES.commit].includes(action))
        return json({ error: '全局管理员创建与输入入口已退役；请使用项目管家的单条密码提权。' }, 410);
      if (action === ADMINISTRATOR_ROUTES.stop) {
        const body = await userBody(request, url);
        fields(body, ['id']);
        return json(await invoke('stop', { id: identifier(body.id) }));
      }
    }
    return json({ error: 'not found' }, 404);
  };
}
