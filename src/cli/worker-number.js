import { check, id } from '../core/types.js';
import { workerNumber, isWorkerNumber } from '../core/worker-number.js';

/** User numbers are labels, not database IDs; only the daemon can resolve their identity. */
export async function resolveWorkerId(client, value) {
  if (typeof value !== 'string' || !/^[WV]/.test(value)) return id(value);
  workerNumber(value);
  const resolved = await client.request('worker.lookup', { number: value });
  check(resolved?.worker_number === value, 'invalid Worker lookup response');
  return id(resolved.id);
}

/** Only explicit stable metadata is a label; never derive a number from an integer ID. */
export const workerLabel = (task, fallback = `#${task?.id ?? '?'}`) => isWorkerNumber(task?.worker_number)
  ? task.worker_number : fallback;
export { inputNumber } from '../core/record-number.js';
