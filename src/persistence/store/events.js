import { bounded } from '../../core/types.js';

/** 审计事件。 */
export const events = {
  event(taskId, type, data) { return Number(this.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', taskId, type, JSON.stringify(data)).lastInsertRowid); },
  history(taskId, after = 0) {
    return bounded(this.all('SELECT * FROM events WHERE task_id=? AND id>? ORDER BY id LIMIT 100', taskId, after).map(row => ({ ...row, data: JSON.parse(row.data) })), 900000);
  },
  /** Newest-first cursor page, returned chronologically for direct timeline rendering. */
  historyPage(taskId, before = null, limit = 100) {
    const rows = this.all(`SELECT * FROM events WHERE task_id=?${before === null ? '' : ' AND id<?'} ORDER BY id DESC LIMIT ?`,
      ...[taskId, ...(before === null ? [] : [before]), limit + 1]);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse().map(row => ({ ...row, data: JSON.parse(row.data) }));
    return { events: bounded(page, 900000), cursor: page[0]?.id ?? before, has_more: hasMore, limit, truncated: hasMore };
  },
};
