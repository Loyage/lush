import { refresh } from './navigate.js';
import { clear } from './messages.js';
import { projectApi } from './route.js';
import { ui } from './state.js';
import { publicReadCache } from './request-cache.js';

export { projectApi };
export const isReadAbort = error => error?.name === 'AbortError';
let startingReadSignal = null;
/** Bind only the synchronous start of an existing read helper, never its async continuations or writes. */
export function withReadSignal(signal, start) {
  const previous = startingReadSignal; startingReadSignal = signal;
  try { return start(); } finally { startingReadSignal = previous; }
}
const connectionNames = publicReadCache({
  scope: () => ({ project: projectApi('/api/'), boot: ui.workerNumbers }),
  load: async signal => {
    const value = await api('/api/agent/connections', { signal });
    if (!Array.isArray(value?.connections)) throw new Error('连接名称读面不可用');
    // Retain only names, never credentials, observations or configuration payloads.
    return value.connections.slice(0, 1000).map(row => ({ id: row.id, label: row.label }));
  },
});
export const loadConnectionNames = options => connectionNames.read(options);

function invalidatesNames(url, options) {
  if (options?.method?.toUpperCase() !== 'POST' || !/\/api\/(?:action|host\/settings\/action)$/.test(url)) return false;
  try {
    const method = JSON.parse(options.body)?.method;
    return typeof method === 'string' && (method.startsWith('agent.connections.') || ['agent.configure', 'worker.configure', 'worker.clear_override', 'settings.clear_override', 'settings.migration.apply'].includes(method));
  } catch { return false; }
}

// fetch 与用户动作。项目来源由 route.js 从地址推出，绝不从别处取「当前项目」。
export async function api(url, options) {
  if (startingReadSignal && ['GET', 'HEAD'].includes((options?.method || 'GET').toUpperCase()) && !options?.signal) {
    options = { ...options, signal: startingReadSignal };
  }
  const signal = ['GET', 'HEAD'].includes((options?.method || 'GET').toUpperCase()) ? options?.signal : null;
  const checkRead = () => { if (signal?.aborted) throw new DOMException('只读请求已取消', 'AbortError'); };
  checkRead();
  const response = await fetch(projectApi(url), options);
  checkRead();
  if (response.status === 401 && typeof globalThis.location?.assign === 'function') { location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`); throw new Error('登录已失效'); }
  const value = await response.json();
  checkRead();
  if (!response.ok) throw new Error(value.error || response.statusText);
  if (invalidatesNames(url, options)) connectionNames.invalidate();
  return value;
}
export async function action(method, params, options = {}) {
  clear();
  const result = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  if (options.refresh !== false) await refresh();
  return result;
}

export async function loadHistory(taskId, before = null, options) {
  // Capture a synchronous helper scope so the legacy fallback stays cancellable after await.
  if (startingReadSignal && !options?.signal) options = { ...options, signal: startingReadSignal };
  const cursor = before === null ? '' : `?before=${before}`;
  try {
    const page = await api(`/api/worker/${taskId}/history-page${cursor}`, options);
    if (!Array.isArray(page)) return page;
  } catch (error) {
    if (isReadAbort(error) || options?.signal?.aborted) throw error;
    /* old Web host: fall back to the legacy ascending page */
  }
  if (options?.signal?.aborted) throw new DOMException('只读请求已取消', 'AbortError');
  const events = await api(`/api/worker/${taskId}/history?after=0`, options);
  return { events: Array.isArray(events) ? events : [], cursor: null, has_more: false, truncated: false, limit: 100 };
}
