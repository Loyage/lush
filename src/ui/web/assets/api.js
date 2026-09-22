import { refresh } from './navigate.js';
import { clear } from './messages.js';

// fetch 与用户动作。
export async function api(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401 && typeof globalThis.location?.assign === 'function') { location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`); throw new Error('登录已失效'); }
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || response.statusText); return value;
}
export async function action(method, params) {
  clear();
  const result = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  await refresh(); return result;
}

export async function loadHistory(taskId, before = null) {
  const cursor = before === null ? '' : `?before=${before}`;
  try {
    const page = await api(`/api/task/${taskId}/history-page${cursor}`);
    if (!Array.isArray(page)) return page;
  } catch { /* old Web host: fall back to the legacy ascending page */ }
  const events = await api(`/api/task/${taskId}/history?after=0`);
  return { events: Array.isArray(events) ? events : [], cursor: null, has_more: false, truncated: false, limit: 100 };
}
