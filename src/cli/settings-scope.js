import { option } from './args.js';
import { normalizeConfigurationScope } from '../core/device-config.js';
import { PARAMS } from '../rpc/registry.js';
import { check, isPlainObject } from '../core/types.js';

export function safeConfigurationScope(value) {
  if (value === undefined) return undefined;
  const keys = ['selected', 'source', 'device_home', 'project_home', 'project_override'];
  check(isPlainObject(value) && Object.keys(value).every(key => keys.includes(key))
    && ['device', 'project'].includes(value.selected) && ['device', 'project', 'default', 'mixed'].includes(value.source)
    && typeof value.project_override === 'boolean', 'invalid configuration scope response');
  for (const key of ['device_home', 'project_home']) check(value[key] === null || typeof value[key] === 'string'
    && value[key].length <= 4096 && !/[\x00-\x1f\x7f]/.test(value[key]), 'invalid configuration scope response');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

export function takeConfigurationScope(args) {
  const scope = option(args, '--scope');
  if (scope === null) return null;
  normalizeConfigurationScope(scope);
  check(scope === 'device', 'project configuration overrides are no longer supported; use --scope device');
  return scope;
}

/** Optional explicit device scope; omitted settings calls also use the backend's device authority. */
export function scopedSettingsClient(client, scope) {
  if (scope === null) return client;
  normalizeConfigurationScope(scope);
  check(scope === 'device', 'project configuration overrides are no longer supported; use device settings');
  const scoped = Object.create(client);
  scoped.request = (method, params) => client.request(method,
    PARAMS[method]?.includes('scope') && /^(agent|system|quick_explain)\./.test(method)
      ? { ...params, scope } : params);
  return scoped;
}
