import { expect } from 'bun:test';

// A retired one-shot has no remaining authorization; outcomes live in the audit.
export function retiredHook(project, taskId, hookId) {
  expect(project.taskHooks(taskId).mounts.find(m => m.id === hookId)).toBeUndefined();
  expect(JSON.parse(project.store.task(taskId).hooks ?? '{"mounts":[]}').mounts.some(m => m.id === hookId)).toBe(false);
  const events = project.store.all("SELECT * FROM events WHERE task_id=? AND json_extract(data,'$.hook_id')=? ORDER BY id", taskId, hookId)
    .map(event => ({ ...event, data: JSON.parse(event.data) }));
  const success = events.findLast(e => e.type === 'hook.execution_succeeded' && e.data.hook_id === hookId);
  expect(success).toBeDefined();
  expect(events.filter(e => e.type === 'hook.removed' && e.data.hook_id === hookId && e.data.automatic)).toHaveLength(1);
  const submission = events.find(e => e.id === success.data.execution_id);
  const outcomes = events.filter(e => e.type === 'hook.action_completed' && e.data.execution_id === success.data.execution_id);
  return { id: success.data.execution_id, due_at: submission?.data.due_at, ...Object.assign({}, ...outcomes.map(e => e.data)) };
}

// Simulate a crash after durable action receipts, before final settlement/removal.
export async function interruptHookFinish(project, method, run) {
  const finish = project[method];
  project[method] = () => {};
  try { await run(); } finally { project[method] = finish; }
}
