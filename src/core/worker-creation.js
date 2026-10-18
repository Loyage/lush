/** Creation provenance is public metadata; the frozen Pi pointer is a separate private column. */
export function workerCreation(task) {
  if (!task.creation) return null;
  const value = typeof task.creation === 'string' ? JSON.parse(task.creation) : task.creation;
  return { mode: value.mode, source_id: value.source_id ?? null, source_worker_number: value.source_worker_number ?? null,
    commit: value.commit, session_inherited: value.session_inherited === true,
    warning: value.warning ?? null, waiting_first_input: task.input_id === null };
}
export function waitingFirstInput(task) {
  return Boolean(task.creation) && task.input_id === null;
}
export function publicCreatedWorker(task) {
  const { session_fork: _sessionFork, retry_profile: _profile, ...safe } = task;
  return { ...safe, creation: workerCreation(task) };
}
