import { bounded } from '../../core/types.js';
import { MESSAGE_SELECT } from './messages.js';

/**
 * 事件里只存 message_id 时，把被引用的消息正文一并带上：时间线才看得到 Agent 之间说了什么。
 * `data.body` 已内联正文的事件（如 message / notice.answered）不重复挂；消息被删除或没有引用时为原样。
 */
function withMessages(store, rows) {
  const ids = [...new Set(rows.filter(row => !('body' in (row.data || {})) && Number.isSafeInteger(row.data?.message_id))
    .map(row => row.data.message_id))];
  if (!ids.length) return rows;
  const byId = new Map(store.all(`${MESSAGE_SELECT} WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
    .map(row => [row.id, row]));
  return rows.map(row => (!('body' in (row.data || {})) && byId.has(row.data?.message_id))
    ? { ...row, message: byId.get(row.data.message_id) } : row);
}

/** Join exact message identities across the entire history, not just this cursor page. */
function withInputDelivery(store, rows) {
  const followups = rows.filter(row => row.type === 'message' && row.data?.sender === null);
  const deliveryEvents = rows.filter(row => row.type === 'invocation.inputs_delivered');
  const ids = [...new Set([...followups.map(row => row.data.message_id),
    ...deliveryEvents.flatMap(row => row.data?.message_ids || [])].filter(Number.isSafeInteger))];
  if (!ids.length) return rows.map(row => followups.includes(row)
    ? { ...row, input_delivery: { status: 'unknown', at: null } } : row);
  const holes = ids.map(() => '?').join(',');
  const taskId = rows[0].task_id;
  const receipts = store.all(`SELECT j.value AS message_id,
      min(CASE WHEN e.type='invocation.inputs_delivered' THEN e.id END) AS receipt_id,
      min(CASE WHEN e.type='invocation.started' THEN e.id END) AS legacy_id
    FROM events e, json_each(e.data, '$.message_ids') j
    WHERE e.task_id=? AND (e.type='invocation.inputs_delivered'
      OR (e.type='invocation.started' AND json_extract(e.data,'$.input_delivery_tracked') IS NULL))
      AND j.value IN (${holes}) GROUP BY j.value`, taskId, ...ids);
  const byId = new Map(receipts.map(row => [row.message_id, row]));
  const receiptIds = [...new Set(receipts.map(row => row.receipt_id).filter(Number.isSafeInteger))];
  const times = new Map(receiptIds.length ? store.all(`SELECT id,created_at FROM events
    WHERE id IN (${receiptIds.map(() => '?').join(',')})`, ...receiptIds).map(row => [row.id, row.created_at]) : []);
  const consumed = new Map(store.all(`SELECT id,consumed FROM messages WHERE task_id=? AND id IN (${holes})`, taskId, ...ids)
    .map(row => [row.id, row.consumed]));
  const delivery = messageId => {
    const receipt = byId.get(messageId), seen = consumed.get(messageId);
    const legacy = receipt?.legacy_id != null && (receipt.receipt_id == null || receipt.legacy_id < receipt.receipt_id);
    const at = legacy ? null : times.get(receipt?.receipt_id) ?? null;
    return { status: at ? 'delivered' : legacy || seen === 1 || seen === undefined ? 'unknown' : 'pending', at };
  };
  return rows.map(row => {
    if (followups.includes(row)) return { ...row, input_delivery: delivery(row.data.message_id) };
    if (deliveryEvents.includes(row)) return { ...row, input_deliveries: (row.data.message_ids || [])
      .filter(Number.isSafeInteger).map(messageId => ({ message_id: messageId, ...delivery(messageId) })) };
    return row;
  });
}

/** 审计事件。 */
export const events = {
  event(taskId, type, data) { return Number(this.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', taskId, type, JSON.stringify(data)).lastInsertRowid); },
  goalInputDelivery(taskId) {
    const receipt = this.get("SELECT id,created_at FROM events WHERE task_id=? AND type='invocation.inputs_delivered' ORDER BY id LIMIT 1", taskId);
    const legacy = this.get(`SELECT id FROM events WHERE task_id=? AND type='invocation.started'
      AND json_extract(data,'$.input_delivery_tracked') IS NULL ORDER BY id LIMIT 1`, taskId);
    if (legacy && (!receipt || legacy.id < receipt.id)) return { status: 'unknown', at: null };
    return receipt ? { status: 'delivered', at: receipt.created_at } : { status: 'pending', at: null };
  },
  history(taskId, after = 0) {
    const rows = this.all('SELECT * FROM events WHERE task_id=? AND id>? ORDER BY id LIMIT 100', taskId, after).map(row => ({ ...row, data: JSON.parse(row.data) }));
    return bounded(withInputDelivery(this, withMessages(this, rows)), 900000);
  },
  /** Newest-first cursor page, returned chronologically for direct timeline rendering. */
  historyPage(taskId, before = null, limit = 100) {
    const rows = this.all(`SELECT * FROM events WHERE task_id=?${before === null ? '' : ' AND id<?'} ORDER BY id DESC LIMIT ?`,
      ...[taskId, ...(before === null ? [] : [before]), limit + 1]);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse().map(row => ({ ...row, data: JSON.parse(row.data) }));
    return { events: bounded(withInputDelivery(this, withMessages(this, page)), 900000), cursor: page[0]?.id ?? before, has_more: hasMore, limit, truncated: hasMore };
  },
};
