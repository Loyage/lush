/** Read-only legacy detection. Never creates, migrates or edits Runner facts. */
export const executionRetired = {
  executionRetired(workerId) {
    const table = this.get("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='runner_bindings'");
    return Boolean(table && this.get('SELECT 1 AS found FROM runner_bindings WHERE worker_id=?', workerId));
  },
  retiredWorkerIds() {
    const table = this.get("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='runner_bindings'");
    return table ? this.all('SELECT worker_id FROM runner_bindings').map(row => row.worker_id) : [];
  },
};
