import { check, id, text, isPlainObject } from '../types.js';
import { taskSlug } from '../naming.js';
import { DEP_KINDS } from './tasks.js';

/** 一个 planner 一轮能攒下的 pending spec 上限；一批也按它取，所以一轮拆解不会被截成两批。 */
const MAX_BATCH_SPECS = 200;

/** 拆解队列与批次的出生。 */
export default {
  /**
   * The one place a scheduler task is born: a planner has finished its round and no live scheduler owns the queue.
   * 批次 = 那个 planner 这一轮写下的全部 spec，所以等待只由「planner 结束」触发，不由写入时刻决定。
   */
  ensureScheduler() {
    const group = this.store.nextSpecPlanner();
    if (!group) return null;
    if (this.store.get("SELECT id FROM tasks WHERE role='scheduler' AND status NOT IN ('completed','failed','cancelled')")) return null;
    return this.store.transaction(() => {
      const task = this.store.create({ input_id: null, role: 'scheduler', name: null,
        goal: `调度拆解队列：planner #${group.planner_task_id} 写下的 ${group.count} 条 spec，一次性编排完本批（不允许遗留）` });
      this.store.assignSpecs(task.id, MAX_BATCH_SPECS, group.planner_task_id);
      return task;
    });
  },

  /** planner 只写队列：把一条拆解结果变成 task_specs 行，同样只允许引用自己写的 spec。 */
  addSpec(plannerTaskId, spec = {}) {
    const planner = this.store.task(plannerTaskId);
    check(planner.role === 'planner', 'only a planner writes to the spec queue (lush spec add)');
    text(spec.goal, 'goal');
    const role = spec.role ?? null;
    check(role === null || ['worker','coordinator','research'].includes(role), 'spec role must be worker, coordinator or research');
    // explain 输入只允许写 research 的 spec，否则 scheduler 一定会 spawn 出一个被拒的任务。
    const flowInput = planner.input_id === null ? null : this.store.get('SELECT id, flow FROM inputs WHERE id=?', planner.input_id);
    check(!flowInput || flowInput.flow !== 'explain' || role === 'research',
      `input #${flowInput?.id} is classified as explain (了解); only research specs are allowed`);
    const name = spec.name ?? null;
    const slug = taskSlug(name, spec.goal);
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
      check(target.planner_task_id === planner.id, `spec #${specId} belongs to another planner; link only your own specs`);
      hints.push({ spec: specId, kind });
    }
    const pending = this.store.get("SELECT count(*) AS n FROM task_specs WHERE planner_task_id=? AND status='pending'", planner.id).n;
    check(pending < MAX_BATCH_SPECS, `a planner may hold at most ${MAX_BATCH_SPECS} pending specs; let the scheduler drain the queue first`);
    const row = this.store.addSpec({ input_id: planner.input_id, planner_task_id: planner.id, goal: spec.goal, role, name: slug, deps: hints });
    this.store.event(planner.id, 'spec.added', { spec_id: row.id, role, name: slug, deps: hints });
    this.kick();
    return row;
  },

  /** Only the planner that wrote a pending spec, or the scheduler holding its batch, may drop it. */
  dropSpec(specId, note = null, actor = null) {
    const spec = this.store.spec(specId);
    check(spec.status === 'pending', `spec #${spec.id} is ${spec.status}; only a pending spec can be dropped`);
    if (actor !== null) {
      const owner = actor === spec.planner_task_id || (spec.batch_id !== null && actor === spec.batch_id);
      check(owner, `task #${actor} may not drop spec #${spec.id}`);
    }
    if (note !== null && note !== undefined) text(note, 'note');
    this.store.dropSpec(spec.id, note ?? null);
    this.store.event(actor ?? spec.planner_task_id, 'spec.dropped', { spec_id: spec.id, note: note ?? null });
    return this.store.spec(spec.id);
  }
};
