import { bounded } from '../../core/types.js';

/** spec.* / plan.* */
export const handlers = {
  'spec.list'(p, params, actor) { return bounded(p.store.specs({ limit: 1000 }), 900000); },
  'spec.add'(p, params, actor) { return p.addSpec(actor, { goal: params.goal, role: params.role ?? null, name: params.name ?? null, deps: params.deps ?? [] }); },
  'spec.drop'(p, params, actor) { return p.dropSpec(params.id, params.note ?? null, actor); },
  // planner 自己判断这轮拆解要不要先请你批准；approve/reject 是用户专属的闸门。
  'plan.propose'(p, params, actor) { return p.proposePlan(actor, params.title, params.body ?? ''); },
  'plan.approve'(p, params, actor) { return p.approvePlan(params.id, params.answer ?? '已批准'); },
  'plan.reject'(p, params, actor) { return p.rejectPlan(params.id, params.reason); },
};
