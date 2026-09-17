/**
 * The conversation record of one process: agent calls and the messages inside
 * them.
 *
 * An `agent_calls` row is the durable record of one invocation (prompt,
 * status, output, error, window); `messages` hangs off it in order. The
 * provider-facing view is `conversation`, which replays only what a provider
 * may safely see again. Every function operates on the `Repository` passed in;
 * the class in `repository.js` is the only caller.
 */
import { jsonDump, now } from '../core/types.js';

/**
 * Open a call: a `running` row plus the user message, in one transaction, so a
 * provider can never see a prompt without its call.
 */
export function beginCall(repository, pid, prompt) {
  let callId = 0;
  repository.database.transaction(() => {
    callId = repository.db.run(
      "INSERT INTO agent_calls(pid,prompt,status,started_at) VALUES(?,?,'running',?)",
      [pid, prompt, now()],
    ).lastInsertRowid;
    addMessage(repository, pid, callId, { role: 'user', content: prompt });
  });
  return callId;
}

export function addMessage(repository, pid, callId, body) {
  repository.db.run('INSERT INTO messages(pid,call_id,body,created_at) VALUES(?,?,?,?)',
    [pid, callId, jsonDump(body), now()]);
}

/** Close a call row. Only a `running` row may change, so a late report is a no-op. */
export function finishCall(repository, callId, status, { output, error } = {}) {
  repository.db.run("UPDATE agent_calls SET status=?,output=?,error=?,finished_at=? WHERE id=? AND status='running'",
    [status, output ?? null, error ?? null, now(), callId]);
}

/** The most recent calls of a process, newest first. */
export function calls(repository, pid, limit = 20) {
  return repository.db.query('SELECT * FROM agent_calls WHERE pid=? ORDER BY id DESC LIMIT ?').all(pid, limit);
}

/** One call row by id, whenever it happened (agent history is not paginated away). */
export function callById(repository, callId) {
  return repository.db.query('SELECT * FROM agent_calls WHERE id=?').get(callId) ?? null;
}

/**
 * Replay complete calls verbatim; failed calls as plain audit dialogue.
 * Dangling assistant.tool_calls must never be sent back to a provider.
 */
export function conversation(repository, pid, currentCall) {
  const calls_ = repository.db.query('SELECT * FROM agent_calls WHERE pid=? ORDER BY id').all(pid);
  const result = [];
  for (const call of calls_) {
    if (call.status === 'succeeded' || call.id === currentCall) {
      const rows = repository.db.query('SELECT body FROM messages WHERE call_id=? ORDER BY id').all(call.id);
      result.push(...rows.map((row) => JSON.parse(row.body)));
    } else {
      result.push(
        { role: 'user', content: call.prompt },
        {
          role: 'assistant',
          content: `[Lush audit: invocation ${call.id} ${call.status}; `
            + 'tool effects may have committed. Inspect process state/events before retrying.]',
        },
      );
    }
  }
  return result;
}
