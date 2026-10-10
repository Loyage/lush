/** Shared read projection; lifecycle classification belongs to the source Event, not current Worker state. */
export const NOTICE_SELECT = `SELECT n.id,n.task_id,n.title,n.body,n.status,n.answer,n.kind,n.source_event_id,n.read_at,n.created_at,
  CASE WHEN n.status IN ('answered','dismissed') THEN COALESCE(n.answer_source,'user') ELSE NULL END AS answer_source,
  (SELECT t.worker_number FROM tasks t WHERE t.id=n.task_id) AS task_worker_number,
  (SELECT r.identity FROM notice_sync_records r WHERE r.notice_id=n.id) AS sync_identity,
  (SELECT r.revision FROM notice_sync_records r WHERE r.notice_id=n.id) AS sync_revision,
  (SELECT m.value FROM meta m WHERE m.key='notice_sync_epoch') AS sync_epoch,
  CASE WHEN n.kind='info' AND n.source_event_id IS NOT NULL THEN (
    SELECT CASE e.type
      WHEN 'task.start_pending' THEN 'created'
      WHEN 'task.idle' THEN 'idle'
      WHEN 'completed' THEN 'analysis'
      WHEN 'failed' THEN 'failed'
      WHEN 'merge.repair_interrupted' THEN 'failed'
      WHEN 'analysis.fork_failed' THEN 'failed'
      ELSE NULL END
    FROM events e WHERE e.id=n.source_event_id AND e.task_id=n.task_id
  ) ELSE NULL END AS lifecycle_type
  FROM notices n`;
