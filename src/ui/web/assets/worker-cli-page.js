import { openExecutionPage } from './execution-page.js';

/** Legacy #worker-ID-cli links open the same fourth tab, never an ordinary page. */
export function openWorkerCliPage({ taskId }) {
  return openExecutionPage({ taskId, mode: 'cli' });
}
