/** 时间轴原料：任务、生命周期事件与子任务存活区间。 */
export const timeline = {
  /** 时间轴原料：最近 limit 个任务，按 id 升序（画图从左到右）。 */
  timelineTasks(limit) {
    return this.all(`SELECT id,parent_id,input_id,role,name,status,integration,created_at,updated_at
      FROM (SELECT * FROM tasks WHERE layer='work' ORDER BY id DESC LIMIT ?) ORDER BY id`, limit);
  },
  /** 这些任务的生命周期事件：invocation.started→invocation.completed 就是"真的在跑"的区间。 */
  lifecycleEvents(taskIds) {
    if (!taskIds.length) return [];
    const holes = taskIds.map(() => '?').join(',');
    return this.all(`SELECT task_id, type, created_at FROM events
      WHERE task_id IN (${holes}) AND type IN ('invocation.started','invocation.completed','completed','failed','cancelled')
      ORDER BY task_id, id`, ...taskIds);
  },
  /** 这些任务的子任务存活区间：父任务停着不动时，可能是在等子任务，而不是在等槽。 */
  childSpans(taskIds) {
    if (!taskIds.length) return [];
    const holes = taskIds.map(() => '?').join(',');
    return this.all(`SELECT parent_id, id, created_at,
        (SELECT MAX(e.created_at) FROM events e WHERE e.task_id=tasks.id AND e.type IN ('completed','failed','cancelled')) AS terminal_at
      FROM tasks WHERE parent_id IN (${holes}) ORDER BY id`, ...taskIds);
  },
};
