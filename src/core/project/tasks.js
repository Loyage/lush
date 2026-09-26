import { check, id, text, TERMINAL, bounded, isPlainObject } from '../types.js';
import { taskSlug } from '../naming.js';
import { agentView } from './internal.js';
import fs from 'node:fs';
import { saveInputRule, snapshotPath } from '../task-input-rule.js';

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
  spawn(parentId, goal, role = undefined, deps = [], name = null, specId = null) {
    this.assertWritable('delegate a task');
    const parent = this.store.task(parentId);
    check(!['main','owner'].includes(parent.task_kind), 'branch owner Tasks accept new say Tasks, not unrestricted spawned work');
    check(parent.task_kind !== 'analysis', 'read-only analysis Tasks do not delegate; ask a new question instead');
    const taskKind = ['say','child'].includes(parent.task_kind) ? 'child' : null;
    if (taskKind && parent.branch) this.assertBranchWritable(parent.branch, 'delegate more work while resolving divergence');
    role = role ?? (taskKind ? 'agent' : 'worker');
    check(!TERMINAL.has(parent.status), 'cannot delegate from a terminal task');
    check(!['showcase', 'explainer', 'butler'].includes(parent.role), 'showcase and explanation agents cannot delegate development work');
    check(parent.role !== 'planner', 'planner 不再直接派活；用 lush spec add 写拆解队列，由 scheduler 编排');
    text(goal, 'goal');
    check(taskKind ? role === 'agent' : ['worker','coordinator','research'].includes(role),
      taskKind ? 'new Task agents can only delegate a Task agent' : 'role must be worker, coordinator or research');
    check(!taskKind || specId === null, 'new Task agents do not compile planner specs');
    const edges = normalizeDeps(deps);
    check(!taskKind || edges.length === 0, 'new Task children use parent signals, not legacy dependency edges');
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
    const inheritedInput = parent.input_id ?? (spec ? spec.input_id : null);
    let depth = 1, ancestor = parent;
    while (ancestor.parent_id) { ancestor = this.store.task(ancestor.parent_id); depth++; }
    check(depth < this.config.maxDepth, 'task nesting limit reached');
    check(this.store.get("SELECT count(*) AS n FROM tasks WHERE status NOT IN ('completed','failed','cancelled')").n < 1000, 'too many active tasks');
    const slug = taskSlug(name, goal);
    const parentRule = taskKind && fs.existsSync(snapshotPath(this.config.home, parent.id))
      ? fs.readFileSync(snapshotPath(this.config.home, parent.id), 'utf8') : null;
    let ruleTaskId = null;
    let task;
    try { task = this.store.transaction(() => {
      const created = this.store.create({ parent_id: parent.id, input_id: inheritedInput, role, goal, name: slug, task_kind: taskKind });
      this.assertDeps(created.id, parent, merged);
      if (parentRule !== null) {
        ruleTaskId = created.id;
        saveInputRule(this.config.home, created.id, parentRule);
        this.store.event(created.id, 'task.input_rule_frozen', { inherited_from: parent.id });
      }
      for (const edge of merged) { this.store.addDep(created.id, edge.id, edge.kind); this.store.event(created.id, 'dep.added', edge); }
      if (spec) this.store.plannedSpec(spec.id, created.id);
      return created;
    }); } catch (error) {
      if (ruleTaskId !== null) fs.rmSync(snapshotPath(this.config.home, ruleTaskId), { force: true });
      throw error;
    }
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
    check(this.store.get("SELECT count(*) AS n FROM tasks WHERE status NOT IN ('completed','failed','cancelled')").n < 1000,
      'too many active tasks');
    const task = this.store.create({ parent_id: null, input_id: spec.input_id, role, goal: spec.goal, name: spec.name });
    this.assertDeps(task.id, null, edges);
    for (const edge of edges) { this.store.addDep(task.id, edge.id, edge.kind); this.store.event(task.id, 'dep.added', edge); }
    this.store.plannedSpec(spec.id, task.id);
    this.store.event(task.id, 'plan.materialized', { planner: planner.id, spec: spec.id });
    return task;
  },

  /** Task window: active items plus a bounded terminal tail; all includes control-plane roles. */
  activity(limit = 50, scope = 'work') {
    check(['work', 'all'].includes(scope), 'invalid task scope');
    const size = Number(limit);
    check(Number.isInteger(size) && size >= 1 && size <= 200, 'activity limit must be 1..200');
    const active = this.store.summaryPage({ active: true, limit: 1000, scope });
    const recent = this.store.summaryPage({ limit: size, scope });
    const byId = new Map([...active, ...recent].map(task => [task.id, task]));
    const tasks = this.decorate([...byId.values()].sort((a, b) => a.id - b.id));
    const cursor = recent.length ? Math.min(...recent.map(task => task.id)) : null;
    const counts = this.store.all(`SELECT status,count FROM overview_task_counts WHERE ${scope === 'all' ? "layer IN ('work','intent')" : "layer='work'"} AND count>0`);
    const total = counts.reduce((sum, row) => sum + row.count, 0);
    const historical = counts.filter(row => TERMINAL.has(row.status)).reduce((sum, row) => sum + row.count, 0);
    return { tasks, page: { limit: size, cursor, has_more: cursor !== null && historical > recent.length,
      shown: recent.length, total, historical, active: active.length, truncated: historical > recent.length } };
  },

  /** Older terminal items within the requested scope; callers merge pages by id. */
  taskPage(before = null, limit = 50, scope = 'work') {
    check(['work', 'all'].includes(scope), 'invalid task scope');
    const cursor = before === null || before === undefined ? null : Number(before);
    const size = Number(limit);
    check(cursor === null || (Number.isSafeInteger(cursor) && cursor > 0), 'invalid task history cursor');
    check(Number.isInteger(size) && size >= 1 && size <= 200, 'task history limit must be 1..200');
    const rows = this.store.summaryPage({ before: cursor, limit: size + 1, scope });
    const hasMore = rows.length > size;
    const page = rows.slice(0, size);
    return { tasks: this.decorate(page.sort((a, b) => a.id - b.id)), cursor: page.length ? Math.min(...page.map(task => task.id)) : cursor,
      has_more: hasMore, limit: size, truncated: hasMore };
  },

  inspect(taskId) {
    // retry_profile may contain a replacement system prompt and local resource paths. It is
    // runtime configuration, not part of the task read model (agents can call task.inspect).
    const { retry_profile: _retryProfile, ...storedTask } = this.store.task(taskId);
    // 详情页要显示工作用时与等待行：先取这一轮的调用区间，计划时长才能只算真正运行的时间。
    const runs = this.store.runsForTask(storedTask.id);
    const task = this.progressView(storedTask, runs);
    // 与任务树 / 分支图同一口径：这条输入的 planner 带 input.route 事件就是快速路由。
    task.route = storedTask.input_id !== null && this.store.routedInputIds().has(storedTask.input_id);
    const resolution = task.task_kind === 'child' ? this.store.get(
      "SELECT data FROM events WHERE task_id=? AND type='task.divergence_resolution_requested' ORDER BY id DESC LIMIT 1", task.id) : null;
    return { ...task, parent_task_kind: task.parent_id ? this.store.task(task.parent_id).task_kind : null,
      ...(resolution ? { divergence_resolution: { ...JSON.parse(resolution.data),
        branch_status: task.branch ? this.store.branch(task.branch)?.status ?? null : null } } : {}),
      deps: this.store.depsDetail(task.id), dependents: this.store.dependentsDetail(task.id),
      ...(task.role === 'planner' ? { specs: bounded(this.store.specsByPlanner(task.id), 200000) } : {}),
      ...(task.role === 'scheduler' ? { specs: bounded(this.store.specsForBatch(task.id), 200000) } : {}),
      children: bounded(this.decorate(this.store.summaries().filter(child => child.parent_id === task.id)), 100000),
      messages: bounded(this.store.all('SELECT * FROM messages WHERE task_id=? ORDER BY id DESC LIMIT 100', task.id), 200000),
      notices: bounded(this.store.all('SELECT * FROM notices WHERE task_id=? ORDER BY id DESC LIMIT 100', task.id), 200000),
      // worker 带着自己的检验记录与合并冲突处理记录；verifier 带着自己的报告路径。都是只读投影。
      verifications: task.role === 'worker' ? bounded(this.store.verifications(task.id).map(row => ({ ...row, has_report: this.hasReport(row.id) })), 200000) : undefined,
      resolutions: task.role === 'worker' ? bounded(this.store.resolutions(task.id), 200000) : undefined,
      report: ['verifier','showcase'].includes(task.role) && this.hasReport(task.id) ? this.reportPath(task.id) : null,
      ...(task.role === 'showcase' ? { showcase: this.showcaseContext(task) } : {}),
      runs: bounded(runs, 200000),
      artifacts: bounded(this.store.artifactsForTask(task.id), 200000),
      agent: agentView(task, this.running.get(task.id) ?? null, runs.at(-1) ?? null) };
  },

  diff(taskId) { return this.workspaces.diff(this.store.task(taskId)); }
};
