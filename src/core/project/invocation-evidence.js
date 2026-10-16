// Exact same-inbox evidence only. Message bodies and temporal adjacency are not provenance.
// The default delivered batch is <=50; retain the same explicit bound if callers grow it.
export function invocationInputSources(store, taskId, messages) {
  return messages.slice(0, 50).map(message => {
    const row = store.get(`SELECT m.id,m.sender_id,m.signal_type,m.signal_key,s.worker_number AS sender_worker_number
      FROM messages m LEFT JOIN tasks s ON s.id=m.sender_id WHERE m.task_id=? AND m.id=?`, taskId, message.id);
    const out = { message_id: message.id, source: 'unknown', sender_id: row?.sender_id ?? null,
      sender_worker_number: row?.sender_worker_number ?? null, notice_id: null, notice_kind: null };
    if (!row) return out;
    const json = "CASE WHEN json_valid(e.data) THEN e.data ELSE '{}' END";
    const evidence = store.all(`SELECT e.id,e.type,json_extract(${json},'$.sender') AS sender,
      json_extract(${json},'$.user_append') AS user_append,json_extract(${json},'$.source_task_id') AS source_task_id,
      json_extract(${json},'$.signal') AS signal,json_extract(${json},'$.key') AS signal_key,
      json_extract(${json},'$.child') AS child,json_extract(${json},'$.answer_source') AS answer_source,
      n.id AS notice_id,n.kind AS notice_kind
      FROM events e LEFT JOIN notices n ON n.id=json_extract(${json},'$.notice_id') AND n.task_id=e.task_id
      WHERE e.task_id=? AND e.type IN ('message','notice.answered','task.signal','child.completed')
        AND json_type(${json},'$.message_id')='integer' AND json_extract(${json},'$.message_id')=? ORDER BY e.id`, taskId, row.id);
    for (const event of evidence) {
      let source = null;
      if (event.type === 'notice.answered' && event.notice_id !== null && row.sender_id === null
        && ['user', 'lush'].includes(event.answer_source)) {
        source = event.answer_source === 'user' ? 'user' : 'system';
        out.notice_id = event.notice_id; out.notice_kind = event.notice_kind;
      } else if (event.type === 'message' && event.sender === row.sender_id) {
        if (row.sender_id !== null) source = 'worker';
        else if (event.user_append === 1) source = 'user';
      } else if (event.type === 'task.signal' && row.signal_type && event.signal === row.signal_type
        && event.signal_key === row.signal_key && event.source_task_id === row.sender_id) source = 'system';
      else if (event.type === 'child.completed' && row.sender_id !== null && event.child === row.sender_id) source = 'system';
      if (source) { out.source = source; out.evidence_event_id = event.id; break; }
    }
    return out;
  });
}
