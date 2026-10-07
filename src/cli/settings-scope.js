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
  return scope === null ? null : normalizeConfigurationScope(scope);
}

/** Opt-in only, preserving legacy CLI calls and never adding scope to Worker/history operations. */
export function scopedSettingsClient(client, scope) {
  if (scope === null) return client;
  normalizeConfigurationScope(scope);
  const scoped = Object.create(client);
  scoped.request = (method, params) => client.request(method,
    PARAMS[method]?.includes('scope') && /^(agent|system|quick_explain)\./.test(method)
      ? { ...params, scope } : params);
  return scoped;
}
