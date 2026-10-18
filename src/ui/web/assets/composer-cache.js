import { readStored, writeStored, storedKeys, scopedKey } from './prefs.js';
import { show } from './messages.js';

export const destinationKey = ({ mode, target_id, branch = 'main' }) => mode === 'append' ? `append:${target_id}` : mode === 'order' ? `order:${branch}` : 'management';
// UI expansion and settings alone are not unfinished input, but still survive collapse.
export const hasContent = entry => Boolean(entry?.content?.trim() || entry?.references?.length || entry?.saved);
const keepEntry = entry => hasContent(entry) || entry.profile || entry.expanded || entry.localOptions;
const cacheKey = () => scopedKey('lush.composer.workspace.v2');
const metadata = task => task ? Object.fromEntries(['id', 'worker_number', 'goal', 'display_title', 'auto_title', 'branch'].map(key => [key, task[key]])) : null;
const snapshot = entry => {
  const { key, mode, branch, target_id, destination, content, references, profile, expanded, scroll, selection, panelScroll, saved, localOptions, request } = entry;
  return { key, mode, branch, target_id, destination, content, references, profile, expanded, scroll, selection, panelScroll, saved, localOptions, request,
    task: metadata(entry.task), parent: metadata(entry.parent) };
};
function validate(value) {
  if (!value || !['order', 'append', 'management'].includes(value.mode) || typeof value.content !== 'string' || value.content.length > 32000 || !Array.isArray(value.references)
    || value.mode === 'append' && (!Number.isSafeInteger(value.target_id) || value.target_id <= 0)
    || value.mode === 'order' && (typeof value.branch !== 'string' || !value.branch)) throw Error('自动保存格式不完整');
  const destination = destinationKey(value);
  if (value.saved && (!Number.isSafeInteger(value.saved.id) || value.saved.id <= 0 || destinationKey(value.saved) !== destination)) throw Error('自动保存的草稿去向不匹配');
  const key = value.key || (value.saved ? `draft:${value.saved.id}` : destination);
  if (typeof key !== 'string' || key !== destination && key !== `draft:${value.saved?.id}` && !key.startsWith(`${destination}:local:`)) throw Error('自动保存身份不匹配');
  const entry = { ...snapshot({ ...value, key, destination }), cached: true, taskFresh: false };
  if (entry.task?.id !== entry.target_id) entry.task = null;
  return entry;
}
export function loadComposerCache() {
  const entries = new Map(), last = new Map(); let serial = 0;
  try {
    const raw = readStored(cacheKey());
    if (raw !== null) {
      const value = JSON.parse(raw);
      if (value?.version !== 2 || !Array.isArray(value.entries) || !Array.isArray(value.last)) throw Error('自动保存版本不兼容');
      for (const row of value.entries) { const entry = validate(row); entries.set(entry.key, entry); }
      for (const [destination, key] of value.last) if (entries.get(key)?.destination === destination) last.set(destination, key);
      serial = Number.isSafeInteger(value.serial) && value.serial >= 0 ? value.serial : 0;
    } else {
      // Discover pre-v2 destinations without opening them or mixing another project's keys.
      const prefix = 'lush.composer.edit.v1:';
      for (const key of storedKeys()) {
        if (!key.startsWith(prefix)) continue;
        const encoded = key.slice(prefix.length).split(':')[0], destination = decodeURIComponent(encoded);
        if (scopedKey(`${prefix}${encoded}`) !== key) continue;
        const old = JSON.parse(readStored(key) || 'null'); if (!old) continue;
        if (old.version !== 1) throw Error('自动保存版本不兼容');
        const spec = destination === 'management' ? { mode: 'management', branch: 'main' }
          : destination.startsWith('order:') ? { mode: 'order', branch: destination.slice(6) }
            : destination.startsWith('append:') ? { mode: 'append', target_id: Number(destination.slice(7)), branch: 'main' } : null;
        if (!spec) throw Error('自动保存去向不完整');
        const entry = validate({ ...old, ...spec }); entries.set(entry.key, entry); last.set(entry.destination, entry.key);
      }
    }
  } catch { show('浏览器自动保存读取失败；可读取的编辑仍保留，不会改投其他目标。', 'error'); }
  return { entries, last, serial };
}
export function cacheComposerWorkspace(space) {
  const ok = writeStored(cacheKey(), JSON.stringify({ version: 2, entries: [...space.entries.values()].filter(keepEntry).map(snapshot), last: [...space.last], serial: space.serial }));
  for (const entry of space.entries.values()) entry.cached = ok;
  if (!ok) show('浏览器自动保存失败；编辑仍保留在本页，刷新前请手动暂存或复制原文。', 'error');
}
