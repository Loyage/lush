import { bounded } from '../../core/types.js';

/**
 * 事件里只存 message_id 时，把被引用的消息正文一并带上：时间线才看得到 Agent 之间说了什么。
 * `data.body` 已内联正文的事件（如 message / notice.answered）不重复挂；消息被删除或没有引用时为原样。
 */
function withMessages(store, rows) {
  const ids = [...new Set(rows.filter(row => !('body' in (row.data || {})) && Number.isSafeInteger(row.data?.message_id))
    .map(row => row.data.message_id))];
  if (!ids.length) return rows;
  const byId = new Map(store.all(`SELECT id,task_id,sender_id,signal_type,body FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
    .map(row => [row.id, row]));
  return rows.map(row => (!('body' in (row.data || {})) && byId.has(row.data?.message_id))
    ? { ...row, message: byId.get(row.data.message_id) } : row);
}

/** 审计事件。 */
export const events = {
  event(taskId, type, data) { return Number(this.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', taskId, type, JSON.stringify(data)).lastInsertRowid); },
  history(taskId, after = 0) {
    const rows = this.all('SELECT * FROM events WHERE task_id=? AND id>? ORDER BY id LIMIT 100', taskId, after).map(row => ({ ...row, data: JSON.parse(row.data) }));
    return bounded(withMessages(this, rows), 900000);
  },
  /** Newest-first cursor page, returned chronologically for direct timeline rendering. */
  historyPage(taskId, before = null, limit = 100) {
    const rows = this.all(`SELECT * FROM events WHERE task_id=?${before === null ? '' : ' AND id<?'} ORDER BY id DESC LIMIT ?`,
      ...[taskId, ...(before === null ? [] : [before]), limit + 1]);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse().map(row => ({ ...row, data: JSON.parse(row.data) }));
    return { events: bounded(withMessages(this, page), 900000), cursor: page[0]?.id ?? before, has_more: hasMore, limit, truncated: hasMore };
  },
};
