import { check, id, isPlainObject } from '../../core/types.js';
import { MESSAGE_SELECT } from './messages.js';
import { eventMetadata as metadata, eventTextFields, PRIVATE_EVENT_KEYS, readingSegment, READING_CHARS, EVENT_TEXT_KEYS } from '../../ui/web/assets/reading-projection.js';

const CHARS = READING_CHARS, ROW_BYTES = 16 * 1024 * 1024, CLASS_BYTES = 400000;
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
  return readingSegment(text, offset, max);
}

function matches(data, texts, query, type = '') {
  if (!query || type.toLowerCase().includes(query) || texts.some(value => value.text.toLowerCase().includes(query))) return true;
  // Decoded authoritative text fields remain searchable even when an answer uses configuration-like names.
  const textPending = EVENT_TEXT_KEYS.map(key => data?.[key]);
  while (textPending.length) {
    const value = textPending.pop();
    if (typeof value === 'string' && value.toLowerCase().includes(query)) return true;
    if (value && typeof value === 'object') for (const child of Object.values(value)) textPending.push(child);
  }
  // Search full decoded safe metadata, not its bounded preview, and never private keys/values.
  const pending = [data];
  while (pending.length) {
    const value = pending.pop();
    if (value != null && typeof value !== 'object' && String(value).toLowerCase().includes(query)) return true;
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (PRIVATE_EVENT_KEYS.has(key)) continue;
      if (key.toLowerCase().includes(query)) return true;
      pending.push(child);
    }
  }
  return false;
}

function delivery(store, taskId, messageId) {
  if (!Number.isSafeInteger(messageId)) return { status: 'unknown', at: null };
  const receipts = store.all(`SELECT e.id,e.type,e.created_at FROM events e,
    json_each(${SAFE_JSON},'$.message_ids') j
    WHERE e.task_id=? AND j.value=? AND (e.type='invocation.inputs_delivered'
      OR (e.type='invocation.started' AND json_extract(${SAFE_JSON},'$.input_delivery_tracked') IS NULL))
      AND json_type(${SAFE_JSON},'$.message_ids')='array' ORDER BY e.id LIMIT 1`, taskId, messageId);
  if (receipts[0]?.type === 'invocation.inputs_delivered') return { status: 'delivered', at: segment(receipts[0].created_at, 0, 128).text };
  const message = store.get('SELECT consumed FROM messages WHERE task_id=? AND id=?', taskId, messageId);
  return { status: receipts.length || !message || message.consumed === 1 ? 'unknown' : 'pending', at: null };
}

// Fetch only evidence fields from the complete audit history, not its body or the current cursor page.
function inputEvent(store, taskId, message) {
  const json = `CASE WHEN length(CAST(data AS BLOB))<=${ROW_BYTES} AND json_valid(data) THEN data ELSE '{}' END`;
  const row = store.get(`SELECT id,task_id,type,created_at,
    json_type(${json},'$.sender') AS sender_type,json_extract(${json},'$.sender') AS sender,
    json_type(${json},'$.append_number') AS append_type,json_extract(${json},'$.append_number') AS append_number
    FROM events WHERE task_id=? AND type='message'
      AND json_type(${json},'$.message_id')='integer' AND json_extract(${json},'$.message_id')=?
    ORDER BY id LIMIT 1`, taskId, message.id);
  return inputEvidence(row, taskId, message, messageId => delivery(store, taskId, messageId));
}

function inputEvidence(row, taskId, message, getDelivery) {
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
  if (data.sender === null) evidence.input_delivery = getDelivery(message.id);
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
  return eventLoad(store, taskId, { ...row, bytes: header.bytes });
}

function eventLoad(store, taskId, row, context = null) {
  const header = { id: row.id, task_id: taskId, type: row.type, created_at: row.created_at }, limitations = [];
  if (row.bytes > ROW_BYTES) return { row: header, texts: [], text: '', limitations, error: 'record_exceeds_16_mib' };
  let data;
  try { data = isPlainObject(row.data) ? row.data : JSON.parse(row.data); } catch { return { row: header, texts: [], text: '', limitations, error: 'invalid_event_json' }; }
  if (!isPlainObject(data)) return { row: header, texts: [], text: '', limitations, error: 'invalid_event_data' };
  row.data = data;
  let texts;
  try { texts = eventTextFields(data); } catch { return { row: header, texts: [], text: '', limitations, error: 'event_text_decode_failed' }; }
  let linked;
  if (!texts.length && Number.isSafeInteger(data.message_id)) {
    const exists = context ? context.messages.has(data.message_id) : store.get('SELECT id FROM messages WHERE task_id=? AND id=?', taskId, data.message_id);
    if (exists) {
      linked = context ? context.messages.get(data.message_id) : load(store, taskId, 'message', data.message_id);
      if (linked.error) return { row, texts: [], text: '', limitations, error: 'linked_message_' + linked.error };
      texts.push({ key: 'body', text: linked.text });
    } else return { row, texts: [], text: '', limitations, error: 'linked_message_unavailable' };
  }
  if (!texts.length) {
    try { texts.push({ key: null, text: JSON.stringify(data, (key, value) => PRIVATE_EVENT_KEYS.has(key) ? undefined : value) }); }
    catch { return { row: header, texts: [], text: '', limitations, error: 'event_text_decode_failed' }; }
  }
  return { row, texts, text: texts.map(value => value.text).join('\n'), linked, ...(linked?.preview ? { preview: linked.preview } : {}), limitations };
}

function projection(store, taskId, kind, loaded, context = null) {
  const { row, texts, text, linked } = loaded, limitations = [...loaded.limitations];
  const boundedLabel = (value, max, key) => {
    if (typeof value !== 'string') return value;
    const part = segment(value, 0, max).text;
    if (part.length !== value.length) limitations.push(`${key}_bounded`);
    return part;
  };
  const out = { id: row.id, task_id: taskId, created_at: boundedLabel(row.created_at, 128, 'created_at'),
    ...(kind === 'event' ? { type: boundedLabel(row.type, 2048, 'event_type') } : {}), text_truncated: text.length > CHARS, total_chars: text.length };
  if (loaded.error) return { ...out, ...(kind === 'event' && isPlainObject(row.data) ? { data: metadata(row.data, limitations) } : {}),
    text_truncated: true, total_chars: null, error: loaded.error, limitations };
  const preview = loaded.preview ?? segment(text);
  out.text_truncated = preview.has_more; out.total_chars = preview.total_chars;
  if (kind === 'message') {
    for (const key of ['sender_id','consumed','signal_type','signal_key','delivery_hold','append_number','task_worker_number','sender_worker_number']) {
      const value = row[key];
      out[key] = typeof value === 'string' ? segment(value, 0, 2048).text : value;
      if (typeof value === 'string' && value.length > out[key].length) limitations.push(`message_${key}_bounded`);
    }
    out.body = preview.text; out.answer_source = null;
    out.input_event = context ? context.inputEvents.get(row.id) ?? null : inputEvent(store, taskId, row);
  } else {
    out.data = metadata(row.data, limitations);
    let remaining = preview.text.length;
    for (const [index, field] of texts.entries()) {
      if (index > 0) remaining = Math.max(0, remaining - 1);
      const part = segment(field.text, 0, remaining).text;
      if (field.key === null) out.reading_text = part;
      else if (!linked) out.data[field.key] = part;
      remaining -= part.length;
    }
    // Notice provenance is only the explicit source on this audit event, never a body heuristic.
    out.answer_source = row.type === 'notice.answered' ? source(row.data.answer_source) : null;
    if (row.type === 'notice.answered') out.data.answer_source = out.answer_source;
    if (linked) out.message = { ...projection(store, taskId, 'message', linked, context) };
    if (row.type === 'message' && row.data.sender === null) out.input_delivery = context ? context.delivery(row.data.message_id) : delivery(store, taskId, row.data.message_id);
    if (row.type === 'invocation.inputs_delivered' && Array.isArray(out.data.message_ids)) {
      out.input_deliveries = out.data.message_ids.filter(Number.isSafeInteger).map(messageId => ({ message_id: messageId,
        ...(context ? context.delivery(messageId) : delivery(store, taskId, messageId)) }));
    }
  }
  if (limitations.length) out.limitations = limitations;
  return out;
}

// Fetch full source text in byte-bounded batches, not a per-event query or one unbounded collection.
function chunks(headers, budget = ROW_BYTES) {
  const groups = []; let group = [], bytes = 0;
  for (const header of headers) {
    const size = header.bytes > ROW_BYTES ? 0 : header.bytes || 0;
    if (group.length && bytes + size > budget) { groups.push(group); group = []; bytes = 0; }
    group.push(header); bytes += size;
  }
  if (group.length) groups.push(group);
  return groups;
}
const holes = ids => ids.map(() => '?').join(',');
const SAFE_JSON = `CASE WHEN length(CAST(e.data AS BLOB))<=${ROW_BYTES} AND json_valid(e.data) THEN e.data ELSE '{}' END`;

function historyContext(store, taskId, rows) {
  const linkedIds = new Set(), ids = new Set();
  for (const row of rows) {
    const data = row.data || {};
    if (Number.isSafeInteger(data.message_id)) {
      ids.add(data.message_id);
      if (!EVENT_TEXT_KEYS.some(key => Object.hasOwn(data, key) && data[key] != null)) linkedIds.add(data.message_id);
    }
    const deliveredIds = row.type === 'invocation.inputs_delivered' ? metadata(data).message_ids : null;
    if (Array.isArray(deliveredIds)) for (const messageId of deliveredIds) {
      if (Number.isSafeInteger(messageId)) ids.add(messageId);
    }
  }
  const headers = new Map(), messages = new Map(), inputEvents = new Map(), receipts = new Map();
  const allIds = [...ids];
  // Hostile metadata can contain many receipt identities. Bound SQLite parameter counts too.
  for (let start = 0; start < allIds.length; start += 500) {
    const part = allIds.slice(start, start + 500);
    for (const row of store.all(`SELECT id,sender_id,consumed,length(CAST(body AS BLOB)) AS bytes
      FROM messages WHERE task_id=? AND id IN (${holes(part)})`, taskId, ...part)) headers.set(row.id, row);
    const found = store.all(`SELECT r.message_id,e.type,e.created_at FROM (
      SELECT j.value AS message_id,min(e.id) AS first_id FROM events e,json_each(${SAFE_JSON},'$.message_ids') j
      WHERE e.task_id=? AND (e.type='invocation.inputs_delivered' OR (e.type='invocation.started'
        AND json_extract(${SAFE_JSON},'$.input_delivery_tracked') IS NULL))
        AND json_type(${SAFE_JSON},'$.message_ids')='array' AND j.value IN (${holes(part)}) GROUP BY j.value
      ) r JOIN events e ON e.id=r.first_id`, taskId, ...part);
    for (const row of found) receipts.set(row.message_id, row);
  }
  const getDelivery = messageId => {
    const receipt = receipts.get(messageId), message = headers.get(messageId);
    if (receipt?.type === 'invocation.inputs_delivered') return { status: 'delivered', at: segment(receipt.created_at, 0, 128).text };
    return { status: receipt || !message || message.consumed === 1 ? 'unknown' : 'pending', at: null };
  };
  const linkedHeaders = [...linkedIds].map(messageId => headers.get(messageId)).filter(Boolean);
  for (const group of chunks(linkedHeaders)) {
    const readable = group.filter(row => row.bytes <= ROW_BYTES).map(row => row.id);
    const raw = new Map(readable.length ? store.all(`${MESSAGE_SELECT} WHERE m.task_id=? AND m.id IN (${holes(readable)})`, taskId, ...readable)
      .map(row => [row.id, row]) : []);
    for (const header of group) {
      const row = raw.get(header.id), error = header.bytes > ROW_BYTES ? 'record_exceeds_16_mib' : typeof row?.body !== 'string' ? 'invalid_message_body' : null;
      if (error) { messages.set(header.id, { row: { ...header, task_id: taskId }, texts: [], text: '', error, limitations: [] }); continue; }
      const preview = segment(row.body);
      messages.set(row.id, { row: { ...row, body: preview.text }, texts: [{ key: 'body', text: preview.text }], text: preview.text, preview, limitations: [] });
    }
  }
  const evidenceIds = linkedHeaders.map(row => row.id);
  if (evidenceIds.length) {
    const evidence = store.all(`SELECT e.id,e.type,e.created_at,r.message_id,
      json_type(${SAFE_JSON},'$.sender') AS sender_type,
      CASE WHEN json_type(${SAFE_JSON},'$.sender') IN ('null','integer') THEN json_extract(${SAFE_JSON},'$.sender') END AS sender,
      json_type(${SAFE_JSON},'$.append_number') AS append_type,
      CASE WHEN json_type(${SAFE_JSON},'$.append_number')='text' THEN substr(json_extract(${SAFE_JSON},'$.append_number'),1,2049) END AS append_number
      FROM (SELECT json_extract(${SAFE_JSON},'$.message_id') AS message_id,min(e.id) AS first_id
        FROM events e WHERE e.task_id=? AND e.type='message' AND json_type(${SAFE_JSON},'$.message_id')='integer'
          AND json_extract(${SAFE_JSON},'$.message_id') IN (${holes(evidenceIds)}) GROUP BY message_id
      ) r JOIN events e ON e.id=r.first_id`, taskId, ...evidenceIds);
    for (const row of evidence) inputEvents.set(row.message_id, inputEvidence(row, taskId, headers.get(row.message_id), getDelivery));
  }
  return { messages, inputEvents, delivery: getDelivery };
}

/** A first-screen history window uses exactly the reading projection, with batched source/evidence queries. */
export function projectHistoryRows(store, taskId, headers, maxBytes = 900000) {
  const result = []; let bytes = 2;
  for (const group of chunks(headers)) {
    const readable = group.filter(row => row.bytes <= ROW_BYTES).map(row => row.id);
    const raw = new Map(readable.length ? store.all(`SELECT id,data FROM events WHERE task_id=? AND id IN (${holes(readable)})`, taskId, ...readable)
      .map(row => [row.id, row.data]) : []);
    const rows = group.map(header => ({ ...header, data: raw.get(header.id) }));
    // Decode only valid source records; malformed/oversized records are projected as explicit errors below.
    const decoded = rows.flatMap(row => {
      if (row.bytes > ROW_BYTES) return [];
      try { const data = JSON.parse(row.data); return isPlainObject(data) ? [{ ...row, data }] : []; } catch { return []; }
    });
    const context = historyContext(store, taskId, decoded), decodedById = new Map(decoded.map(row => [row.id, row]));
    for (const row of rows) {
      const item = projection(store, taskId, 'event', eventLoad(store, taskId, decodedById.get(row.id) ?? row, context), context);
      const size = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (bytes + size > maxBytes) return result;
      result.push(item); bytes += size;
    }
  }
  return result;
}

/** Identical bounded projection for legacy first-screen history and remote reading pages. */
export function projectHistoryEvent(store, taskId, eventId) {
  return projection(store, taskId, 'event', load(store, taskId, 'event', eventId));
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
        const match = loaded.error || matches(kind === 'event' ? loaded.row.data : {}, loaded.texts, needle, loaded.row.type || '');
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
