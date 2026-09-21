import { createHash } from 'node:crypto';

// 两个跨模块的私有助手：
/** One task owns exactly one agent for its whole life; only the credential rotates per wake. */
export function agentView(task, run = null, latestRun = null) {
  const selected = run?.agent || (latestRun ? {
    agent: latestRun.provider || null, model: latestRun.model || '', thinking: latestRun.thinking || '',
  } : null);
  return { id: `${task.role}#${task.id}`, task_id: task.id, role: task.role, wakes: task.agent_wakes,
    created_at: task.created_at, last_seen_at: task.agent_last_seen_at, active: Boolean(run), pid: run?.pid ?? null,
    backend: selected?.agent || null, model: selected?.model || '', thinking: selected?.thinking || '' };
}
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
