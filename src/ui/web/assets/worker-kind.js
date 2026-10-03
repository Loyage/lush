/** Read compatibility only: historical say records are orders; never rewrite the source object. */
export function workerKind(task) {
  return task?.task_kind === 'say' ? 'order' : task?.task_kind;
}

export function workerKindLabel(task) {
  const kind = workerKind(task);
  return kind === 'order' ? '指令' : kind;
}
