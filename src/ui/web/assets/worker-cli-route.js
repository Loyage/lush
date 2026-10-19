import { el } from './dom.js';
import { projectBase } from './route.js';

export function workerCliTarget(hash) {
  const match = /^#worker-([1-9]\d*)-cli$/.exec(hash);
  const taskId = Number(match?.[1]);
  return match && Number.isSafeInteger(taskId) ? { taskId } : null;
}

/** Native new-tab navigation keeps the source project and the detail's draft intact. */
export function workerCliLink(task) {
  if (!['order', 'child'].includes(task.task_kind) || task.execution_retired === true) return null;
  const link = el('a', '打开 CLI 交互', 'nav-link worker-cli-open');
  link.href = `${projectBase()}/#worker-${task.id}-execution-cli`;
  link.target = '_blank'; link.rel = 'noopener';
  return link;
}
