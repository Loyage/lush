import { check, TERMINAL } from '../types.js';

/** 依赖边的读模型与结构校验。 */
export default {
  /** Task rows plus their dependency edges, so every read model shows what a queued task waits for. */
  decorate(tasks) {
    const edges = this.store.depMap(tasks.map(task => task.id));
    return tasks.map(task => {
      const deps = edges.get(task.id) || [];
      return { ...this.progressView(task), deps, blocked: deps.some(edge => !TERMINAL.has(edge.status)) };
    });
  },

  blockedBy(taskId) { return (this.store.depMap().get(taskId) || []).filter(edge => !TERMINAL.has(edge.status)).map(edge => edge.id); },

  /** Structural dependency checks. Semantic conflicts (duplicate work, same files) stay the planner's job. */
  assertDeps(taskId, parent, edges) {
    const ancestors = new Set();
    for (let node = parent; node; node = node.parent_id ? this.store.task(node.parent_id) : null) ancestors.add(node.id);
    let code = 0;
    for (const edge of edges) {
      check(edge.id !== taskId, 'a task cannot depend on itself');
      check(!ancestors.has(edge.id), `cannot depend on ancestor task #${edge.id}: an ancestor waits for its children, so both sides would wait forever`);
      const dep = this.store.task(edge.id);
      // Edges are only ever written here, so this cannot fire today; it keeps a future edit-DAG API honest.
      check(!this.store.reaches(edge.id, taskId), `dependency on #${edge.id} would create a cycle`);
      if (edge.kind !== 'code') continue;
      code += 1;
      check(code <= 1, 'a task can stack on at most one code dependency; use order for the rest, or add a task that merges both');
      check(dep.role === 'worker', `code dependency #${dep.id} is a ${dep.role} task; only a worker gets a branch to stack on`);
      check(!['failed','cancelled'].includes(dep.status), `code dependency #${dep.id} is ${dep.status}; it cannot serve as a code base`);
    }
  }
};
