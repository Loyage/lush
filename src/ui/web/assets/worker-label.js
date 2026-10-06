import { workerNumber } from './format.js';
import { ui } from './state.js';
import { projectBase } from './route.js';

const LIMIT = 2048;
const keyOf = id => `${globalThis.location?.origin || ''}${projectBase()}:${id}`;

/** Project-scoped, bounded metadata cache for links which only carry integer identity.
 * Only explicit server metadata is remembered: no ancestry/Input inference or label fetches.
 * An explicit null clears a stale label; missing fields from an old host keep known metadata.
 */
export function workerLabel(value, number = undefined) {
  const task = value && typeof value === 'object' ? value : { id: value, worker_number: number };
  const id = task.id;
  if (!Number.isSafeInteger(id) || id <= 0) return workerNumber(task);
  const key = keyOf(id);
  if (!ui.deletedWorkerIds.has(id) && task.worker_number !== undefined) {
    const label = workerNumber(task);
    if (label.startsWith('W')) {
      ui.workerNumbers.delete(key); ui.workerNumbers.set(key, label);
      if (ui.workerNumbers.size > LIMIT) ui.workerNumbers.delete(ui.workerNumbers.keys().next().value);
    } else ui.workerNumbers.delete(key);
    return label;
  }
  return !ui.deletedWorkerIds.has(id) && ui.workerNumbers.get(key) || workerNumber(task);
}
export function rememberWorkers(tasks = []) { for (const task of tasks) workerLabel(task); }
export function forgetWorkerLabel(id) { ui.workerNumbers.delete(keyOf(id)); }
