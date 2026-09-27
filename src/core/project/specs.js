import { check, id, text, isPlainObject } from '../types.js';
import { apSlug } from '../naming.js';
import { DEP_KINDS } from './aps.js';

/** 一个 planner 一轮能攒下的 pending spec 上限；一批也按它取，所以一轮拆解不会被截成两批。 */
const MAX_BATCH_SPECS = 200;

/** 拆解队列与批次的出生。 */
export default {
  /**
   * Compile every finished planner round directly into work items. Planning is semantic model work; scheduling is
   * deterministic runtime work, so there is no scheduler agent, global batch lock or extra model invocation.
   */
  compilePlans() {
    const groups = this.store.readySpecPlanners(MAX_BATCH_SPECS);
    const compiled = [];
    for (const group of groups) {
      const planner = this.store.ap(group.planner_ap_id);
      const pending = this.store.specsByPlanner(planner.id).filter(spec => spec.status === 'pending' && spec.batch_id === null);
      const waiting = new Map(pending.map(spec => [spec.id, spec]));
      const created = [];
      while (waiting.size) {
        let progressed = false;
        for (const spec of [...waiting.values()]) {
          const deps = spec.deps.map(hint => this.store.spec(hint.spec));
          const dropped = deps.find(dep => dep.status === 'dropped');
          if (dropped) {
            this.store.dropSpec(spec.id, `依赖 spec #${dropped.id} 已丢弃，无法编译`);
            waiting.delete(spec.id); progressed = true; continue;
          }
          if (deps.some(dep => dep.ap_id === null)) continue;
          try {
            const ap = this.store.transaction(() => this.materializeSpec(planner.id, spec.id));
            created.push(ap);
          } catch (error) {
            this.store.dropSpec(spec.id, `计划编译失败：${error.message}`);
            this.store.event(planner.id, 'plan.compile_failed', { spec: spec.id, error: error.message });
          }
          waiting.delete(spec.id); progressed = true;
        }
        check(progressed, `planner #${planner.id} has an unresolved spec dependency cycle`);
      }
      if (created.length) {
        this.store.event(planner.id, 'plan.compiled', { specs: pending.map(spec => spec.id), aps: created.map(ap => ap.id) });
        compiled.push({ planner: planner.id, aps: created });
      }
    }
    return compiled;
  },

  /** Compatibility alias for older embedders; it no longer creates a scheduler ap. */
  ensureScheduler() { return this.compilePlans(); },

  /** planner 只写队列：把一条拆解结果变成 ap_specs 行，同样只允许引用自己写的 spec。 */
  addSpec(plannerAPId, spec = {}) {
    const planner = this.store.ap(plannerAPId);
    check(planner.role === 'planner', 'only a planner writes to the spec queue (lush spec add)');
    text(spec.goal, 'goal');
    const role = spec.role ?? null;
    check(role === null || ['worker','coordinator','research'].includes(role), 'spec role must be worker, coordinator or research');
    const name = spec.name ?? null;
    const slug = apSlug(name, spec.goal);
    const deps = spec.deps ?? [];
    check(Array.isArray(deps) && deps.length <= 32, 'at most 32 spec dependencies');
    const hints = [];
    for (const raw of deps) {
      const value = isPlainObject(raw) ? raw : { spec: raw };
      const specId = id(value.spec);
      const kind = value.kind ?? 'code';
      check(DEP_KINDS.has(kind), 'spec dependency kind must be code or order');
      check(!hints.some(hint => hint.spec === specId), `duplicate spec dependency on #${specId}`);
      const target = this.store.spec(specId);
      check(target.planner_ap_id === planner.id, `spec #${specId} belongs to another planner; link only your own specs`);
      hints.push({ spec: specId, kind });
    }
    const pending = this.store.get("SELECT count(*) AS n FROM ap_specs WHERE planner_ap_id=? AND status='pending'", planner.id).n;
    check(pending < MAX_BATCH_SPECS, `a planner may hold at most ${MAX_BATCH_SPECS} pending specs in one round`);
    const row = this.store.addSpec({ input_id: planner.input_id, planner_ap_id: planner.id, goal: spec.goal, role, name: slug, deps: hints });
    this.store.event(planner.id, 'spec.added', { spec_id: row.id, role, name: slug, deps: hints });
    this.kick();
    return row;
  },

  /** Only the planner that wrote a pending spec may drop it. Historical scheduler batches remain readable. */
  dropSpec(specId, note = null, actor = null) {
    const spec = this.store.spec(specId);
    check(spec.status === 'pending', `spec #${spec.id} is ${spec.status}; only a pending spec can be dropped`);
    if (actor !== null) {
      const owner = actor === spec.planner_ap_id || (spec.batch_id !== null && actor === spec.batch_id);
      check(owner, `AP #${actor} may not drop spec #${spec.id}`);
    }
    if (note !== null && note !== undefined) text(note, 'note');
    this.store.dropSpec(spec.id, note ?? null);
    this.store.event(actor ?? spec.planner_ap_id, 'spec.dropped', { spec_id: spec.id, note: note ?? null });
    return this.store.spec(spec.id);
  }
};
