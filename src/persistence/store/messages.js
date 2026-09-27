/** 收件箱。 */
export const messages = {
  message(apId, body, sender = null) { return Number(this.run('INSERT INTO messages(ap_id,sender_id,body) VALUES (?,?,?)', apId, sender, body).lastInsertRowid); },
  /** A keyed child→parent signal is durable and idempotent; ordinary messages keep NULL signal fields. */
  signal(apId, senderId, type, key, body) {
    const inserted = this.run(`INSERT OR IGNORE INTO messages(ap_id,sender_id,body,signal_type,signal_key)
      VALUES (?,?,?,?,?)`, apId, senderId, body, type, key).changes === 1;
    const row = this.get('SELECT * FROM messages WHERE ap_id=? AND sender_id=? AND signal_key=?', apId, senderId, key);
    if (!row || row.signal_type !== type || row.body !== body) throw new Error(`signal key ${key} already has different content`);
    return { id: row.id, inserted };
  },
  unread(apId) { return this.all('SELECT * FROM messages WHERE ap_id=? AND consumed=0 ORDER BY id', apId); },
};
