import { check, id } from '../../core/types.js';

export const MESSAGE_SELECT = `SELECT m.*,
  (SELECT t.worker_number FROM tasks t WHERE t.id=m.task_id) AS task_worker_number,
  (SELECT s.worker_number FROM tasks s WHERE s.id=m.sender_id) AS sender_worker_number
  FROM messages m`;

/** 收件箱。 */
export const messages = {
  message(taskId, body, sender = null, hold = null) { return Number(this.run('INSERT INTO messages(task_id,sender_id,body,delivery_hold) VALUES (?,?,?,?)', taskId, sender, body, hold).lastInsertRowid); },
  /** Explicit user worker.message only; NULL sender alone does not establish user provenance. */
  appendMessage(taskId, body, hold = null) {
    // Immediate locking also serializes independent Store connections before reading the Input.
    return this.db.transaction(() => {
      const { input_id: inputId } = this.task(taskId);
      if (inputId === null) return this.message(taskId, body, null, hold);
      const key = `input_append_high:${id(inputId)}`;
      const high = Number(this.get('SELECT value FROM meta WHERE key=?', key)?.value ?? 0);
      check(Number.isSafeInteger(high) && high >= 0 && high < Number.MAX_SAFE_INTEGER, 'Input append number limit reached');
      const next = high + 1;
      this.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(next));
      return Number(this.run('INSERT INTO messages(task_id,body,delivery_hold,append_number) VALUES (?,?,?,?)',
        taskId, body, hold, `A${inputId}-${next}`).lastInsertRowid);
    }).immediate();
  },
  /** Keyed child→parent and system→parent signals are durable; NULL senders also need exact idempotence. */
  signal(taskId, senderId, type, key, body) {
    // SQLite UNIQUE does not deduplicate NULL. Lock before the lookup across independent connections.
    return this.db.transaction(() => {
      let row = this.get('SELECT * FROM messages WHERE task_id=? AND sender_id IS ? AND signal_key=?', taskId, senderId, key);
      let inserted = false;
      if (!row) {
        inserted = this.run(`INSERT OR IGNORE INTO messages(task_id,sender_id,body,signal_type,signal_key)
          VALUES (?,?,?,?,?)`, taskId, senderId, body, type, key).changes === 1;
        row = this.get('SELECT * FROM messages WHERE task_id=? AND sender_id IS ? AND signal_key=?', taskId, senderId, key);
      }
      if (!row || row.signal_type !== type || row.body !== body) throw new Error(`signal key ${key} already has different content`);
      return { id: row.id, inserted };
    }).immediate();
  },
  unread(taskId) { return this.all(`${MESSAGE_SELECT} WHERE task_id=? AND consumed=0 ORDER BY id`, taskId); },
  /**
   * Bounded inbox read for one invocation. Row metadata is read without bodies so the
   * delivered batch, not the whole mailbox, defines the startup prompt size; complete
   * records stay in SQLite until a later batch delivers them.
   *
   * User messages (`sender_id IS NULL`) are delivered first in id order and are never
   * deferred by the byte budget, because they are the reason the invocation was woken.
   * Remaining budget then fills older-to-newer runtime signals (FIFO). A message larger
   * than the whole budget is still delivered whole — never truncated or summarized — so
   * batching always makes progress and the next call starts with that record.
   * A released buffered wave instead uses strict FIFO across senders; frozen/routing
   * records remain outside the Agent batch (but stay in the full unread safety view).
   */
  unreadPage(taskId, { limit = 50, bytes = 262144 } = {}) {
    const taskIdValue = id(taskId);
    check(Number.isInteger(limit) && limit >= 1 && limit <= 1000, 'invalid message page limit');
    check(Number.isInteger(bytes) && bytes >= 1, 'invalid message page byte budget');
    // CAST AS BLOB counts UTF-8 bytes, not SQLite characters, so the budget matches the JSON payload.
    const pending = this.all(`SELECT id, sender_id, delivery_hold, length(CAST(body AS BLOB)) AS size FROM messages
      WHERE task_id=? AND consumed=0 AND (delivery_hold IS NULL OR delivery_hold='released') ORDER BY id`, taskIdValue);
    const chosen = []; let used = 0;
    const take = row => { chosen.push(row.id); used += row.size; };
    if (pending.some(row => row.delivery_hold === 'released')) {
      // A buffered wave keeps strict FIFO across user/Agent senders and batches.
      // Do not skip a larger record and let a later requirement overtake it.
      for (const row of pending) {
        if (chosen.length >= limit || (chosen.length > 0 && used + row.size > bytes)) break;
        take(row);
      }
    } else {
      for (const row of pending) {
        if (chosen.length >= limit) break;
        if (row.sender_id !== null) continue;
        take(row);
      }
      const already = new Set(chosen);
      for (const row of pending) {
        if (chosen.length >= limit) break;
        if (row.sender_id === null || already.has(row.id)) continue;
        if (chosen.length > 0 && used + row.size > bytes) continue;
        take(row);
      }
    }
    // Preserve delivery order (user messages first, then FIFO); do not re-sort by id.
    const rows = chosen.length
      ? this.all(`${MESSAGE_SELECT} WHERE id IN (${chosen.map(() => '?').join(',')})`, ...chosen) : [];
    const byId = new Map(rows.map(row => [row.id, row]));
    const messages = chosen.map(rowId => byId.get(rowId)).filter(Boolean);
    const delivered = new Set(messages.map(row => row.id));
    const omitted = pending.filter(row => !delivered.has(row.id));
    const sizes = new Map(pending.map(row => [row.id, row.size]));
    let deliveredBytes = 0, oversize = 0;
    for (const row of messages) {
      const size = sizes.get(row.id) ?? Buffer.byteLength(row.body);
      deliveredBytes += size;
      if (size > bytes) { row.oversize = true; oversize += 1; }
    }
    // Compare against the strict id-ascending prefix: a delivered user message that jumps
    // ahead of an older runtime signal is a real reorder and must be reported as one.
    const strictPrefix = pending.slice(0, messages.length).map(row => row.id);
    return { messages, has_more: omitted.length > 0, pending: omitted.length,
      bytes: deliveredBytes, truncated_bytes: omitted.reduce((sum, row) => sum + row.size, 0),
      reordered: messages.some((row, index) => row.id !== strictPrefix[index]), oversize };
  },
};
