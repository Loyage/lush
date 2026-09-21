import { check, id, text, TERMINAL, bounded, isPlainObject } from '../types.js';
import { taskSlug } from '../naming.js';
import { agentView } from './internal.js';

export const DEP_KINDS = new Set(['code', 'order']);
function normalizeDeps(deps) {
  check(Array.isArray(deps), 'deps must be an array');
  check(deps.length <= 32, 'at most 32 dependencies per task');
  const edges = [];
  for (const raw of deps) {
    const value = isPlainObject(raw) ? raw : { id: raw };
    const kind = value.kind ?? 'code';
    check(DEP_KINDS.has(kind), 'dependency kind must be code or order');
    const depId = id(value.id);
    check(!edges.some(edge => edge.id === depId), `duplicate dependency on task ${depId}`);
    edges.push({ id: depId, kind });
  }
  return edges;
}

/** 派生任务与单任务详情。 */
export default {
  /** name is the planner's short slug for the work; it becomes the branch/worktree name and stays fixed for the task's life. */
  spawn(parentId, goal, role = 'worker', deps = [], name = null, specId = null) {
    const parent = this.store.task(parentId);
    check(!TERMINAL.has(parent.status), 'cannot delegate from a terminal task');
    check(parent.role !== 'planner', 'planner 不再直接派活；用 lush spec add 写拆解队列，由 scheduler 编排');
    text(goal, 'goal'); check(['worker','coordinator','research'].includes(role), 'role must be worker, coordinator or research');
    const edges = normalizeDeps(deps);
    const resolved = new Map(edges.map(edge => [edge.id, edge.kind]));
    let spec = null;
    if (specId !== null && specId !== undefined) {
      spec = this.store.spec(specId);
      check(spec.status === 'pending', `spec #${spec.id} is ${spec.status}; only a pending spec can be spawned`);
      if (parent.role === 'scheduler') check(spec.batch_id === parent.id, `spec #${spec.id} is not in scheduler #${parent.id}'s batch`);
      // Turn the planner's dependency hints into real edges. A dependency cannot be spawned after its consumer.
      for (const hint of spec.deps) {
        const target = this.store.spec(hint.spec);
        check(target.status !== 'dropped', `spec #${hint.spec} was dropped; its dependency can never be met, so drop spec #${spec.id} instead of spawning it`);
        check(target.task_id !== null, `spec #${hint.spec} has not been spawned yet; spawn the dependency before spec #${spec.id}`);
        const existing = resolved.get(target.task_id);
        if (existing !== undefined) check(existing === hint.kind, `conflicting dependency on task #${target.task_id}: explicit ${existing} vs spec hint ${hint.kind}`);
        else resolved.set(target.task_id, hint.kind);
      }
    } else {
      check(parent.role !== 'scheduler', 'a scheduler must spawn every spec with --spec SPEC_ID; the spec queue is its only input');
    }
    const merged = [...resolved].map(([edgeId, kind]) => ({ id: edgeId, kind }));
    // 硬约束：了解类输入只能派生只读的 research，不能产生 worker/coordinator（因此不会创建 worktree 或待合并改动）。
    // scheduler 自己没有 input，所以它 spawn 的 spec 要把 spec 的 input_id 接过来，explain 约束才能覆盖整棵子树。
    const inheritedInput = parent.input_id ?? (spec ? spec.input_id : null);
    const input = inheritedInput === null ? null : this.store.get('SELECT id, flow FROM inputs WHERE id=?', inheritedInput);
    check(!input || input.flow !== 'explain' || role === 'research',
      `input #${input?.id} is classified as explain (了解); delegate research or answer directly, not ${role}`);
    let depth = 1, ancestor = parent;
    while (ancestor.parent_id) { ancestor = this.store.task(ancestor.parent_id); depth++; }
    check(depth < this.config.maxDepth, 'task nesting limit reached');
    check(this.store.get("SELECT count(*) AS n FROM tasks WHERE status NOT IN ('completed','failed','cancelled')").n < 1000, 'too many active tasks');
    const slug = taskSlug(name, goal);
    const task = this.store.transaction(() => {
      const created = this.store.create({ parent_id: parent.id, input_id: inheritedInput, role, goal, name: slug });
      this.assertDeps(created.id, parent, merged);
      for (const edge of merged) { this.store.addDep(created.id, edge.id, edge.kind); this.store.event(created.id, 'dep.added', edge); }
      if (spec) this.store.plannedSpec(spec.id, created.id);
      return created;
    });
    this.kick(); return task;
  },

  /** Deterministic Plan compiler path: turn one planner spec into a root work item without another model call. */
  materializeSpec(plannerId, specId) {
    const planner = this.store.task(plannerId);
    check(planner.role === 'planner', 'only a planner plan can be compiled');
    const spec = this.store.spec(specId);
    check(spec.planner_task_id === planner.id, `spec #${spec.id} belongs to another planner`);
    check(spec.status === 'pending', `spec #${spec.id} is ${spec.status}; only pending specs are compiled`);
    const role = spec.role ?? 'worker';
    check(['worker','coordinator','research'].includes(role), `spec #${spec.id} has invalid role ${role}`);
    const edges = spec.deps.map(hint => {
      const target = this.store.spec(hint.spec);
      check(target.status !== 'dropped', `spec #${hint.spec} was dropped; spec #${spec.id} cannot be compiled`);
      check(target.task_id !== null, `spec #${hint.spec} has not been compiled yet`);
      return { id: target.task_id, kind: hint.kind };
    });
    const input = spec.input_id === null ? null : this.store.get('SELECT id,flow FROM inputs WHERE id=?', spec.input_id);
    check(!input || input.flow !== 'explain' || role === 'research',
      `input #${input?.id} is classified as explain (了解); only research work is allowed`);
    check(this.store.get("SELECT count(*) AS n FROM tasks WHERE status NOT IN ('completed','failed','cancelled')").n < 1000,
      'too many active tasks');
    const task = this.store.create({ parent_id: null, input_id: spec.input_id, role, goal: spec.goal, name: spec.name });
    this.assertDeps(task.id, null, edges);
    for (const edge of edges) { this.store.addDep(task.id, edge.id, edge.kind); this.store.event(task.id, 'dep.added', edge); }
    this.store.plannedSpec(spec.id, task.id);
    this.store.event(task.id, 'plan.materialized', { planner: planner.id, spec: spec.id });
    return task;
  },

  inspect(taskId) {
    const task = this.store.task(taskId);
    return { ...task, deps: this.store.depsDetail(task.id), dependents: this.store.dependentsDetail(task.id),
      ...(task.role === 'planner' ? { specs: bounded(this.store.specsByPlanner(task.id), 200000) } : {}),
      ...(task.role === 'scheduler' ? { specs: bounded(this.store.specsForBatch(task.id), 200000) } : {}),
      children: bounded(this.store.summaries().filter(child => child.parent_id === task.id), 100000),
      messages: bounded(this.store.all('SELECT * FROM messages WHERE task_id=? ORDER BY id DESC LIMIT 100', task.id), 200000),
      notices: bounded(this.store.all('SELECT * FROM notices WHERE task_id=? ORDER BY id DESC LIMIT 100', task.id), 200000),
      // worker 带着自己的检验记录与合并冲突处理记录；verifier 带着自己的报告路径。都是只读投影。
      verifications: task.role === 'worker' ? bounded(this.store.verifications(task.id).map(row => ({ ...row, has_report: this.hasReport(row.id) })), 200000) : undefined,
      resolutions: task.role === 'worker' ? bounded(this.store.resolutions(task.id), 200000) : undefined,
      report: task.role === 'verifier' && this.hasReport(task.id) ? this.reportPath(task.id) : null,
      runs: bounded(this.store.runsForTask(task.id), 200000),
      artifacts: bounded(this.store.artifactsForTask(task.id), 200000),
      agent: agentView(task, this.running.get(task.id) ?? null) };
  },

  diff(taskId) { return this.workspaces.diff(this.store.task(taskId)); }
};
