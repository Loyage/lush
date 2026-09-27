import { createHash } from 'node:crypto';

// 两个跨模块的私有助手：
/** One AP owns exactly one agent for its whole life; only the credential rotates per wake. */
export function agentView(ap, run = null, latestRun = null) {
  const selected = run?.agent || (latestRun ? {
    agent: latestRun.provider || null, model: latestRun.model || '', thinking: latestRun.thinking || '',
  } : null);
  return { id: `${ap.role}#${ap.id}`, ap_id: ap.id, role: ap.role, wakes: ap.agent_wakes,
    created_at: ap.created_at, last_seen_at: ap.agent_last_seen_at, active: Boolean(run), pid: run?.pid ?? null,
    backend: selected?.agent || null, model: selected?.model || '', thinking: selected?.thinking || '' };
}
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
