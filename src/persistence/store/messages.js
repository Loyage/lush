/** 收件箱。 */
export const messages = {
  message(taskId, body, sender = null) { return Number(this.run('INSERT INTO messages(task_id,sender_id,body) VALUES (?,?,?)', taskId, sender, body).lastInsertRowid); },
  /** A keyed child→parent signal is durable and idempotent; ordinary messages keep NULL signal fields. */
  signal(taskId, senderId, type, key, body) {
    const inserted = this.run(`INSERT OR IGNORE INTO messages(task_id,sender_id,body,signal_type,signal_key)
      VALUES (?,?,?,?,?)`, taskId, senderId, body, type, key).changes === 1;
    const row = this.get('SELECT * FROM messages WHERE task_id=? AND sender_id=? AND signal_key=?', taskId, senderId, key);
    if (!row || row.signal_type !== type || row.body !== body) throw new Error(`signal key ${key} already has different content`);
    return { id: row.id, inserted };
  },
  unread(taskId) { return this.all('SELECT * FROM messages WHERE task_id=? AND consumed=0 ORDER BY id', taskId); },
};
