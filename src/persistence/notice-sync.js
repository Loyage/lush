import { check, isPlainObject } from '../core/types.js';
import { NOTICE_SELECT } from './notice-projection.js';

const BUDGET = 900000;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(value) {
  check(typeof value === 'string' && value.length <= 1024 && /^[A-Za-z0-9_-]+$/.test(value), 'invalid Notice synchronization cursor');
  let cursor;
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { /* validate below */ }
  check(isPlainObject(cursor) && Object.keys(cursor).every(key => ['v','epoch','mode','after','ceiling','watermark'].includes(key))
    && cursor.v === 1 && /^[a-f0-9]{32}$/.test(cursor.epoch) && ['snapshot','delta'].includes(cursor.mode)
    && Number.isSafeInteger(cursor.after) && cursor.after >= 0
    && (cursor.mode !== 'snapshot' || (Number.isSafeInteger(cursor.ceiling) && cursor.ceiling >= cursor.after
      && Number.isSafeInteger(cursor.watermark) && cursor.watermark >= 0)), 'invalid Notice synchronization cursor');
  return cursor;
}

/** Read-only, transaction-consistent snapshot + replay. No Hook, wake-up or new Notice writes. */
export function syncNotices(store, project, { cursor = null, limit = 100 } = {}) {
  check(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'limit must be 1..100');
  const requested = cursor === null ? null : decode(cursor);
  return store.transaction(() => {
    const epoch = store.get("SELECT value FROM meta WHERE key='notice_sync_epoch'")?.value;
    check(typeof epoch === 'string' && /^[a-f0-9]{32}$/.test(epoch), 'Notice synchronization metadata unavailable');
    const bounds = store.get('SELECT COALESCE(MIN(seq),0) AS low,COALESCE(MAX(seq),0) AS high FROM notice_sync_changes');
    let state = requested;
    const expired = state && (state.epoch !== epoch || (state.mode === 'delta'
      ? state.after > bounds.high || (bounds.low && state.after < bounds.low - 1)
      : state.watermark > bounds.high || (bounds.low && state.watermark < bounds.low - 1)));
    const reset = !state || Boolean(expired);
    if (reset) state = { v: 1, epoch, mode: 'snapshot', after: 0,
      ceiling: store.get('SELECT COALESCE(MAX(id),0) AS high FROM notices').high, watermark: bounds.high };
    const rows = state.mode === 'snapshot'
      ? store.all(`${NOTICE_SELECT} WHERE n.id>? AND n.id<=? ORDER BY n.id LIMIT ?`, state.after, state.ceiling, limit + 1)
      : store.all('SELECT seq,notice_id,identity,deleted FROM notice_sync_changes WHERE seq>? ORDER BY seq LIMIT ?', state.after, limit + 1);
    const changes = []; let bytes = 0, after = state.after;
    for (const row of rows.slice(0, limit)) {
      const notice = state.mode === 'snapshot' ? row : store.get(`${NOTICE_SELECT} WHERE n.id=?`, row.notice_id);
      const identity = state.mode === 'snapshot' ? row.sync_identity : row.identity;
      check(typeof identity === 'string' && /^[a-f0-9]{32}$/.test(identity), 'Notice synchronization record identity unavailable');
      const deleted = state.mode === 'delta' && (Boolean(row.deleted) || !notice || notice.sync_identity !== identity);
      const change = { id: state.mode === 'snapshot' ? row.id : row.notice_id, identity, deleted,
        ...(!deleted ? { notice } : {}) };
      const size = Buffer.byteLength(JSON.stringify(change));
      if (changes.length && bytes + size > BUDGET) break;
      check(size <= BUDGET, 'Notice record exceeds synchronization byte limit');
      changes.push(change); bytes += size; after = state.mode === 'snapshot' ? row.id : row.seq;
    }
    let has_more = rows.length > changes.length;
    let next = { ...state, after };
    if (state.mode === 'snapshot' && !has_more) {
      // The watermark was captured before the first snapshot page. Mutations while
      // scanning (including deletion below the current ID) must be replayed next.
      next = { v: 1, epoch, mode: 'delta', after: state.watermark };
      has_more = bounds.high > state.watermark;
    }
    return { version: 1, project, epoch, reset, changes, cursor: encode(next), has_more };
  });
}
