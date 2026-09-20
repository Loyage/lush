import { LushError, check, isPlainObject } from '../core/types.js';

export const PARAMS = {
  'system.status': [], 'system.stop': [], 'system.timeline': ['limit'], 'input.submit': ['content','branch'], 'input.list': [], 'input.flow': ['id','flow'],
  'draft.add': ['content'], 'draft.list': [], 'draft.remove': ['id'], 'draft.update': ['id','content'], 'draft.commit': ['ids','branch'],
  'task.list': ['after','limit'], 'task.tree': ['id'], 'task.inspect': ['id'], 'task.history': ['id','after'], 'task.diff': ['id'],
  'task.transcript': ['id','after','limit'], 'task.usage': ['id'],
  'task.spawn': ['parent','goal','role','deps','name','spec'], 'task.message': ['id','body'], 'task.cancel': ['id'], 'task.retry': ['id'],
  'task.merge': ['id'], 'task.merge_many': ['ids'], 'task.cleanup': ['id','keep_branch'], 'task.verify': ['id'], 'task.clear': [], 'task.ladder': [],
  'spec.list': [], 'spec.add': ['goal','role','name','deps'], 'spec.drop': ['id','note'],
  'graph.get': [],
  'branch.tree': [], 'branch.show': ['branch'], 'branch.import': [], 'branch.merge': ['branch'], 'branch.sync': ['branch'], 'branch.catchup': ['branch'],
  'branch.archive': ['branch','discard'],
  'plan.propose': ['title','body'], 'plan.approve': ['id','answer'], 'plan.reject': ['id','reason'],
  'notice.list': [], 'notice.post': ['task','title','body'], 'notice.answer': ['id','answer'], 'notice.dismiss': ['id'],
};
export const USER_ONLY = new Set(['system.stop','input.submit','draft.add','draft.remove','draft.update','draft.commit','task.cancel','task.retry','task.merge','task.merge_many','task.cleanup','task.verify','task.clear','notice.answer','notice.dismiss','plan.approve','plan.reject','branch.import','branch.merge','branch.sync','branch.catchup','branch.archive']);
/** 拆解队列与计划审批由 agent 写入；用户只能查看（lush spec list / lush intents），批不批走 plan.approve|reject。 */
export const AGENT_ONLY = new Set(['spec.add','spec.drop','plan.propose']);
/**
 * 统一的请求校验：params 是对象 → 方法在白名单 → 未知参数 → actor → USER_ONLY → AGENT_ONLY。
 * actor 解析有副作用（touchAgent），所以第三参允许传惰性 resolver：只有前三步都通过才会解析身份。
 */
export function assertAllowed(method, params, actor) {
  check(isPlainObject(params), 'params must be an object');
  if (!Object.hasOwn(PARAMS, method)) throw new LushError(`unknown method: ${method}`, -32601);
  check(Object.keys(params).every(key => key === '_token' || PARAMS[method].includes(key)), 'unknown parameter');
  const who = typeof actor === 'function' ? actor() : actor;
  check(who === null || !USER_ONLY.has(method), `${method} requires user approval, not an agent`);
  check(!(who === null && AGENT_ONLY.has(method)), `${method} is planner/agent only; users inspect the queue with lush spec list`);
  return who;
}
