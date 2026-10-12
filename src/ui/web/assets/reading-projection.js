// Shared by the Store read projection and the browser's legacy history adapter.
// Private configuration is never part of timeline metadata or metadata search.
export const PRIVATE_EVENT_KEYS = new Set(['retry_profile', 'hooks', 'auto_merge', 'management']);
export const READING_CHARS = 24000;
export const EVENT_TEXT_KEYS = ['body', 'result', 'answer'];
const IDENTITY_KEYS = ['message_id','run_id','sender','source_task_id','target_task_id','notice_id','notice_kind',
  'answer_source','append_number','dismiss','signal','key','worker_number','input_delivery_tracked','goal','message_ids'];
export function readingSegment(text, offset = 0, max = READING_CHARS) {
  let end = Math.min(text.length, offset + max);
  if (end > offset && end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end])) end--;
  return { text: text.slice(offset, end), offset, next_offset: end, has_more: end < text.length, total_chars: text.length };
}
export function eventMetadata(data, limitations = []) {
  let nodes = 0, chars = 0, limited = false;
  const visit = (value, depth = 0) => {
    if (++nodes > 200 || depth > 8) { limited = true; return null; }
    if (typeof value === 'string') {
      const out = readingSegment(value, 0, Math.max(0, Math.min(2048, 8192 - chars))).text;
      chars += out.length; if (out.length !== value.length) limited = true;
      return out;
    }
    if (value === null || typeof value !== 'object') return value;
    const out = Array.isArray(value) ? [] : {};
    for (const [key, child] of Object.entries(value)) {
      if (PRIVATE_EVENT_KEYS.has(key)) { limited = true; continue; }
      if (nodes >= 200 || key.length > 200) { limited = true; break; }
      Object.defineProperty(out, key, { value: visit(child, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  const out = {};
  const keys = [...IDENTITY_KEYS.filter(key => Object.hasOwn(data, key)), ...Object.keys(data).filter(key => !IDENTITY_KEYS.includes(key))];
  for (const key of keys) {
    if (EVENT_TEXT_KEYS.includes(key)) continue;
    if (PRIVATE_EVENT_KEYS.has(key)) { limited = true; continue; }
    if (nodes >= 200 || key.length > 200) { limited = true; break; }
    Object.defineProperty(out, key, { value: visit(data[key]), enumerable: true, writable: true, configurable: true });
  }
  if (limited && !limitations.includes('event_metadata_bounded')) limitations.push('event_metadata_bounded');
  return out;
}
// Body/result/answer are authoritative user/Worker text, not configuration metadata.
export function eventTextFields(data) {
  return EVENT_TEXT_KEYS.filter(key => Object.hasOwn(data, key) && data[key] != null).map(key => ({ key,
    text: typeof data[key] === 'string' ? data[key] : JSON.stringify(data[key]) }));
}
/** Normalize legacy first-screen history without treating its bounded window as complete. */
export function previewHistoryEvent(event) {
  const limitations = [...(event.limitations || [])], data = event.data || {}, out = eventMetadata(data, limitations);
  const texts = eventTextFields(data);
  let remaining = READING_CHARS;
  for (const field of texts) {
    out[field.key] = readingSegment(field.text, 0, remaining).text;
    remaining = Math.max(0, remaining - out[field.key].length - 1);
  }
  const fallback = texts.length ? null : event.reading_text ?? JSON.stringify(data, (key, value) => PRIVATE_EVENT_KEYS.has(key) ? undefined : value);
  const full = texts.length ? texts.map(field => field.text).join('\n') : fallback, total = event.total_chars ?? full.length;
  const message = event.message && { ...event.message, body: readingSegment(String(event.message.body ?? '')).text,
    text_truncated: Boolean(event.message.text_truncated || String(event.message.body ?? '').length > READING_CHARS),
    total_chars: event.message.total_chars ?? String(event.message.body ?? '').length };
  return { ...event, data: out, ...(fallback != null ? { reading_text: readingSegment(fallback).text } : {}), ...(message ? { message } : {}),
    text_truncated: Boolean(event.text_truncated || total > READING_CHARS), total_chars: total, limitations };
}
