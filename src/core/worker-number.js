import { check } from './types.js';

/** Shared display identity: development Workers have W paths; Valets have a flat V sequence. */
export const isWorkerNumber = value => typeof value === 'string' && value.length <= 2048
  && /^(?:W[1-9]\d*(?:-[1-9]\d*)*|V[1-9]\d*)$/.test(value)
  && value.slice(1).split('-').every(segment => Number.isSafeInteger(Number(segment)));

/** User-facing identity only. Integer database IDs, paths and permissions stay separate. */
export function workerNumber(value) {
  check(isWorkerNumber(value), 'worker number must be Wn(-n)* or Vn with positive safe integer segments');
  return value;
}

export const workerLabel = task => task?.worker_number ?? `#${task?.id ?? '?'}`;
