import { check } from './types.js';

/** User-facing identity only. Integer database IDs, paths and permissions stay separate. */
export function workerNumber(value) {
  check(typeof value === 'string' && value.length <= 2048 && /^W[1-9]\d*(?:-[1-9]\d*)*$/.test(value)
    && value.slice(1).split('-').every(segment => Number.isSafeInteger(Number(segment))),
  'worker number must be Wn(-n)* with positive safe integer segments');
  return value;
}

export const workerLabel = task => task?.worker_number ?? `#${task?.id ?? '?'}`;
