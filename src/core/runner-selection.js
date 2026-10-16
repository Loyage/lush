import { check } from './types.js';

/** Shared syntax only. Live authorization/support checks belong to creation admission. */
export function validateRunnerNodeSelection(value) {
  check(value === 'local' || typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value),
    'runner_node_id must be a node UUID or local; omit it for automatic selection');
  return value;
}
