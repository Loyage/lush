/** Native management sessions are occurrence-scoped; historical filenames remain readable/deletable. */
export function managementSessionIdentity(taskId, occurrenceId, elevated, piMode) {
  if (!Number.isSafeInteger(taskId) || taskId <= 0 || !Number.isSafeInteger(occurrenceId) || occurrenceId <= 0) throw new Error('current management occurrence required for isolated session');
  return `lush-manager-${taskId}-${elevated ? 'administrator' : 'ordinary'}-${occurrenceId}${piMode ? '-pi' : ''}`;
}
export function managementInvocationStem(taskId, occurrenceId, elevated, piMode) {
  return managementSessionIdentity(taskId, occurrenceId, elevated, piMode).replace('lush-manager-', 'task-');
}
export function isManagementInvocationFile(name, taskId) {
  return Number.isSafeInteger(taskId) && taskId > 0
    && new RegExp(`^task-${taskId}-(?:ordinary|administrator)-[1-9][0-9]*(?:-pi)?-(?:input|system)\\.md$`).test(name);
}
export function isManagementSessionFile(name, taskId) {
  if (!Number.isSafeInteger(taskId) || taskId <= 0) return false;
  return name.endsWith(`_lush-manager-${taskId}.jsonl`) || name.endsWith(`_lush-manager-${taskId}-pi.jsonl`)
    || new RegExp(`_lush-manager-${taskId}-(?:ordinary|administrator)-[1-9][0-9]*(?:-pi)?\\.jsonl$`).test(name);
}
