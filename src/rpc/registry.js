import { LushError, check, isPlainObject } from '../core/types.js';

export const PARAMS = {
  'system.usage': ['start','end','interval'], 'system.status': [], 'system.summary': [], 'system.stop': [], 'system.timeline': ['limit'], 'system.configure': ['settings'], 'agent.config': [], 'agent.models': ['agent'], 'agent.resources': [], 'agent.environment': ['target'], 'agent.environment.configure': ['target','values'], 'agent.configure': ['config'],
  'input.submit': ['content','branch','references','direct'], 'input.list': [], 'input.flow': ['id','flow'],
  'draft.add': ['content','references'], 'draft.list': [], 'draft.remove': ['id'], 'draft.update': ['id','content','references'], 'draft.commit': ['ids','branch'],
  'task.list': ['after','limit'], 'task.activity': ['limit','scope'], 'task.page': ['before','limit','scope'], 'task.tree': ['id'], 'task.inspect': ['id'], 'task.history': ['id','after'], 'task.history_page': ['id','before','limit'], 'task.diff': ['id'],
  'task.transcript': ['id','after','limit'], 'task.usage': ['id'],
  'task.transcript_latest': ['id','after','before','limit'],
  'task.transcript_page': ['id','seq','offset'],
  'task.transcript_search': ['id','query','kind','tool','errors','after','limit'], 'task.transcript_step': ['id','seq','offset'],
  'explanation.start': ['id','seq','quote'], 'explanation.selection': ['quote','location'], 'explanation.list': ['id','before'], 'explanation.get': ['id'],
  'progress.plan': ['steps'], 'progress.complete': ['step'],
  'task.spawn': ['parent','goal','role','deps','name','spec'], 'task.message': ['id','body'], 'task.cancel': ['id'], 'task.retry': ['id','profile'],
  'task.merge': ['id'], 'task.merge_many': ['ids'], 'task.cleanup': ['id','keep_branch'], 'task.verify': ['id'], 'task.delete': ['id'], 'task.clear': [], 'task.ladder': [],
  'spec.list': [], 'spec.add': ['goal','role','name','deps'], 'spec.drop': ['id','note'],
  'candidate.list': ['input'], 'candidate.inspect': ['id'], 'candidate.prepare': ['input','summary'], 'candidate.verify': ['id'],
  'candidate.accept': ['id'], 'candidate.changes': ['id','feedback'], 'candidate.reject': ['id','reason'],
  'showcase.start': ['branch','baseline'], 'showcase.list': ['branch'], 'showcase.stop': ['id'], 'showcase.preview': ['command','path'],
  'graph.get': [],
  'branch.tree': [], 'branch.show': ['branch'], 'branch.import': [], 'branch.merge': ['branch'], 'branch.sync': ['branch'], 'branch.catchup': ['branch'],
  'branch.archive': ['branch','discard'], 'branch.summary': ['branch','summary'],
  'plan.propose': ['title','body'], 'plan.approve': ['id','answer'], 'plan.reject': ['id','reason'],
  'notice.list': [], 'notice.page': ['status','before','limit'], 'notice.post': ['task','title','body','questions'], 'notice.answer': ['id','answer'], 'notice.dismiss': ['id'],
};
export const USER_ONLY = new Set(['task.transcript_latest','task.transcript_page','task.transcript_search','task.transcript_step','explanation.start','explanation.selection','explanation.list','explanation.get','showcase.start','showcase.stop','system.usage','system.stop','system.configure','agent.configure','agent.environment','agent.environment.configure','input.submit','draft.add','draft.remove','draft.update','draft.commit','task.cancel','task.retry','task.merge','task.merge_many','task.cleanup','task.verify','task.delete','task.clear','notice.answer','notice.dismiss','plan.approve','plan.reject','candidate.prepare','candidate.verify','candidate.accept','candidate.changes','candidate.reject','branch.import','branch.merge','branch.sync','branch.catchup','branch.archive']);
/** 拆解队列与计划审批由 agent 写入；用户只能查看（lush spec list / lush intents），批不批走 plan.approve|reject。 */
export const AGENT_ONLY = new Set(['showcase.preview','spec.add','spec.drop','plan.propose','progress.plan','progress.complete']);
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
