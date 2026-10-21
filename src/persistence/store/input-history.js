// SQL projection keeps search/filter/pagination over the whole database, not overview.
// Missing original Tasks intentionally survive the LEFT JOIN.
const taskStatuses = "'queued','running','waiting','awaiting','paused','awaiting_acceptance','completed','failed','cancelled'";
const taskStatus = `CASE WHEN t.status='paused' AND t.calls=0 AND coalesce(t.agent_wakes,0)=0
  AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.task_id=t.id) THEN 'created'
  WHEN t.status IN (${taskStatuses}) THEN t.status ELSE 'unknown' END`;
const booking = "CASE WHEN json_valid(t.reservation) THEN t.reservation ELSE '{}' END";
const safe = column => `CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END`;
const options = safe('d.input_options'), emission = safe('d.emission');
const draftMode = `coalesce(json_extract(${options},'$.mode'),'order')`;
// Conditional views keep receipt drafts even after an order created its original Input.
const conditionalDefinition = `(coalesce(json_array_length(${options},'$.conditions'),0)>0
  OR json_extract(${options},'$.exclusive')=1)`;
const conditionalReceipt = `(d.emission IS NOT NULL AND coalesce(json_array_length(${emission},'$.signals'),0)>0)`;
// A NULL sender, legacy message Event or JSON-looking body is not provenance.
// Require a durable append number or explicit user_append:true; an explicit false
// on the same Message takes precedence, even if conflicting numbering exists.
const eventData = safe('e.data');
const messageEvent = `e.task_id=m.task_id AND e.type='message'
  AND json_type(${eventData},'$.message_id')='integer' AND json_extract(${eventData},'$.message_id')=m.id
  AND json_type(${eventData},'$.sender')='null'`;
const userMessage = `m.sender_id IS NULL AND m.signal_type IS NULL
  AND NOT EXISTS (SELECT 1 FROM events e WHERE ${messageEvent} AND json_type(${eventData},'$.user_append')='false')
  AND (m.append_number IS NOT NULL OR EXISTS (
    SELECT 1 FROM events e WHERE ${messageEvent}
      AND (json_type(${eventData},'$.user_append')='true' OR json_type(${eventData},'$.append_number')='text')
  ))`;
const messageNumber = `coalesce(m.append_number,(SELECT json_extract(${eventData},'$.append_number')
  FROM events e WHERE e.task_id=m.task_id AND e.type='message'
    AND json_type(${eventData},'$.message_id')='integer' AND json_extract(${eventData},'$.message_id')=m.id
    AND json_type(${eventData},'$.sender')='null' AND json_type(${eventData},'$.append_number')='text'
  ORDER BY e.id LIMIT 1))`;
// Only explicit durable identities establish a source link. Multiple receipts are
// ambiguous; never pick one by timestamp, body or row order.
const appendReceipt = `d.input_id IS NULL AND ${draftMode}='append'
  AND json_type(${emission},'$.message_id')='integer' AND json_extract(${emission},'$.message_id')=m.id
  AND json_type(${options},'$.target_id')='integer' AND json_extract(${options},'$.target_id')=m.task_id
  AND (json_type(${emission},'$.worker_id') IS NULL OR
    (json_type(${emission},'$.worker_id')='integer' AND json_extract(${emission},'$.worker_id')=m.task_id))`;
// A manual container's first append is an Input, not a Message. Both the current
// ownership and the exact successful dispatch must prove that exceptional link.
const firstInputData = safe('first_input.data'), dispatchData = safe('dispatch.data');
const appendFirstInputReceipt = `d.input_id=i.id AND ${draftMode}='append' AND t.input_id=i.id
  AND json_extract(${safe('t.creation')},'$.mode') IN ('spawn','fork')
  AND json_type(${options},'$.target_id')='integer' AND json_extract(${options},'$.target_id')=t.id
  AND json_extract(${emission},'$.state')='succeeded'
  AND json_type(${emission},'$.input_id')='integer' AND json_extract(${emission},'$.input_id')=i.id
  AND json_type(${emission},'$.worker_id')='integer' AND json_extract(${emission},'$.worker_id')=t.id
  AND json_type(${emission},'$.dispatch_id')='text' AND length(json_extract(${emission},'$.dispatch_id'))>0
  AND json_type(${emission},'$.message_id') IS NULL AND json_type(${emission},'$.append_number') IS NULL
  AND EXISTS (SELECT 1 FROM events first_input WHERE first_input.task_id=t.id AND first_input.type='task.first_input'
    AND json_type(${firstInputData},'$.input_id')='integer' AND json_extract(${firstInputData},'$.input_id')=i.id
    AND json_extract(${firstInputData},'$.authorized_by')='user')
  AND EXISTS (SELECT 1 FROM events dispatch WHERE dispatch.task_id=d.parent_id AND dispatch.type='input.dispatch_succeeded'
    AND json_type(${dispatchData},'$.draft_id')='integer' AND json_extract(${dispatchData},'$.draft_id')=d.id
    AND json_type(${dispatchData},'$.dispatch_id')='text'
      AND json_extract(${dispatchData},'$.dispatch_id')=json_extract(${emission},'$.dispatch_id')
    AND json_type(${dispatchData},'$.input_id')='integer' AND json_extract(${dispatchData},'$.input_id')=i.id
    AND json_type(${dispatchData},'$.worker_id')='integer' AND json_extract(${dispatchData},'$.worker_id')=t.id
    AND json_type(${dispatchData},'$.message_id') IS NULL AND json_type(${dispatchData},'$.append_number') IS NULL)`;
const sourceDraft = predicate => `(SELECT CASE WHEN count(*)=1 AND min(d.id) BETWEEN 1 AND 9007199254740991
  THEN min(d.id) ELSE NULL END FROM drafts d WHERE ${predicate})`;
const managementReceipt = `${draftMode}='management' AND json_extract(${emission},'$.kind')='management'
  AND json_extract(${emission},'$.state')='succeeded'
  AND json_type(${emission},'$.worker_id')='integer' AND json_extract(${emission},'$.worker_id')=t.id
  AND EXISTS (SELECT 1 FROM events proof WHERE proof.task_id=t.id AND proof.type='management.draft_submitted'
    AND proof.id=json_extract(${emission},'$.receipt_id')
    AND json_extract(${safe('proof.data')},'$.draft_id')=d.id
    AND json_extract(${safe('proof.data')},'$.revision')=d.revision
    AND json_extract(${emission},'$.revision')=d.revision
    AND json_extract(${safe('proof.data')},'$.definition_hash')=json_extract(${emission},'$.definition_hash')
    AND json_extract(${safe('proof.data')},'$.occurrence_id')=json_extract(${emission},'$.occurrence_id'))`;
const unsentDraft = `d.input_id IS NULL AND coalesce(json_extract(${emission},'$.state'),'')!='succeeded'
  AND NOT EXISTS (SELECT 1 FROM messages m WHERE ${appendReceipt} AND ${userMessage})`;
const history = (conditional = undefined, view = 'history') => `WITH source AS (
  SELECT 'input' AS kind,i.id,i.content,i.created_at,t.id AS task_id,t.parent_id,t.worker_number AS task_worker_number,
    (SELECT p.worker_number FROM tasks p WHERE p.id=t.parent_id) AS parent_worker_number,
    coalesce(t.branch,i.anchor_branch) AS branch,${taskStatus} AS status,
    coalesce(t.integration,'none') AS integration,NULL AS revision,${booking} AS booking,
    t.id AS original_task_id,'order' AS mode,NULL AS append_number,
    ${sourceDraft(`(d.input_id=i.id AND ${draftMode}='order' AND t.creation IS NULL) OR (${appendFirstInputReceipt})`)} AS source_draft_id,NULL AS draft_number
  FROM inputs i LEFT JOIN tasks t ON t.id=i.task_id ${conditional || view === 'drafts' ? 'WHERE 0' : ''}
  UNION ALL
  SELECT 'draft',d.id,d.content,d.created_at,NULL,d.parent_id,NULL,p.worker_number,p.branch,
    CASE json_extract(${emission},'$.state')
      WHEN 'waiting_conditions' THEN 'waiting_conditions' WHEN 'queued' THEN 'emitted'
      WHEN 'dispatching' THEN 'emitted' WHEN 'succeeded' THEN 'sent'
      WHEN 'failed' THEN 'emission_failed' WHEN 'unknown' THEN 'unknown_dispatch' ELSE 'draft' END,
    'none',d.revision,'{}',NULL,${draftMode},NULL,NULL,d.draft_number
  FROM drafts d LEFT JOIN tasks p ON p.id=d.parent_id WHERE ${conditional === 'mounted' ? conditionalReceipt
    : conditional === 'configured' ? `(${conditionalDefinition} OR ${conditionalReceipt})`
    : view === 'drafts' ? unsentDraft : view === 'detail' ? 'd.input_id IS NULL' : '0'}
  UNION ALL
  SELECT 'message',m.id,m.body,m.created_at,m.task_id,t.parent_id,t.worker_number,
    (SELECT p.worker_number FROM tasks p WHERE p.id=t.parent_id),t.branch,${taskStatus},
    coalesce(t.integration,'none'),NULL,${booking},t.id,CASE WHEN t.task_kind='management' THEN 'management' ELSE 'append' END,${messageNumber},
    ${sourceDraft(`(${appendReceipt}) OR (${managementReceipt} AND json_extract(${options},'$.target_id')=m.task_id AND json_extract(${emission},'$.message_id')=m.id)`)},NULL
  FROM messages m LEFT JOIN tasks t ON t.id=m.task_id WHERE ${conditional || view === 'drafts' ? '0' : userMessage}
  UNION ALL
  SELECT 'management',t.id,t.goal,t.created_at,t.id,t.parent_id,t.worker_number,
    (SELECT p.worker_number FROM tasks p WHERE p.id=t.parent_id),t.branch,${taskStatus},
    coalesce(t.integration,'none'),NULL,${booking},t.id,'management',NULL,
    ${sourceDraft(`${managementReceipt} AND json_type(${options},'$.target_id')='null' AND json_type(${emission},'$.message_id') IS NULL`)},NULL
  FROM tasks t WHERE ${conditional || view === 'drafts' ? '0' : `t.task_kind='management' AND json_extract(${safe('t.management')},'$.origin')='input'`}
), projected AS (
  SELECT *,CASE
    WHEN json_extract(booking,'$.kind')='merge' AND json_extract(booking,'$.version') IN (1,2)
      AND json_extract(booking,'$.status') IN ('blocked','suspended') THEN 'blocked'
    WHEN json_extract(booking,'$.kind')='merge' AND json_extract(booking,'$.version') IN (1,2)
      AND json_extract(booking,'$.status') IN ('executing','resolving') THEN 'merging'
    WHEN json_extract(booking,'$.kind')='merge' AND json_extract(booking,'$.version') IN (1,2)
      AND json_extract(booking,'$.status') IN ('pending','requested') THEN
        CASE WHEN json_extract(booking,'$.blocked_reason') IS NOT NULL THEN 'blocked'
          WHEN json_extract(booking,'$.status')='pending' THEN 'none' ELSE 'merging' END
    WHEN integration='merging' THEN 'merging'
    WHEN integration IN ('conflict','review') THEN 'blocked'
    WHEN integration='merged' AND NOT EXISTS (
      SELECT 1 FROM events e WHERE e.task_id=original_task_id AND e.type='task.iteration_started'
        AND e.id > coalesce((SELECT max(done.id) FROM events done WHERE done.task_id=original_task_id
          AND done.type IN ('task.merge_integrated','child.integrated','order.integrated','say.integrated')),0)
    ) THEN 'merged'
    WHEN integration='merged' AND json_extract(booking,'$.kind')='merge'
      AND json_extract(booking,'$.status')='integrated' THEN 'merged'
    ELSE 'none' END AS merge_status
  FROM source
)`;
const fields = 'kind,id,mode,append_number,source_draft_id,draft_number,created_at,task_id,parent_id,task_worker_number,parent_worker_number,branch,status,integration,merge_status,revision';

export const inputHistory = {
  /** Exclusive submitted management drafts follow the same confirmed deletion scope as their native receipt. */
  managementDraftIds(workerIds) {
    if (!workerIds.length) return [];
    return this.all(`SELECT d.id FROM drafts d JOIN tasks t ON t.id=json_extract(${emission},'$.worker_id')
      WHERE t.task_kind='management' AND t.id IN (${workerIds.map(() => '?').join(',')}) AND ${managementReceipt} ORDER BY d.id`, ...workerIds).map(row => row.id);
  },
  inputHistoryRows({ q, status, integration, conditional, view, modes, cursor, limit }) {
    const conditions = [], args = [];
    if (modes) {
      conditions.push(modes.length ? `mode IN (${modes.map(() => '?').join(',')})` : '0');
      args.push(...modes);
    }
    if (q) { conditions.push('instr(lower(content),lower(?)) > 0'); args.push(q); }
    if (status) { conditions.push('status=?'); args.push(status); }
    if (integration) { conditions.push('merge_status=?'); args.push(integration); }
    if (cursor) {
      conditions.push('(created_at,kind,id) < (?,?,?)');
      args.push(cursor.created_at, cursor.kind, cursor.id);
    }
    return this.all(`${history(conditional, view)} SELECT ${fields},substr(content,1,1000) AS content,
      length(content)>1000 AS content_truncated FROM projected
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY created_at DESC,kind DESC,id DESC LIMIT ?`, ...args, limit + 1)
      .map(row => ({ ...row, content_truncated: !!row.content_truncated }));
  },
  inputHistoryItem(kind, itemId) {
    const row = this.get(`${history(undefined, kind === 'draft' ? 'detail' : 'history')} SELECT ${fields},content FROM projected WHERE kind=? AND id=?`, kind, itemId);
    return row ? { ...row, content_truncated: false } : null;
  },
};
