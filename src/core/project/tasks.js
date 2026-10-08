import { check, id, text, TERMINAL, bounded, isPlainObject } from '../types.js';
import { taskSlug } from '../naming.js';
import { workerLabel } from '../worker-number.js';
import { NOTICE_SELECT } from '../../persistence/notice-projection.js';
import { MESSAGE_SELECT } from '../../persistence/store/messages.js';
import { agentView, workerModelSelection, inheritedRunProfile, profileEvent } from './internal.js';
import fs from 'node:fs';
import { saveInputRule, snapshotPath } from '../task-input-rule.js';
import { forkCheckpoint } from '../../agent/fork.js';
import { assertTaskAncestorsOpen, assertTaskNotSyncing, consumeIntegratedReservation, iterationViews } from './iteration.js';

export const DEP_KINDS = new Set(['code', 'order']);
/** `inspect` ships the newest Run/Artifact rows only; older evidence stays behind `*_page` cursors. */
const RUN_WINDOW = 50;
const PAGE_MAX = 200;
/** Work/wait projection needs the plan's invocation intervals; a Worker cannot exceed the call limit (≤1000). */
const PROGRESS_RUN_LIMIT = 1000;

/** Flatten bounded newest-first pages into one ascending window; `has_more` reports older rows beyond it. */
function collectRuns(store, taskId, max) {
  const pages = [];
  let page = store.runsPage(taskId, { before: null, limit: Math.min(PAGE_MAX, max) });
  pages.push(page);
  let seen = page.items.length;
  while (page.has_more && seen < max) {
    page = store.runsPage(taskId, { before: page.cursor, limit: Math.min(PAGE_MAX, max - seen) });
    pages.push(page);
    seen += page.items.length;
  }
  return { items: pages.reverse().flatMap(part => part.items), has_more: page.has_more };
}

/** Bounded-window metadata: `has_more` offers older pages, `truncated` marks a byte-trimmed window. */
function pageView(page, returned, limit) {
  return { has_more: page.has_more || returned.length < page.items.length,
    cursor: returned.at(0)?.id ?? null, limit,
    truncated: returned.length < Math.min(limit, page.items.length) };
}
function normalizeDeps(deps) {
  check(Array.isArray(deps), 'deps must be an array');
  check(deps.length <= 32, 'at most 32 dependencies per worker');
  const edges = [];
  for (const raw of deps) {
    const value = isPlainObject(raw) ? raw : { id: raw };
    const kind = value.kind ?? 'code';
    check(DEP_KINDS.has(kind), 'dependency kind must be code or order');
    const depId = id(value.id);
    check(!edges.some(edge => edge.id === depId), `duplicate dependency on worker ${depId}`);
    edges.push({ id: depId, kind });
  }
  return edges;
}

/** 派生任务与单任务详情。 */
export default {
  /** name is the planner's short slug for the work; it becomes the branch/worktree name and stays fixed for the task's life. */
  async spawn(parentId, goal, role = undefined, deps = [], name = null, specId = null) {
    return this.write('fork a worker', () => this.forkChildTask(parentId, goal, role, deps, name, specId));
  },

  async forkChildTask(parentId, goal, role = undefined, deps = [], name = null, specId = null) {
    this.assertWritable('delegate a worker');
    const parent = this.store.task(parentId);
    assertTaskNotSyncing(this, parent.id);
    check(!['main','owner'].includes(parent.task_kind), 'branch owner Workers accept new order Workers, not unrestricted spawned work');
    check(parent.task_kind !== 'analysis', 'read-only analysis Workers do not delegate; ask a new question instead');
    const taskKind = ['order','child'].includes(parent.task_kind) ? 'child' : null;
    check(taskKind === 'child', 'only order/child Workers can delegate');
    check(role === undefined || role === 'agent', 'child role must be agent');
    check(Array.isArray(deps) && deps.length === 0 && specId === null, 'legacy deps and specs are not supported');
    if (parent.branch) this.assertBranchWritable(parent.branch, 'delegate more work while resolving divergence');
    role = 'agent';
    check(!TERMINAL.has(parent.status), 'cannot delegate from a terminal worker');
    assertTaskAncestorsOpen(this, parent);
    check(!['showcase', 'explainer', 'butler'].includes(parent.role), 'retired and explanation agents cannot delegate development work');
    check(parent.role !== 'planner', 'planner 不再直接派活；用 lush spec add 写拆解队列，由 scheduler 编排');
    text(goal, 'goal');
    check(taskKind ? role === 'agent' : ['worker','coordinator','research'].includes(role),
      taskKind ? 'new Worker agents can only delegate a Worker agent' : 'role must be worker, coordinator or research');
    check(!taskKind || specId === null, 'new Worker agents do not compile planner specs');
    const edges = normalizeDeps(deps);
    check(!taskKind || edges.length === 0, 'new Worker children use parent signals, not legacy dependency edges');
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
        if (existing !== undefined) check(existing === hint.kind, `conflicting dependency on worker #${target.task_id}: explicit ${existing} vs spec hint ${hint.kind}`);
        else resolved.set(target.task_id, hint.kind);
      }
    } else {
      check(parent.role !== 'scheduler', 'a scheduler must spawn every spec with --spec SPEC_ID; the spec queue is its only input');
    }
    const merged = [...resolved].map(([edgeId, kind]) => ({ id: edgeId, kind }));
    const inheritedInput = parent.input_id ?? (spec ? spec.input_id : null);
    let depth = 1, ancestor = parent;
    while (ancestor.parent_id) { ancestor = this.store.task(ancestor.parent_id); depth++; }
    check(depth < this.config.maxDepth, 'worker nesting limit reached');
    check(this.store.get("SELECT count(*) AS n FROM tasks WHERE status NOT IN ('completed','failed','cancelled')").n < 1000, 'too many active workers');
    const slug = taskSlug(name, goal);
    const parentRule = taskKind && fs.existsSync(snapshotPath(this.config.home, parent.id))
      ? fs.readFileSync(snapshotPath(this.config.home, parent.id), 'utf8') : null;
    return this.workspaces.exclusive(async () => {
      const liveParent = this.store.task(parent.id);
      assertTaskNotSyncing(this, liveParent.id);
      assertTaskAncestorsOpen(this, liveParent);
      check(!TERMINAL.has(liveParent.status) && liveParent.branch === parent.branch, 'parent changed before fork');
      const commit = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${parent.branch}^{commit}`);
      let ruleTaskId = null, task;
      try { task = this.store.transaction(() => {
        if (liveParent.status === 'awaiting_acceptance') {
          consumeIntegratedReservation(this, liveParent, 'delegated new work');
          this.store.update(liveParent.id, { status: 'waiting' });
        }
        const created = this.store.create({ parent_id: parent.id, input_id: inheritedInput, role, goal, name: slug, task_kind: taskKind });
        // Freeze the parent's effective run settings (mode/source/model/budget) for the child: the
        // current invocation wins, then its task-local override, then the effective default.
        const inherited = inheritedRunProfile(this, liveParent, this.running.get(liveParent.id) ?? null);
        this.store.update(created.id, { auto_merge: JSON.stringify({ version: 1, enabled: true, locked: true }),
          reservation: JSON.stringify({ version: 2, kind: 'merge', auto_merge: true,
            status: 'pending', created_at: new Date().toISOString() }),
          ...(inherited ? { retry_profile: JSON.stringify(inherited) } : {}) });
        this.store.event(created.id, 'task.reserved', { kind: 'merge', version: 2, via: 'spawn' });
        if (inherited) this.store.event(created.id, 'task.configured',
          { ...profileEvent(inherited), profile_override: true, inherited_from: liveParent.id });
        this.assertDeps(created.id, liveParent, merged);
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
      try {
        await this.workspaces.forkTaskUnsafe(task, liveParent.branch, commit);
        const pointer = this.store.get('SELECT session_path AS session, entry_id AS entry FROM commit_contexts WHERE commit_hash=?', commit);
        if (pointer) forkCheckpoint(this.config.home, { ...pointer, commit });
      } catch (error) {
        // A partially created worktree is valuable evidence; never force-delete it.
        this.store.update(task.id, { status: 'failed', error: `fork failed: ${error.message}` });
        this.store.event(task.id, 'task.fork_failed', { parent_id: parent.id, commit, error: error.message });
        throw new Error(`worker ${workerLabel(task)} fork failed; inspect its worktree: ${error.message}`);
      }
      this.kick(); return this.store.task(task.id);
    });
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
      'too many active workers');
    const task = this.store.create({ parent_id: null, input_id: spec.input_id, role, goal: spec.goal, name: spec.name });
    this.assertDeps(task.id, null, edges);
    for (const edge of edges) { this.store.addDep(task.id, edge.id, edge.kind); this.store.event(task.id, 'dep.added', edge); }
    this.store.plannedSpec(spec.id, task.id);
    this.store.event(task.id, 'plan.materialized', { planner: planner.id, spec: spec.id });
    return task;
  },

  /** Task window: active items plus a bounded terminal tail; all includes control-plane roles. */
  activity(limit = 50, scope = 'work') {
    check(['work', 'all'].includes(scope), 'invalid worker scope');
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
    check(['work', 'all'].includes(scope), 'invalid worker scope');
    const cursor = before === null || before === undefined ? null : Number(before);
    const size = Number(limit);
    check(cursor === null || (Number.isSafeInteger(cursor) && cursor > 0), 'invalid worker history cursor');
    check(Number.isInteger(size) && size >= 1 && size <= 200, 'worker history limit must be 1..200');
    const rows = this.store.summaryPage({ before: cursor, limit: size + 1, scope });
    const hasMore = rows.length > size;
    const page = rows.slice(0, size);
    return { tasks: this.decorate(page.sort((a, b) => a.id - b.id)), cursor: page.length ? Math.min(...page.map(task => task.id)) : cursor,
      has_more: hasMore, limit: size, truncated: hasMore };
  },

  inspect(taskId) {
    // retry_profile may contain a replacement system prompt and local resource paths. It is
    // runtime configuration, not part of the task read model (agents can call worker.inspect).
    const { retry_profile: _retryProfile, hooks: _privateHooks, ...storedTask } = this.store.task(taskId);
    // 详情页要显示工作用时与等待行：先取这一轮的调用区间，计划时长才能只算真正运行的时间。
    // 有执行计划时读计划窗口内足够重建用时的有界调用记录；否则只取展示窗口。
    const runsRead = storedTask.progress_plan
      ? collectRuns(this.store, storedTask.id, PROGRESS_RUN_LIMIT)
      : this.store.runsPage(storedTask.id, { limit: RUN_WINDOW });
    const progressRuns = runsRead.items;
    const task = { ...this.progressView(storedTask, progressRuns), ...iterationViews(this.store, [storedTask]).get(storedTask.id) };
    // 与任务树 / 分支图同一口径：这条输入的 planner 带 input.route 事件就是快速路由。
    task.route = storedTask.input_id !== null && this.store.routedInputIds().has(storedTask.input_id);
    const resolution = task.task_kind === 'child' ? this.store.get(
      "SELECT data FROM events WHERE task_id=? AND type='task.divergence_resolution_requested' ORDER BY id DESC LIMIT 1", task.id) : null;
    // 首屏只给最新窗口；更早的调用与产物用 `runs_page` / `artifacts_page` 游标继续读取。
    const runs = bounded(progressRuns.length > RUN_WINDOW ? progressRuns.slice(-RUN_WINDOW) : progressRuns, 200000);
    const artifactsRead = this.store.artifactsPage(task.id, { limit: RUN_WINDOW });
    const artifacts = bounded(artifactsRead.items, 200000);
    return { ...task, goal_input_delivery: this.store.goalInputDelivery(taskId),
      ...(task.role === 'verifier' ? { verifies_task_worker_number: task.verifies_task_id
        ? this.store.get('SELECT worker_number FROM tasks WHERE id=?', task.verifies_task_id)?.worker_number ?? null : null } : {}),
      model_selection: workerModelSelection(this, this.store.task(taskId)),
      auto_merge: this.autoMergeView(storedTask), completion: this.autoCompletionView(storedTask), merge_readiness: this.mergeReadiness(storedTask),
      hooks: this.taskHooks(taskId),
      parent_task_kind: task.parent_id ? this.store.task(task.parent_id).task_kind : null,
      parent_worker_number: task.parent_id ? this.store.task(task.parent_id).worker_number : null,
      ...(resolution ? { divergence_resolution: { ...JSON.parse(resolution.data),
        branch_status: task.branch ? this.store.branch(task.branch)?.status ?? null : null } } : {}),
      deps: this.store.depsDetail(task.id), dependents: this.store.dependentsDetail(task.id),
      ...(task.role === 'planner' ? { specs: bounded(this.store.specsByPlanner(task.id), 200000) } : {}),
      ...(task.role === 'scheduler' ? { specs: bounded(this.store.specsForBatch(task.id), 200000) } : {}),
      children: bounded(this.decorate(this.store.all(`SELECT id,worker_number,parent_id,(SELECT p.worker_number FROM tasks p WHERE p.id=tasks.parent_id) AS parent_worker_number,
        input_id,role,substr(goal,1,200) AS goal,status,integration,layer,updated_at,
        agent_wakes,agent_last_seen_at,verifies_task_id,resolves_task_id,review_candidate_id,progress_plan,task_kind,reservation,interrupt_state
        FROM tasks WHERE parent_id=? ORDER BY id`, task.id)), 100000),
      messages: bounded(this.store.all(`${MESSAGE_SELECT} WHERE task_id=? ORDER BY id DESC LIMIT 100`, task.id), 200000),
      notices: bounded(this.store.all(`${NOTICE_SELECT} WHERE task_id=? ORDER BY id DESC LIMIT 100`, task.id), 200000),
      // worker 带着自己的检验记录与合并冲突处理记录；verifier 带着自己的报告路径。都是只读投影。
      verifications: task.role === 'worker' ? bounded(this.store.verifications(task.id).map(row => ({ ...row, has_report: this.hasReport(row.id) })), 200000) : undefined,
      resolutions: task.role === 'worker' ? bounded(this.store.resolutions(task.id), 200000) : undefined,
      report: task.role === 'verifier' && this.hasReport(task.id) ? this.reportPath(task.id) : null,
      runs,
      artifacts,
      runs_page: pageView(runsRead, runs, RUN_WINDOW),
      artifacts_page: pageView(artifactsRead, artifacts, RUN_WINDOW),
      agent: agentView(task, this.running.get(task.id) ?? null, progressRuns.at(-1) ?? null) };
  },

  diff(taskId) { return this.workspaces.diff(this.store.task(taskId)); }
};
