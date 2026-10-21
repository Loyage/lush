import { api } from './api.js';

/** Count/select every unsent draft, including mounted and unknown receipts, across all targets. */
export async function composerDrafts(mode, current = () => true) {
  const items = new Map(), cursors = new Set(); let cursor = null;
  do {
    if (!current()) return null;
    const query = new URLSearchParams({ view: 'drafts', modes: JSON.stringify([mode]), limit: '100', ...(cursor ? { cursor } : {}) });
    const page = await api(`/api/inputs?${query}`);
    if (!current()) return null;
    if (!Array.isArray(page.items)) throw Error('草稿列表格式不兼容');
    for (const item of page.items) {
      if (item.kind !== 'draft' || !Number.isSafeInteger(item.id) || item.id <= 0 || (item.mode || 'order') !== mode)
        throw Error('草稿列表身份或模式不匹配');
      items.set(item.id, item);
    }
    cursor = page.next_cursor;
    if (cursor != null && typeof cursor !== 'string' || cursor && cursors.has(cursor)) throw Error('草稿分页异常，未能查完');
    cursors.add(cursor);
  } while (cursor);
  return [...items.values()];
}

/** A saved browser entry and its server row are one draft, not two unfinished inputs. */
export function composerDraftChoices(records, entries) {
  const choices = new Map(records.map(record => [`draft:${record.id}`, { record }]));
  for (const entry of entries) {
    const key = entry.saved ? `draft:${entry.saved.id}` : entry.key;
    choices.set(key, { ...choices.get(key), entry, record: choices.get(key)?.record || entry.saved });
  }
  return [...choices.values()];
}
