/**
 * The conversation record of one task: the agent calls made for it and the
 * messages inside them.
 *
 * An `agent_calls` row is the durable record of one invocation (prompt, status,
 * output, error, window); `messages` hangs off it in order. Both carry the
 * `task_id` they belong to and the `sid` they ran on. The provider-facing view
 * is `conversation`, which replays only what a provider may safely see again.
 * Every function operates on the `Repository` passed in; the class in
 * `repository.js` is the only caller.
 */
import { jsonDump, now } from '../core/types.js';

/**
 * Open a call: a `running` row plus the user message, in one transaction, so a
 * provider can never see a prompt without its call.
 */
export function beginCall(repository, sid, taskId, prompt) {
  let callId = 0;
  repository.database.transaction(() => {
    callId = repository.db.run(
      "INSERT INTO agent_calls(sid,task_id,prompt,status,started_at) VALUES(?,?,?,'running',?)",
      [sid, taskId, prompt, now()],
    ).lastInsertRowid;
    addMessage(repository, sid, taskId, callId, { role: 'user', content: prompt });
  });
  return callId;
}

export function addMessage(repository, sid, taskId, callId, body) {
  repository.db.run('INSERT INTO messages(sid,task_id,call_id,body,created_at) VALUES(?,?,?,?,?)',
    [sid, taskId, callId, jsonDump(body), now()]);
}

/** Close a call row. Only a `running` row may change, so a late report is a no-op. */
export function finishCall(repository, callId, status, { output, error } = {}) {
  repository.db.run("UPDATE agent_calls SET status=?,output=?,error=?,finished_at=? WHERE id=? AND status='running'",
    [status, output ?? null, error ?? null, now(), callId]);
}

/** The most recent calls of a service, newest first (read model). */
export function calls(repository, sid, limit = 20) {
  return repository.db.query('SELECT * FROM agent_calls WHERE sid=? ORDER BY id DESC LIMIT ?').all(sid, limit);
}

/** The most recent calls of one task, newest first (read model). */
export function callsOfTask(repository, taskId, limit = 20) {
  return repository.db.query('SELECT * FROM agent_calls WHERE task_id=? ORDER BY id DESC LIMIT ?')
    .all(taskId, limit);
}

/** One call row by id, whenever it happened (agent history is not paginated away). */
export function callById(repository, callId) {
  return repository.db.query('SELECT * FROM agent_calls WHERE id=?').get(callId) ?? null;
}

/**
 * Replay complete calls verbatim; failed calls as plain audit dialogue.
 * Dangling assistant.tool_calls must never be sent back to a provider. The
 * conversation is task-scoped: another task on the same service is a different
 * piece of work with its own agent.
 */
export function conversation(repository, taskId, currentCall) {
  const calls_ = repository.db.query('SELECT * FROM agent_calls WHERE task_id=? ORDER BY id').all(taskId);
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
            + 'tool effects may have committed. Inspect task state/events before retrying.]',
        },
      );
    }
  }
  return result;
}
