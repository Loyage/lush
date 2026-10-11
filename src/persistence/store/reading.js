import { check, id, isPlainObject } from '../../core/types.js';
import { MESSAGE_SELECT } from './messages.js';

const CHARS = 24000, ROW_BYTES = 16 * 1024 * 1024, CLASS_BYTES = 400000;
const TEXT_KEYS = ['body', 'result', 'answer'];
const IDENTITY_KEYS = ['message_id','run_id','sender','source_task_id','target_task_id','notice_id','notice_kind',
  'answer_source','append_number','dismiss','signal','key','worker_number','input_delivery_tracked','goal','message_ids'];
const PRIVATE_KEYS = new Set(['retry_profile', 'hooks', 'auto_merge', 'management']);
const cursor = value => {
  check(value == null || Number.isSafeInteger(value) && value >= 0, 'invalid reading cursor');
  return value ?? null;
};
const source = value => ['user', 'lush'].includes(value) ? value : null;

// Offsets count UTF-16 code units, but never split a valid surrogate pair.
function segment(text, offset = 0, max = CHARS) {
  check(Number.isSafeInteger(offset) && offset >= 0 && offset <= text.length, 'invalid reading offset');
  check(!(offset > 0 && /[\uD800-\uDBFF]/u.test(text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(text[offset] ?? '')),
    'reading offset splits a surrogate pair');
  let end = Math.min(text.length, offset + max);
  if (end > offset && end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end])) end--;
  return { text: text.slice(offset, end), offset, next_offset: end, has_more: end < text.length, total_chars: text.length };
}

function fields(data) {
  return TEXT_KEYS.filter(key => Object.hasOwn(data, key) && data[key] != null).map(key => ({ key,
    text: typeof data[key] === 'string' ? data[key] : JSON.stringify(data[key]) }));
}
function matches(data, texts, query) {
  if (!query || texts.some(value => value.text.toLowerCase().includes(query))) return true;
  // Also search decoded answer strings (including newlines), not just JSON escapes.
  const pending = TEXT_KEYS.map(key => data[key]);
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string' && value.toLowerCase().includes(query)) return true;
    if (value && typeof value === 'object') for (const child of Object.values(value)) pending.push(child);
  }
  return false;
}

// Preserve ordinary event metadata, explicitly report bounded/omitted large metadata.
function metadata(data, limitations) {
  let nodes = 0, chars = 0, limited = false;
  const visit = (value, depth = 0) => {
    if (++nodes > 200 || depth > 8) { limited = true; return null; }
    if (typeof value === 'string') {
      const out = segment(value, 0, Math.max(0, Math.min(2048, 8192 - chars))).text;
      chars += out.length; if (out.length !== value.length) limited = true;
      return out;
    }
    if (value === null || typeof value !== 'object') return value;
    const out = Array.isArray(value) ? [] : {};
    for (const [key, child] of Object.entries(value)) {
      if (PRIVATE_KEYS.has(key)) { limited = true; continue; }
      if (nodes >= 200 || key.length > 200) { limited = true; break; }
      Object.defineProperty(out, key, { value: visit(child, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  const out = {};
  const keys = [...IDENTITY_KEYS.filter(key => Object.hasOwn(data, key)),
    ...Object.keys(data).filter(key => !IDENTITY_KEYS.includes(key))];
  for (const key of keys) {
    const value = data[key];
    if (TEXT_KEYS.includes(key)) continue;
    if (PRIVATE_KEYS.has(key)) { limited = true; continue; }
    if (nodes >= 200 || key.length > 200) { limited = true; break; }
    Object.defineProperty(out, key, { value: visit(value), enumerable: true, writable: true, configurable: true });
  }
  if (limited) limitations.push('event_metadata_bounded');
  return out;
}

function delivery(store, taskId, messageId) {
  if (!Number.isSafeInteger(messageId)) return { status: 'unknown', at: null };
  const receipts = store.all(`SELECT e.id,e.type,e.created_at FROM events e,
    json_each(CASE WHEN json_valid(e.data) THEN e.data ELSE '{}' END,'$.message_ids') j
    WHERE e.task_id=? AND j.value=? AND (e.type='invocation.inputs_delivered'
      OR (e.type='invocation.started' AND json_extract(CASE WHEN json_valid(e.data) THEN e.data ELSE '{}' END,'$.input_delivery_tracked') IS NULL))
      AND json_type(CASE WHEN json_valid(e.data) THEN e.data ELSE '{}' END,'$.message_ids')='array' ORDER BY e.id LIMIT 1`, taskId, messageId);
  if (receipts[0]?.type === 'invocation.inputs_delivered') return { status: 'delivered', at: receipts[0].created_at };
  const message = store.get('SELECT consumed FROM messages WHERE task_id=? AND id=?', taskId, messageId);
  return { status: receipts.length || !message || message.consumed === 1 ? 'unknown' : 'pending', at: null };
}

// Fetch only evidence fields from the complete audit history, not its body or the current cursor page.
function inputEvent(store, taskId, message) {
  const json = "CASE WHEN json_valid(data) THEN data ELSE '{}' END";
  const row = store.get(`SELECT id,task_id,type,created_at,
    json_type(${json},'$.sender') AS sender_type,json_extract(${json},'$.sender') AS sender,
    json_type(${json},'$.append_number') AS append_type,json_extract(${json},'$.append_number') AS append_number
    FROM events WHERE task_id=? AND type='message'
      AND json_type(${json},'$.message_id')='integer' AND json_extract(${json},'$.message_id')=?
    ORDER BY id LIMIT 1`, taskId, message.id);
  if (!row) return null;
  const data = { message_id: message.id }, limitations = [];
  if (row.sender_type === 'null' || row.sender_type === 'integer') {
    if (row.sender === message.sender_id) data.sender = row.sender;
    else limitations.push('message_event_sender_mismatch');
  }
  if (row.append_type === 'null') data.append_number = null;
  else if (row.append_type === 'text') {
    data.append_number = segment(row.append_number, 0, 2048).text;
    if (data.append_number.length !== row.append_number.length) limitations.push('event_append_number_bounded');
  }
  const evidence = { id: row.id, task_id: taskId, type: row.type, created_at: segment(row.created_at, 0, 128).text, data };
  if (data.sender === null) evidence.input_delivery = delivery(store, taskId, message.id);
  if (limitations.length) evidence.limitations = limitations;
  return evidence;
}

function load(store, taskId, kind, recordId) {
  const table = kind === 'event' ? 'events' : 'messages', column = kind === 'event' ? 'data' : 'body';
  const header = store.get(`SELECT id,task_id,created_at,${kind === 'event' ? 'type,' : ''}
    length(CAST(${column} AS BLOB)) AS bytes FROM ${table} WHERE task_id=? AND id=?`, taskId, recordId);
  check(header, 'reading record not found in worker');
  const limitations = [];
  if (header.bytes > ROW_BYTES) return { row: header, texts: [], text: '', limitations, error: 'record_exceeds_16_mib' };
  if (kind === 'message') {
    const row = store.get(`${MESSAGE_SELECT} WHERE m.task_id=? AND m.id=?`, taskId, recordId);
    if (typeof row.body !== 'string') return { row, texts: [], text: '', limitations, error: 'invalid_message_body' };
    return { row, texts: [{ key: 'body', text: row.body }], text: row.body, limitations };
  }
  const row = store.get('SELECT * FROM events WHERE task_id=? AND id=?', taskId, recordId);
  let data;
  try { data = JSON.parse(row.data); } catch { return { row: header, texts: [], text: '', limitations, error: 'invalid_event_json' }; }
  if (!isPlainObject(data)) return { row: header, texts: [], text: '', limitations, error: 'invalid_event_data' };
  row.data = data;
  let texts;
  try { texts = fields(data); } catch { return { row: header, texts: [], text: '', limitations, error: 'event_text_decode_failed' }; }
  let linked;
  if (!texts.length && Number.isSafeInteger(data.message_id)) {
    const exists = store.get('SELECT id FROM messages WHERE task_id=? AND id=?', taskId, data.message_id);
    if (exists) {
      linked = load(store, taskId, 'message', data.message_id);
      if (linked.error) return { row, texts: [], text: '', limitations, error: 'linked_message_' + linked.error };
      texts.push({ key: 'body', text: linked.text });
    } else return { row, texts: [], text: '', limitations, error: 'linked_message_unavailable' };
  }
  return { row, texts, text: texts.map(value => value.text).join('\n'), linked, limitations };
}

function projection(store, taskId, kind, loaded) {
  const { row, texts, text, linked, limitations } = loaded;
  const boundedLabel = (value, max, key) => {
    if (typeof value !== 'string') return value;
    const part = segment(value, 0, max).text;
    if (part.length !== value.length) limitations.push(`${key}_bounded`);
    return part;
  };
  const out = { id: row.id, task_id: taskId, created_at: boundedLabel(row.created_at, 128, 'created_at'),
    ...(kind === 'event' ? { type: boundedLabel(row.type, 2048, 'event_type') } : {}), text_truncated: text.length > CHARS, total_chars: text.length };
  if (loaded.error) return { ...out, text_truncated: true, total_chars: null, error: loaded.error, limitations };
  const preview = segment(text);
  out.text_truncated = preview.has_more;
  if (kind === 'message') {
    for (const key of ['sender_id','consumed','signal_type','signal_key','delivery_hold','append_number','task_worker_number','sender_worker_number']) {
      const value = row[key];
      out[key] = typeof value === 'string' ? segment(value, 0, 2048).text : value;
      if (typeof value === 'string' && value.length > out[key].length) limitations.push(`message_${key}_bounded`);
    }
    out.body = preview.text; out.answer_source = null;
    out.input_event = inputEvent(store, taskId, row);
  } else {
    out.data = metadata(row.data, limitations);
    let remaining = preview.text.length;
    for (const [index, field] of texts.entries()) {
      if (index > 0) remaining = Math.max(0, remaining - 1);
      const part = segment(field.text, 0, remaining).text;
      if (!linked) out.data[field.key] = part;
      remaining -= part.length;
    }
    // Notice provenance is only the explicit source on this audit event, never a body heuristic.
    out.answer_source = row.type === 'notice.answered' ? source(row.data.answer_source) : null;
    if (row.type === 'notice.answered') out.data.answer_source = out.answer_source;
    if (linked) out.message = { ...projection(store, taskId, 'message', linked) };
    if (row.type === 'message' && row.data.sender === null) out.input_delivery = delivery(store, taskId, row.data.message_id);
    if (row.type === 'invocation.inputs_delivered' && Array.isArray(out.data.message_ids)) {
      out.input_deliveries = out.data.message_ids.filter(Number.isSafeInteger).map(messageId => ({ message_id: messageId,
        ...delivery(store, taskId, messageId) }));
    }
  }
  if (limitations.length) out.limitations = limitations;
  return out;
}

/** Independent read-only scans. A byte boundary advances only through actually returned/scanned rows. */
export const reading = {
  readingPage(taskId, { before_event = null, before_message = null, limit = 50, query = '' } = {}) {
    taskId = id(taskId); this.task(taskId);
    before_event = cursor(before_event); before_message = cursor(before_message);
    check(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'reading limit must be 1..100');
    check(typeof query === 'string' && query.length <= 2000, 'reading query must be a string of at most 2000 characters');
    const needle = query.toLowerCase(), errors = [];
    const scan = (kind, before) => {
      if (before === 0) return { items: [], cursor: 0, has_more: false, scanned: 0 };
      const table = kind === 'event' ? 'events' : 'messages';
      const ids = this.all(`SELECT id FROM ${table} WHERE task_id=? ${before === null ? '' : 'AND id<?'} ORDER BY id DESC LIMIT ?`,
        ...[taskId, ...(before === null ? [] : [before]), limit + 1]);
      const items = []; let bytes = 0, scanned = 0, next = before;
      for (const row of ids.slice(0, limit)) {
        const loaded = load(this, taskId, kind, row.id);
        const match = loaded.error || matches(kind === 'event' ? loaded.row.data : {}, loaded.texts, needle);
        if (match) {
          const item = projection(this, taskId, kind, loaded), size = Buffer.byteLength(JSON.stringify(item));
          if (bytes + size > CLASS_BYTES && items.length) break;
          items.push(item); bytes += size;
          if (loaded.error) errors.push({ kind, record_id: row.id, error: loaded.error });
        }
        scanned++; next = row.id;
      }
      const hasMore = ids.length > scanned;
      return { items, cursor: hasMore ? next : 0, has_more: hasMore, scanned };
    };
    return this.transaction(() => {
      const events = scan('event', before_event), messages = scan('message', before_message);
      return { events: events.items, messages: messages.items, event_cursor: events.cursor, message_cursor: messages.cursor,
        has_more_events: events.has_more, has_more_messages: messages.has_more,
        scanned_events: events.scanned, scanned_messages: messages.scanned,
        scope: { task_id: taskId, events: 'all', messages: 'all_inbox', query }, errors };
    });
  },
  readingRecord(taskId, { kind, record_id, offset = 0 }) {
    taskId = id(taskId); this.task(taskId);
    check(kind === 'event' || kind === 'message', 'reading kind must be event or message');
    const loaded = load(this, taskId, kind, id(record_id));
    check(!loaded.error, `reading record unavailable: ${loaded.error}`);
    return { ...segment(loaded.text, offset), ...(loaded.limitations.length ? { limitations: loaded.limitations } : {}) };
  },
};
