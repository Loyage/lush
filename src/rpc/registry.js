import { LushError, check, isPlainObject } from '../core/types.js';

// Public API for the Task-centred workflow. Historical rows remain on disk, but
// Intent/Plan/Candidate and optional services cannot create new work.
export const PARAMS = {
  'system.status': [], 'system.summary': [], 'system.stop': [], 'system.stop_if_idle': [], 'system.configure': ['settings'],
  'agent.config': [], 'agent.models': ['agent'], 'agent.resources': [], 'agent.status': [], 'agent.configure': ['config'],
  'agent.environment': ['target'], 'agent.environment.configure': ['target','values'],
  'say.submit': ['content','branch','references','start'],
  'task.graph': [], 'task.list': ['after','limit'], 'task.activity': ['limit','scope'],
  'task.page': ['before','limit','scope'], 'task.tree': ['id'], 'task.inspect': ['id'],
  'task.history': ['id','after'], 'task.history_page': ['id','before','limit'], 'task.diff': ['id'], 'task.usage': ['id'],
  'task.transcript': ['id','after','limit'], 'task.transcript_latest': ['id','after','before','limit'],
  'task.transcript_page': ['id','seq','offset'], 'task.transcript_step': ['id','seq','offset'],
  'task.transcript_search': ['id','query','kind','tool','errors','after','limit'],
  'task.spawn': ['parent','goal','name'], 'task.integrate': ['id','commit'],
  'task.reserve': ['id','kind'], 'task.reserve_all': ['branch'],
  'task.resolve': ['id'], 'task.resolve_divergence': ['id'],
  'task.accept': ['id'], 'task.reopen': ['id'], 'task.sync_parent': ['id'], 'task.resolve_sync': ['id'],
  'task.resolve_child_divergence': ['id'], 'task.unreserve': ['id'],
  'task.approve_merge': ['id','commit','baseline'], 'task.message': ['id','body'],
  'task.cancel': ['id'], 'task.retry': ['id'], 'task.cleanup': ['id','keep_branch'],
  'task.interrupt': ['id'], 'task.resume': ['id','profile'], 'task.configure': ['id','profile'],
  'progress.plan': ['steps'], 'progress.complete': ['step'],
  'notice.list': [], 'notice.page': ['status','before','limit'],
  'notice.post': ['task','title','body','questions'], 'notice.answer': ['id','answer'], 'notice.dismiss': ['id'],
  'branch.tree': [], 'branch.show': ['branch'], 'branch.bind': ['branch','commit'],
  'branch.archive': ['branch','discard'], 'graph.get': [],
};
export const USER_ONLY = new Set([
  'system.stop','system.stop_if_idle','system.configure','agent.configure','agent.status','agent.environment','agent.environment.configure',
  'say.submit','task.transcript_latest','task.transcript_page','task.transcript_step','task.transcript_search',
  'task.reserve','task.reserve_all','task.resolve','task.resolve_divergence','task.unreserve','task.approve_merge',
  'task.cancel','task.retry','task.cleanup','task.interrupt','task.resume','task.configure',
  'task.accept','task.reopen','task.sync_parent','task.resolve_sync',
  'notice.answer','notice.dismiss','branch.bind','branch.archive',
]);
export const AGENT_ONLY = new Set([
  'task.integrate','task.resolve_child_divergence','progress.plan','progress.complete',
]);
export function assertAllowed(method, params, actor) {
  check(isPlainObject(params), 'params must be an object');
  if (!Object.hasOwn(PARAMS, method)) throw new LushError(`unknown method: ${method}`, -32601);
  check(Object.keys(params).every(key => key === '_token' || PARAMS[method].includes(key)), 'unknown parameter');
  const who = typeof actor === 'function' ? actor() : actor;
  check(who === null || !USER_ONLY.has(method), `${method} requires user approval, not an agent`);
  check(!(who === null && AGENT_ONLY.has(method)), `${method} is agent only`);
  return who;
}
