import { check, isPlainObject } from '../../core/types.js';
import { normalizeConfigurationScope } from '../../core/device-config.js';

export function settingQuery(url, keys = [], host = false) {
  const params = {};
  for (const [key, value] of url.searchParams) {
    check([...keys, 'scope'].includes(key) && !Object.hasOwn(params, key), 'unknown or duplicate settings query parameter');
    params[key] = value;
  }
  check(params.scope !== 'project', 'project setting overrides are no longer supported; use device settings');
  if (Object.hasOwn(params, 'scope')) normalizeConfigurationScope(params.scope);
  check(!host || params.scope === undefined || params.scope === 'device', 'Host settings only accept device scope');
  return host ? { ...params, scope: 'device' } : params;
}

export function userQuery(url, allowed) {
  const result = {};
  for (const [key, value] of url.searchParams) {
    check(allowed.includes(key) && !Object.hasOwn(result, key), 'unknown or duplicate user workspace query parameter');
    result[key] = value;
  }
  return result;
}
export async function userBody(request, url) {
  check(!url.search, 'user workspace mutation accepts no query parameters');
  check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
  return request.json();
}

export async function emptyJson(request) {
  check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'application/json required');
  const body = await request.json();
  check(isPlainObject(body) && Object.keys(body).length === 0, 'restart body must be an empty object; paths and agent tokens are not accepted');
}
