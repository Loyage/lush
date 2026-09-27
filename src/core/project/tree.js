/** 任务树读模型（intent 层提上来当根）。 */
export default {
  tree(taskId = null) {
    // 任务树只画 work 层：planner / scheduler 属于意图（见 inputs()），它们的 work 子任务直接顶上来当根。
    const raw = this.store.summaries('work');
    const intentParents = new Set(this.store.summaries('intent').map(task => task.id));
    const originalParent = new Map(raw.map(task => [task.id, task.parent_id]));
    const tasks = this.decorate(raw.map(task => (task.parent_id !== null && intentParents.has(task.parent_id))
      ? { ...task, parent_id: null } : task));
    const rows = new Map(tasks.map(task => [task.id, { ...task, children: [] }]));
    const roots = [];
    for (const row of rows.values()) {
      // verifier 与 merger 都不是子任务（终态任务不能有活动后代），但界面上挂在它们服务的任务下面。
      const parent = row.parent_id ?? row.verifies_task_id ?? row.resolves_task_id;
      if (parent !== null && parent !== undefined && rows.has(parent)) rows.get(parent).children.push(row); else roots.push(row);
    }
    if (taskId !== null) {
      const target = this.store.task(taskId);
      if (rows.has(target.id)) return rows.get(target.id);
      // 按 id 看 planner / scheduler：它自己不进树，但把它这一批 work 子任务挂上来，展开就有内容。
      return { ...this.decorate([target])[0], children: [...rows.values()].filter(row => originalParent.get(row.id) === target.id) };
    }
    return roots;
  }
};
