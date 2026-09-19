import { $ } from './dom.js';
import { refresh } from './navigate.js';

// fetch 与用户动作。
export async function api(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401 && typeof globalThis.location?.assign === 'function') { location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`); throw new Error('登录已失效'); }
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || response.statusText); return value;
}
export async function action(method, params) {
  $('error').textContent = '';
  const result = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  await refresh(); return result;
}

export async function loadHistory(taskId) {
  const events = []; let after = 0;
  for (let page = 0; page < 5; page++) {
    const chunk = await api(`/api/task/${taskId}/history?after=${after}`);
    events.push(...chunk);
    if (chunk.length < 100) return { events, truncated: false };
    after = chunk.at(-1).id;
  }
  return { events, truncated: true };
}
