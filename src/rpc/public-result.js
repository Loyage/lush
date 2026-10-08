/**
 * Worker rows may escape through old mutation envelopes as well as inspect/list.
 * Filter private Store columns at the single RPC exit, without mutating Store rows.
 * This is not generic secret detection: explicit user Agent config/env APIs retain
 * their authorized settings, including same-named environment-variable keys.
 */
export function publicResult(value, method = '') {
  const seen = new WeakMap();
  const agentConfig = method === 'agent.config' || method === 'agent.configure';
  const environment = method === 'agent.environment' || method === 'agent.environment.configure';
  const stringDictionary = entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    && [Object.prototype, null].includes(Object.getPrototypeOf(entry))
    && Object.values(entry).every(item => typeof item === 'string');
  const visit = (entry, configuration = false, depth = 0) => {
    if (entry === null || typeof entry !== 'object') return entry;
    const array = Array.isArray(entry), prototype = Object.getPrototypeOf(entry);
    // Non-JSON containers (e.g. Date) retain their normal serialization semantics.
    if (!array && prototype !== Object.prototype && prototype !== null) return entry;
    if (seen.has(entry)) return seen.get(entry);
    const copy = array ? new Array(entry.length) : Object.create(prototype);
    seen.set(entry, copy);
    let changed = false;
    for (const [key, child] of Object.entries(entry)) {
      if (key === 'retry_profile' || (['hooks', 'auto_merge', 'management'].includes(key) && typeof child === 'string')) {
        changed = true; continue;
      }
      // Profile env and environment API values are validated string maps, not
      // Worker records. Preserve legitimate hooks/auto_merge/management/retry_profile variables.
      const configured = configuration || (method === 'system.status' && depth === 0 && key === 'agent_config');
      const authorizedMap = configured && key === 'env' || environment && depth === 0 && key === 'values';
      const next = authorizedMap && stringDictionary(child) ? child : visit(child, configured, depth + 1);
      if (next !== child) changed = true;
      Object.defineProperty(copy, key, { value: next, enumerable: true, writable: true, configurable: true });
    }
    const result = changed ? copy : entry;
    seen.set(entry, result);
    return result;
  };
  return visit(value, agentConfig);
}
