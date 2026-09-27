import { LushError, check, isPlainObject } from '../core/types.js';

// Public API for the AP-centred workflow. Historical rows remain on disk, but
// Intent/Plan/Candidate and optional services cannot create new work.
export const PARAMS = {
  'system.status': [], 'system.summary': [], 'system.stop': [], 'system.configure': ['settings'],
  'agent.config': [], 'agent.models': ['agent'], 'agent.resources': [], 'agent.configure': ['config'],
  'agent.environment': ['target'], 'agent.environment.configure': ['target','values'],
  'say.submit': ['content','branch','references'],
  'ap.graph': [], 'ap.list': ['after','limit'], 'ap.activity': ['limit','scope'],
  'ap.page': ['before','limit','scope'], 'ap.tree': ['id'], 'ap.inspect': ['id'],
  'ap.history': ['id','after'], 'ap.history_page': ['id','before','limit'], 'ap.diff': ['id'], 'ap.usage': ['id'],
  'ap.transcript': ['id','after','limit'], 'ap.transcript_latest': ['id','after','before','limit'],
  'ap.transcript_page': ['id','seq','offset'], 'ap.transcript_step': ['id','seq','offset'],
  'ap.transcript_search': ['id','query','kind','tool','errors','after','limit'],
  'ap.spawn': ['parent','goal','name'], 'ap.integrate': ['id','commit'],
  'ap.reserve': ['id','kind'], 'ap.resolve': ['id'], 'ap.resolve_divergence': ['id'],
  'ap.resolve_child_divergence': ['id'], 'ap.unreserve': ['id'],
  'ap.approve_merge': ['id','commit','baseline'], 'ap.message': ['id','body'],
  'ap.cancel': ['id'], 'ap.retry': ['id'], 'ap.cleanup': ['id','keep_branch'],
  'progress.plan': ['steps'], 'progress.complete': ['step'],
  'notice.list': [], 'notice.page': ['status','before','limit'],
  'notice.post': ['ap','title','body','questions'], 'notice.answer': ['id','answer'], 'notice.dismiss': ['id'],
  'branch.tree': [], 'branch.show': ['branch'], 'branch.bind': ['branch','commit'],
  'branch.archive': ['branch','discard'], 'graph.get': [],
};
export const USER_ONLY = new Set([
  'system.stop','system.configure','agent.configure','agent.environment','agent.environment.configure',
  'say.submit','ap.transcript_latest','ap.transcript_page','ap.transcript_step','ap.transcript_search',
  'ap.reserve','ap.resolve','ap.resolve_divergence','ap.unreserve','ap.approve_merge',
  'ap.cancel','ap.retry','ap.cleanup','notice.answer','notice.dismiss','branch.bind','branch.archive',
]);
export const AGENT_ONLY = new Set([
  'ap.integrate','ap.resolve_child_divergence','progress.plan','progress.complete',
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
