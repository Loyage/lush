import { bounded } from '../../core/types.js';

/** 审计事件。 */
export const events = {
  event(taskId, type, data) { this.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', taskId, type, JSON.stringify(data)); },
  history(taskId, after = 0) {
    return bounded(this.all('SELECT * FROM events WHERE task_id=? AND id>? ORDER BY id LIMIT 100', taskId, after).map(row => ({ ...row, data: JSON.parse(row.data) })), 900000);
  },
};
