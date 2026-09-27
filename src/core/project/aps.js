import { check, id, text, TERMINAL, bounded, isPlainObject } from '../types.js';
import { apSlug } from '../naming.js';
import { agentView } from './internal.js';
import fs from 'node:fs';
import { saveInputRule, snapshotPath } from '../ap-input-rule.js';

export const DEP_KINDS = new Set(['code', 'order']);
function normalizeDeps(deps) {
  check(Array.isArray(deps), 'deps must be an array');
  check(deps.length <= 32, 'at most 32 dependencies per AP');
  const edges = [];
  for (const raw of deps) {
    const value = isPlainObject(raw) ? raw : { id: raw };
    const kind = value.kind ?? 'code';
    check(DEP_KINDS.has(kind), 'dependency kind must be code or order');
    const depId = id(value.id);
    check(!edges.some(edge => edge.id === depId), `duplicate dependency on AP ${depId}`);
    edges.push({ id: depId, kind });
  }
  return edges;
}

/** 派生 AP 与单 AP 详情。 */
export default {
  /** name is the planner's short slug for the work; it becomes the branch/worktree name and stays fixed for the AP's life. */
  spawn(parentId, goal, role = undefined, deps = [], name = null, specId = null) {
    this.assertWritable('delegate an AP');
    const parent = this.store.ap(parentId);
    check(!['main','owner'].includes(parent.ap_kind), 'branch owner APs accept new say APs, not unrestricted spawned work');
    check(parent.ap_kind !== 'analysis', 'read-only analysis APs do not delegate; ask a new question instead');
    const apKind = ['say','child'].includes(parent.ap_kind) ? 'child' : null;
    check(apKind === 'child', 'only say/child APs can delegate');
    check(role === undefined || role === 'agent', 'child role must be agent');
    check(Array.isArray(deps) && deps.length === 0 && specId === null, 'legacy deps and specs are not supported');
    if (parent.branch) this.assertBranchWritable(parent.branch, 'delegate more work while resolving divergence');
    role = 'agent';
    check(!TERMINAL.has(parent.status), 'cannot delegate from a terminal AP');
    check(!['showcase', 'explainer', 'butler'].includes(parent.role), 'showcase and explanation agents cannot delegate development work');
    check(parent.role !== 'planner', 'planner 不再直接派活；用 lush spec add 写拆解队列，由 scheduler 编排');
    text(goal, 'goal');
    check(apKind ? role === 'agent' : ['worker','coordinator','research'].includes(role),
      apKind ? 'new AP agents can only delegate an AP agent' : 'role must be worker, coordinator or research');
    check(!apKind || specId === null, 'new AP agents do not compile planner specs');
    const edges = normalizeDeps(deps);
    check(!apKind || edges.length === 0, 'new AP children use parent signals, not legacy dependency edges');
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
        check(target.ap_id !== null, `spec #${hint.spec} has not been spawned yet; spawn the dependency before spec #${spec.id}`);
        const existing = resolved.get(target.ap_id);
        if (existing !== undefined) check(existing === hint.kind, `conflicting dependency on AP #${target.ap_id}: explicit ${existing} vs spec hint ${hint.kind}`);
        else resolved.set(target.ap_id, hint.kind);
      }
    } else {
      check(parent.role !== 'scheduler', 'a scheduler must spawn every spec with --spec SPEC_ID; the spec queue is its only input');
    }
    const merged = [...resolved].map(([edgeId, kind]) => ({ id: edgeId, kind }));
    const inheritedInput = parent.input_id ?? (spec ? spec.input_id : null);
    let depth = 1, ancestor = parent;
    while (ancestor.parent_id) { ancestor = this.store.ap(ancestor.parent_id); depth++; }
    check(depth < this.config.maxDepth, 'AP nesting limit reached');
    check(this.store.get("SELECT count(*) AS n FROM aps WHERE status NOT IN ('completed','failed','cancelled')").n < 1000, 'too many active aps');
    const slug = apSlug(name, goal);
    const parentRule = apKind && fs.existsSync(snapshotPath(this.config.home, parent.id))
      ? fs.readFileSync(snapshotPath(this.config.home, parent.id), 'utf8') : null;
    let ruleAPId = null;
    let ap;
    try { ap = this.store.transaction(() => {
      const created = this.store.create({ parent_id: parent.id, input_id: inheritedInput, role, goal, name: slug, ap_kind: apKind });
      this.assertDeps(created.id, parent, merged);
      if (parentRule !== null) {
        ruleAPId = created.id;
        saveInputRule(this.config.home, created.id, parentRule);
        this.store.event(created.id, 'ap.input_rule_frozen', { inherited_from: parent.id });
      }
      for (const edge of merged) { this.store.addDep(created.id, edge.id, edge.kind); this.store.event(created.id, 'dep.added', edge); }
      if (spec) this.store.plannedSpec(spec.id, created.id);
      return created;
    }); } catch (error) {
      if (ruleAPId !== null) fs.rmSync(snapshotPath(this.config.home, ruleAPId), { force: true });
      throw error;
    }
    this.kick(); return ap;
  },

  /** Deterministic Plan compiler path: turn one planner spec into a root work item without another model call. */
  materializeSpec(plannerId, specId) {
    const planner = this.store.ap(plannerId);
    check(planner.role === 'planner', 'only a planner plan can be compiled');
    const spec = this.store.spec(specId);
    check(spec.planner_ap_id === planner.id, `spec #${spec.id} belongs to another planner`);
    check(spec.status === 'pending', `spec #${spec.id} is ${spec.status}; only pending specs are compiled`);
    const role = spec.role ?? 'worker';
    check(['worker','coordinator','research'].includes(role), `spec #${spec.id} has invalid role ${role}`);
    const edges = spec.deps.map(hint => {
      const target = this.store.spec(hint.spec);
      check(target.status !== 'dropped', `spec #${hint.spec} was dropped; spec #${spec.id} cannot be compiled`);
      check(target.ap_id !== null, `spec #${hint.spec} has not been compiled yet`);
      return { id: target.ap_id, kind: hint.kind };
    });
    check(this.store.get("SELECT count(*) AS n FROM aps WHERE status NOT IN ('completed','failed','cancelled')").n < 1000,
      'too many active aps');
    const ap = this.store.create({ parent_id: null, input_id: spec.input_id, role, goal: spec.goal, name: spec.name });
    this.assertDeps(ap.id, null, edges);
    for (const edge of edges) { this.store.addDep(ap.id, edge.id, edge.kind); this.store.event(ap.id, 'dep.added', edge); }
    this.store.plannedSpec(spec.id, ap.id);
    this.store.event(ap.id, 'plan.materialized', { planner: planner.id, spec: spec.id });
    return ap;
  },

  /** AP window: active items plus a bounded terminal tail; all includes control-plane roles. */
  activity(limit = 50, scope = 'work') {
    check(['work', 'all'].includes(scope), 'invalid AP scope');
    const size = Number(limit);
    check(Number.isInteger(size) && size >= 1 && size <= 200, 'activity limit must be 1..200');
    const active = this.store.summaryPage({ active: true, limit: 1000, scope });
    const recent = this.store.summaryPage({ limit: size, scope });
    const byId = new Map([...active, ...recent].map(ap => [ap.id, ap]));
    const aps = this.decorate([...byId.values()].sort((a, b) => a.id - b.id));
    const cursor = recent.length ? Math.min(...recent.map(ap => ap.id)) : null;
    const counts = this.store.all(`SELECT status,count FROM overview_ap_counts WHERE ${scope === 'all' ? "layer IN ('work','intent')" : "layer='work'"} AND count>0`);
    const total = counts.reduce((sum, row) => sum + row.count, 0);
    const historical = counts.filter(row => TERMINAL.has(row.status)).reduce((sum, row) => sum + row.count, 0);
    return { aps, page: { limit: size, cursor, has_more: cursor !== null && historical > recent.length,
      shown: recent.length, total, historical, active: active.length, truncated: historical > recent.length } };
  },

  /** Older terminal items within the requested scope; callers merge pages by id. */
  apPage(before = null, limit = 50, scope = 'work') {
    check(['work', 'all'].includes(scope), 'invalid AP scope');
    const cursor = before === null || before === undefined ? null : Number(before);
    const size = Number(limit);
    check(cursor === null || (Number.isSafeInteger(cursor) && cursor > 0), 'invalid AP history cursor');
    check(Number.isInteger(size) && size >= 1 && size <= 200, 'ap history limit must be 1..200');
    const rows = this.store.summaryPage({ before: cursor, limit: size + 1, scope });
    const hasMore = rows.length > size;
    const page = rows.slice(0, size);
    return { aps: this.decorate(page.sort((a, b) => a.id - b.id)), cursor: page.length ? Math.min(...page.map(ap => ap.id)) : cursor,
      has_more: hasMore, limit: size, truncated: hasMore };
  },

  inspect(apId) {
    // retry_profile may contain a replacement system prompt and local resource paths. It is
    // runtime configuration, not part of the AP read model (agents can call ap.inspect).
    const { retry_profile: _retryProfile, ...storedAP } = this.store.ap(apId);
    // 详情页要显示工作用时与等待行：先取这一轮的调用区间，计划时长才能只算真正运行的时间。
    const runs = this.store.runsForAP(storedAP.id);
    const ap = this.progressView(storedAP, runs);
    // 与 AP 树 / 分支图同一口径：这条输入的 planner 带 input.route 事件就是快速路由。
    ap.route = storedAP.input_id !== null && this.store.routedInputIds().has(storedAP.input_id);
    const resolution = ap.ap_kind === 'child' ? this.store.get(
      "SELECT data FROM events WHERE ap_id=? AND type='ap.divergence_resolution_requested' ORDER BY id DESC LIMIT 1", ap.id) : null;
    return { ...ap, parent_ap_kind: ap.parent_id ? this.store.ap(ap.parent_id).ap_kind : null,
      ...(resolution ? { divergence_resolution: { ...JSON.parse(resolution.data),
        branch_status: ap.branch ? this.store.branch(ap.branch)?.status ?? null : null } } : {}),
      deps: this.store.depsDetail(ap.id), dependents: this.store.dependentsDetail(ap.id),
      ...(ap.role === 'planner' ? { specs: bounded(this.store.specsByPlanner(ap.id), 200000) } : {}),
      ...(ap.role === 'scheduler' ? { specs: bounded(this.store.specsForBatch(ap.id), 200000) } : {}),
      children: bounded(this.decorate(this.store.summaries().filter(child => child.parent_id === ap.id)), 100000),
      messages: bounded(this.store.all('SELECT * FROM messages WHERE ap_id=? ORDER BY id DESC LIMIT 100', ap.id), 200000),
      notices: bounded(this.store.all('SELECT * FROM notices WHERE ap_id=? ORDER BY id DESC LIMIT 100', ap.id), 200000),
      // worker 带着自己的检验记录与合并冲突处理记录；verifier 带着自己的报告路径。都是只读投影。
      verifications: ap.role === 'worker' ? bounded(this.store.verifications(ap.id).map(row => ({ ...row, has_report: this.hasReport(row.id) })), 200000) : undefined,
      resolutions: ap.role === 'worker' ? bounded(this.store.resolutions(ap.id), 200000) : undefined,
      report: ['verifier','showcase'].includes(ap.role) && this.hasReport(ap.id) ? this.reportPath(ap.id) : null,
      ...(ap.role === 'showcase' ? { showcase: this.showcaseContext(ap) } : {}),
      runs: bounded(runs, 200000),
      artifacts: bounded(this.store.artifactsForAP(ap.id), 200000),
      agent: agentView(ap, this.running.get(ap.id) ?? null, runs.at(-1) ?? null) };
  },

  diff(apId) { return this.workspaces.diff(this.store.ap(apId)); }
};
