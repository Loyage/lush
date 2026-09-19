/** 收件箱。 */
export const messages = {
  message(taskId, body, sender = null) { this.run('INSERT INTO messages(task_id,sender_id,body) VALUES (?,?,?)', taskId, sender, body); },
  unread(taskId) { return this.all('SELECT * FROM messages WHERE task_id=? AND consumed=0 ORDER BY id', taskId); },
};
