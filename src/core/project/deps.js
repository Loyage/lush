import { check, TERMINAL } from '../types.js';

/** 依赖边的读模型与结构校验。 */
export default {
  /** AP rows plus their dependency edges, so every read model shows what a queued AP waits for. */
  decorate(aps) {
    const edges = this.store.depMap(aps.map(ap => ap.id));
    // 一次性取回这一批 AP 的调用区间：计划时长里的等待要单独显示，不能算进 Agent 的工作用时。
    const runs = this.store.runsForAPs(aps.map(ap => ap.id));
    // 快速路由是「这条输入」的属性：同 input 的 planner 与它派生出的 AP 都带上同一标记。
    const routed = this.store.routedInputIds();
    return aps.map(ap => {
      const deps = edges.get(ap.id) || [];
      return { ...this.progressView(ap, runs.get(ap.id) ?? []), deps, blocked: deps.some(edge => !TERMINAL.has(edge.status)),
        route: ap.input_id !== null && ap.input_id !== undefined && routed.has(ap.input_id) };
    });
  },

  blockedBy(apId) { return (this.store.depMap().get(apId) || []).filter(edge => !TERMINAL.has(edge.status)).map(edge => edge.id); },

  /** Structural dependency checks. Semantic conflicts (duplicate work, same files) stay the planner's job. */
  assertDeps(apId, parent, edges) {
    const ancestors = new Set();
    for (let node = parent; node; node = node.parent_id ? this.store.ap(node.parent_id) : null) ancestors.add(node.id);
    let code = 0;
    for (const edge of edges) {
      check(edge.id !== apId, 'an AP cannot depend on itself');
      check(!ancestors.has(edge.id), `cannot depend on ancestor AP #${edge.id}: an ancestor waits for its children, so both sides would wait forever`);
      const dep = this.store.ap(edge.id);
      // Edges are only ever written here, so this cannot fire today; it keeps a future edit-DAG API honest.
      check(!this.store.reaches(edge.id, apId), `dependency on #${edge.id} would create a cycle`);
      if (edge.kind !== 'code') continue;
      code += 1;
      check(code <= 1, 'an AP can stack on at most one code dependency; use order for the rest, or add an AP that merges both');
      check(dep.role === 'worker', `code dependency #${dep.id} is a ${dep.role} ap; only a worker gets a branch to stack on`);
      check(!['failed','cancelled'].includes(dep.status), `code dependency #${dep.id} is ${dep.status}; it cannot serve as a code base`);
    }
  }
};
