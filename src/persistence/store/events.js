import { projectHistoryRows } from './reading.js';

// Select only headers first. Full source records are fetched in byte-bounded batches by the shared projector.
const HISTORY_HEADER = 'SELECT id,task_id,type,created_at,length(CAST(data AS BLOB)) AS bytes FROM events';

/** 审计事件；历史正文与 reading-page 共用安全、可续读投影，不改写存储事实。 */
export const events = {
  event(taskId, type, data) { return Number(this.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', taskId, type, JSON.stringify(data)).lastInsertRowid); },
  goalInputDelivery(taskId) {
    const receipt = this.get("SELECT id,created_at FROM events WHERE task_id=? AND type='invocation.inputs_delivered' ORDER BY id LIMIT 1", taskId);
    const legacy = this.get(`SELECT id FROM events WHERE task_id=? AND type='invocation.started'
      AND json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END,'$.input_delivery_tracked') IS NULL ORDER BY id LIMIT 1`, taskId);
    if (legacy && (!receipt || legacy.id < receipt.id)) return { status: 'unknown', at: null };
    return receipt ? { status: 'delivered', at: receipt.created_at } : { status: 'pending', at: null };
  },
  history(taskId, after = 0) {
    return this.transaction(() => {
      const headers = this.all(`${HISTORY_HEADER} WHERE task_id=? AND id>? ORDER BY id LIMIT 100`, taskId, after);
      return projectHistoryRows(this, taskId, headers);
    });
  },
  /** Newest-first cursor page, returned chronologically. Byte truncation retains the cursor of the last returned row. */
  historyPage(taskId, before = null, limit = 100) {
    return this.transaction(() => {
      const headers = this.all(`${HISTORY_HEADER} WHERE task_id=?${before === null ? '' : ' AND id<?'} ORDER BY id DESC LIMIT ?`,
        ...[taskId, ...(before === null ? [] : [before]), limit + 1]);
      const page = projectHistoryRows(this, taskId, headers.slice(0, limit)).reverse();
      const hasMore = headers.length > page.length;
      return { events: page, cursor: page[0]?.id ?? before, has_more: hasMore, limit, truncated: hasMore };
    });
  },
};
