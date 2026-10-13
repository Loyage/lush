import { api } from './api.js';
import { projectBase, routeContext } from './route.js';
import { workerNumber, taskTitle, statusOf } from './format.js';
import { validWorkNumber, workTypeLabel } from './work-type.js';

const LIMIT = 256, TTL = 30000;
const cache = new Map(); // Only bounded, plain-text summaries; never retain inspect payloads.
const positive = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const excerpt = (value, truncated = false) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text ? `${text.slice(0, 360)}${text.length > 360 || truncated ? '…' : ''}` : '（无正文）';
};

export function workerPreviewText(task) {
  const goal = task.goal ?? task.goal_preview;
  const rawTitle = task.display_title || task.auto_title || task.title || taskTitle({ ...task, goal });
  const title = typeof rawTitle === 'string' ? `${rawTitle.slice(0, 120)}${rawTitle.length > 120 ? '…' : ''}` : '';
  return [`${workTypeLabel(task)} ${workerNumber(task)}${title ? ` · ${title}` : ''}`,
    excerpt(goal, task.goal_truncated), task.status ? `状态：${statusOf(task).label}` : ''].filter(Boolean).join('\n');
}
export function inputPreviewText(record) {
  return `原始指令 O${record.id}\n${excerpt(record.content, record.content_truncated || record.truncated)}`;
}

/** Explicit navigation buttons carry identity; action buttons deliberately do not. */
export function bindWorkerPreview(node, value) {
  const task = value && typeof value === 'object' ? value : { id: value };
  if (!positive(task.id)) return node;
  const identity = String(task.id);
  if (node.getAttribute('data-preview-worker') !== identity) node.setAttribute('data-preview-worker', identity);
  if (typeof (task.goal ?? task.goal_preview) === 'string') {
    const text = workerPreviewText(task);
    if (node.getAttribute('data-preview-text') !== text) node.setAttribute('data-preview-text', text);
  } else if (node.getAttribute('data-preview-text') !== null) node.removeAttribute('data-preview-text');
  if (node.getAttribute('title') !== null) node.removeAttribute('title');
  return node;
}

/** Recognize only same-origin project navigation, not lookalike external links. */
export function entityPreviewTarget(node) {
  const explicit = node?.getAttribute?.('data-preview-worker');
  if (positive(explicit)) return { kind: 'worker', id: Number(explicit), base: projectBase() };
  const href = node?.tagName === 'A' && (node.getAttribute?.('href') || node.href);
  if (!href || routeContext().invalid) return null;
  let url;
  try { url = new URL(href, globalThis.location?.href || `${globalThis.location?.origin || 'http://localhost'}${globalThis.location?.pathname || '/'}`); }
  catch { return null; }
  if (url.origin !== (globalThis.location?.origin || 'http://localhost') || url.search) return null;
  const project = /^\/p\/([a-f0-9]{16})\/$/.exec(url.pathname);
  if (!project && url.pathname !== (globalThis.location?.pathname || '/')) return null;
  const base = project ? `/p/${project[1]}` : projectBase();
  let match = /^#worker-([1-9]\d*)$/.exec(url.hash);
  if (match && positive(match[1])) return { kind: 'worker', id: Number(match[1]), base };
  match = /^#worker-number-(.+)$/.exec(url.hash);
  if (match && validWorkNumber(match[1])) return { kind: 'worker-number', number: match[1], base };
  match = /^#input-input-([1-9]\d*)$/.exec(url.hash);
  return match && positive(match[1]) ? { kind: 'input', id: Number(match[1]), base } : null;
}
export function previewPlaceholder(target) {
  const label = target.kind === 'input' ? `原始指令 O${target.id}` : `${target.number?.startsWith('V') ? 'Valet' : 'Worker'} ${target.number || `#${target.id}`}`;
  return `${label}\n正在读取简介…`;
}

/** Called only after intentional hover/focus/long press; failures retry on the next visit. */
export function loadEntityPreview(target) {
  const key = `${globalThis.location?.origin || ''}${target.base}:${target.kind}:${target.id ?? target.number}`;
  const known = cache.get(key);
  if (known && (known.pending || Date.now() - known.at < TTL)) return known.promise;
  const entry = { pending: true, at: Date.now() };
  entry.promise = (async () => {
    let id = target.id;
    if (target.kind === 'worker-number') {
      const found = await api(`${target.base}/api/worker-lookup?number=${encodeURIComponent(target.number)}`);
      if (found?.worker_number !== target.number || !positive(found?.id)) throw new Error('Worker 不存在');
      id = found.id;
    }
    const record = await api(`${target.base}/api/${target.kind === 'input' ? `input/input/${id}` : `worker/${id}`}`);
    if (record?.id !== id || typeof (target.kind === 'input' ? record.content : record.goal) !== 'string') throw new Error('简介不可用');
    return target.kind === 'input' ? inputPreviewText(record) : workerPreviewText(record);
  })().then(text => { entry.pending = false; entry.at = Date.now(); return text; }, error => {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  });
  cache.delete(key); cache.set(key, entry);
  if (cache.size > LIMIT) cache.delete(cache.keys().next().value);
  return entry.promise;
}
