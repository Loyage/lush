import { check } from '../core/types.js';

/** v1 explicitly enabled public listening; v2 separates authentication from exposure. */
export function webListenHost(value) {
  check(value && [1, 2].includes(value.version), 'Web auth config must have version 1 or 2');
  if (value.version === 1) {
    check(value.listen === undefined, 'Web auth version 1 does not accept listen; use version 2');
    return '0.0.0.0';
  }
  check(value.listen === undefined || ['loopback', 'public'].includes(value.listen), 'Web auth listen must be loopback or public');
  return value.listen === 'public' ? '0.0.0.0' : '127.0.0.1';
}
