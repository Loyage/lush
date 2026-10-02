/** Shared read projection; lifecycle classification belongs to the source Event, not current Worker state. */
export const NOTICE_SELECT = `SELECT n.*,
  CASE WHEN n.kind='info' AND n.source_event_id IS NOT NULL THEN (
    SELECT CASE e.type
      WHEN 'task.idle' THEN 'idle'
      WHEN 'completed' THEN 'analysis'
      WHEN 'failed' THEN 'failed'
      WHEN 'merge.repair_interrupted' THEN 'failed'
      WHEN 'analysis.fork_failed' THEN 'failed'
      ELSE NULL END
    FROM events e WHERE e.id=n.source_event_id AND e.task_id=n.task_id
  ) ELSE NULL END AS lifecycle_type
  FROM notices n`;
