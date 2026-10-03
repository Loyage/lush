/** Read-only compatibility for persisted pre-rename Worker rows. Never rewrite their identity or paths. */
export function normalizeOrderRecord(row) {
  if (!row || (row.task_kind !== 'say' && row.parent_task_kind !== 'say')) return row;
  return { ...row,
    ...(row.task_kind === 'say' ? { task_kind: 'order' } : {}),
    ...(row.parent_task_kind === 'say' ? { parent_task_kind: 'order' } : {}),
  };
}
