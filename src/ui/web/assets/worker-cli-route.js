export function workerCliTarget(hash) {
  const match = /^#worker-([1-9]\d*)-cli$/.exec(hash);
  const taskId = Number(match?.[1]);
  return match && Number.isSafeInteger(taskId) ? { taskId } : null;
}
