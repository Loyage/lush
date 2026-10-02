// SQL projection keeps search/filter/pagination over the whole database, not overview.
// Missing original Tasks intentionally survive the LEFT JOIN.
const taskStatuses = "'queued','running','waiting','awaiting','paused','awaiting_acceptance','completed','failed','cancelled'";
const history = `WITH source AS (
  SELECT 'input' AS kind,i.id,i.content,i.created_at,t.id AS task_id,t.parent_id,
    coalesce(t.branch,i.anchor_branch) AS branch,
    CASE WHEN t.status='paused' AND t.calls=0 AND coalesce(t.agent_wakes,0)=0
      AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.task_id=t.id) THEN 'created'
      WHEN t.status IN (${taskStatuses}) THEN t.status ELSE 'unknown' END AS status,
    coalesce(t.integration,'none') AS integration,NULL AS revision,
    CASE WHEN json_valid(t.reservation) THEN t.reservation ELSE '{}' END AS booking,
    t.id AS original_task_id
  FROM inputs i LEFT JOIN tasks t ON t.id=i.task_id
  UNION ALL
  SELECT 'draft',d.id,d.content,d.created_at,NULL,d.parent_id,p.branch,'draft','none',d.revision,'{}',NULL
  FROM drafts d LEFT JOIN tasks p ON p.id=d.parent_id WHERE d.input_id IS NULL
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
          AND done.type IN ('task.merge_integrated','child.integrated','say.integrated')),0)
    ) THEN 'merged'
    WHEN integration='merged' AND json_extract(booking,'$.kind')='merge'
      AND json_extract(booking,'$.status')='integrated' THEN 'merged'
    ELSE 'none' END AS merge_status
  FROM source
)`;
const fields = 'kind,id,created_at,task_id,parent_id,branch,status,integration,merge_status,revision';

export const inputHistory = {
  inputHistoryRows({ q, status, integration, cursor, limit }) {
    const conditions = [], args = [];
    if (q) { conditions.push('instr(lower(content),lower(?)) > 0'); args.push(q); }
    if (status) { conditions.push('status=?'); args.push(status); }
    if (integration) { conditions.push('merge_status=?'); args.push(integration); }
    if (cursor) {
      conditions.push('(created_at,kind,id) < (?,?,?)');
      args.push(cursor.created_at, cursor.kind, cursor.id);
    }
    return this.all(`${history} SELECT ${fields},substr(content,1,1000) AS content,
      length(content)>1000 AS content_truncated FROM projected
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY created_at DESC,kind DESC,id DESC LIMIT ?`, ...args, limit + 1)
      .map(row => ({ ...row, content_truncated: !!row.content_truncated }));
  },
  inputHistoryItem(kind, itemId) {
    const row = this.get(`${history} SELECT ${fields},content FROM projected WHERE kind=? AND id=?`, kind, itemId);
    return row ? { ...row, content_truncated: false } : null;
  },
};
