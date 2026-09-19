import { check, id, text, TERMINAL } from '../types.js';

/** 计划审批闸门。 */
export default {
  /**
   * planner 认为这一轮拆解需要用户先拍板（影响面大 / 与现状冲突 / 没把握完全读懂意图）时提出的审批。
   * 提出后这一批 spec 不再被 scheduler 取走，直到 plan.approve / plan.reject。
   */
  proposePlan(plannerId, title, body = '') {
    const planner = this.store.task(plannerId);
    check(planner.role === 'planner', 'only a planner proposes a plan (lush plan propose)');
    check(!TERMINAL.has(planner.status), 'planner has ended; submit a new intent instead');
    check(planner.plan_gate !== 'proposed', 'a plan approval is already pending for this planner');
    const specs = this.store.specsByPlanner(planner.id).filter(spec => spec.status === 'pending');
    check(specs.length > 0, 'write the specs first, then ask for approval (lush spec add ...)');
    const pending = this.store.get("SELECT id FROM notices WHERE task_id=? AND status='open' AND kind='plan'", planner.id);
    check(!pending, 'a plan approval is already open for this planner');
    return this.store.transaction(() => {
      this.store.update(planner.id, { plan_gate: 'proposed' });
      this.store.event(planner.id, 'plan.proposed', { specs: specs.map(spec => spec.id) });
      return this.notice(planner.id, title, body, 'plan');
    });
  },

  /** 用户批准这一轮拆解：闸门放行 → 下次 pump 就会把它交给 scheduler；planner 这一轮就此结束。 */
  approvePlan(plannerId, answer = '已批准') {
    const planner = this.planForApproval(plannerId);
    const specs = this.store.specsByPlanner(planner.id).filter(spec => spec.status === 'pending');
    this.store.transaction(() => {
      this.store.update(planner.id, { plan_gate: 'approved' });
      this.store.run("UPDATE notices SET status='answered',answer=? WHERE task_id=? AND status='open' AND kind='plan'", answer, planner.id);
      this.store.message(planner.id, JSON.stringify({ plan: planner.id, approved: true, answer, specs: specs.map(spec => spec.id) }));
      this.store.event(planner.id, 'plan.approved', { answer, specs: specs.map(spec => spec.id) });
    });
    // 计划被接受 = planner 这一轮的结论已经定了，它不必再跑一轮；编排由 scheduler 接着做。
    this.finish(planner.id, 'completed', `计划已批准（${specs.length} 条拆解交给 scheduler 编排）`);
    return { planner: planner.id, plan_gate: 'approved', specs: specs.map(spec => spec.id) };
  },

  /** 用户驳回：本轮 spec 全部作废，理由送给 planner 并唤醒它重拆（新的一轮、新的一批）。 */
  rejectPlan(plannerId, reason) {
    const planner = this.planForApproval(plannerId);
    text(reason, 'reason');
    const specs = this.store.specsByPlanner(planner.id).filter(spec => spec.status === 'pending');
    this.store.transaction(() => {
      this.store.update(planner.id, { plan_gate: 'rejected' });
      for (const spec of specs) this.store.dropSpec(spec.id, `计划被驳回：${reason}`);
      this.store.run("UPDATE notices SET status='dismissed',answer=? WHERE task_id=? AND status='open' AND kind='plan'", reason, planner.id);
      this.store.event(planner.id, 'plan.rejected', { reason, specs: specs.map(spec => spec.id) });
    });
    // 唤醒它重拆：理由走普通收件箱，下一轮 invocation 开头会把这个闸门清掉。
    this.message(planner.id, `上一轮拆解被驳回：${reason}\n\n请据此重拆，并重新写 spec（旧的那批已作废）。`);
    return { planner: planner.id, plan_gate: 'rejected', dropped_specs: specs.map(spec => spec.id) };
  },

  /** plan.approve / plan.reject 的入参：planner 任务 id 或那条 plan notice 的 id 都收。 */
  planForApproval(reference) {
    const value = id(reference);
    const notice = this.store.get("SELECT * FROM notices WHERE id=? AND kind='plan'", value);
    const planner = notice ? this.store.task(notice.task_id) : this.store.task(value);
    check(planner.role === 'planner', `task #${planner.id} is a ${planner.role}; only a planner has a plan to approve`);
    check(planner.plan_gate === 'proposed', `planner #${planner.id} has no plan waiting for approval`);
    return planner;
  }
};
