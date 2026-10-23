import { check, id } from './types.js';

// Main is a unique persisted project root, not an arbitrary branch owner or a
// client-selected cwd. History and execution share this identity boundary.
export function workerCLIIdentity(store, taskId) {
  const task = store.task(id(taskId));
  if (task.task_kind === 'main') {
    const roots = store.all("SELECT id FROM tasks WHERE task_kind='main' AND branch='main'");
    check(task.role === 'agent' && task.branch === 'main' && task.parent_id === null && task.target_branch === null
      && roots.length === 1 && roots[0].id === task.id, 'CLI requires the unique real project main Worker');
  } else check(['order', 'child'].includes(task.task_kind), 'CLI requires main or an order/child Worker; arbitrary owners are unavailable');
  return task;
}
