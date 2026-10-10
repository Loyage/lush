import { check, id } from '../core/types.js';

/** User numbers are labels, not database IDs; only the daemon can resolve their identity. */
export async function resolveWorkerId(client, value) {
  if (typeof value !== 'string' || !value.startsWith('W')) return id(value);
  check(/^W[1-9]\d*(?:-[1-9]\d*)*$/.test(value)
    && value.slice(1).split('-').every(part => Number.isSafeInteger(Number(part))),
  'Worker number must be Wn or Wn-n (positive integer components)');
  const resolved = await client.request('worker.lookup', { number: value });
  check(resolved?.worker_number === value, 'invalid Worker lookup response');
  return id(resolved.id);
}

/** Only explicit stable metadata is a label; never derive a number from an integer ID. */
export const workerLabel = (task, fallback = `#${task?.id ?? '?'}`) => typeof task?.worker_number === 'string'
  && /^W[1-9]\d*(?:-[1-9]\d*)*$/.test(task.worker_number) ? task.worker_number : fallback;
export { inputNumber } from '../core/record-number.js';
