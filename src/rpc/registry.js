import { LushError, check, isPlainObject } from '../core/types.js';

// Public API for the Worker-centred workflow. Historical rows remain on disk, but
// Intent/Plan/Candidate and optional services cannot create new work.
export const PARAMS = {
  'system.status': [], 'system.summary': [], 'system.stop': [], 'system.stop_if_idle': [], 'system.configure': ['settings'],
  'agent.config': [], 'agent.models': ['agent'], 'agent.resources': [], 'agent.status': [], 'agent.configure': ['config'],
  'agent.environment': ['target'], 'agent.environment.configure': ['target','values'],
  'agent.usage.config': [], 'agent.usage.configure': ['config'], 'agent.usage.history': ['provider','account_key','days'],
  'say.submit': ['content','branch','references','start','draft_id','expected_revision'],
  'input.history': ['cursor','limit','q','status','integration'], 'input.get': ['kind','id'], 'input.parents': [],
  'draft.add': ['content','references','branch'], 'draft.update': ['id','content','references','branch','expected_revision'],
  'draft.remove': ['id','expected_revision'],
  'worker.graph': [], 'worker.list': ['after','limit'], 'worker.activity': ['limit','scope'],
  'worker.page': ['before','limit','scope'], 'worker.tree': ['id'], 'worker.inspect': ['id'],
  'worker.history': ['id','after'], 'worker.history_page': ['id','before','limit'], 'worker.diff': ['id'], 'worker.usage': ['id'],
  'worker.code_state': ['id','scope','after','limit'],
  'worker.code_tree': ['id','scope','path','query','changed','after','limit','revision'],
  'worker.code_file': ['id','scope','path','view','side','offset','limit','context','revision'],
  'worker.transcript': ['id','after','limit'], 'worker.transcript_latest': ['id','after','before','limit'],
  'worker.transcript_page': ['id','seq','offset'], 'worker.transcript_step': ['id','seq','offset'],
  'worker.transcript_search': ['id','query','kind','tool','errors','after','limit'],
  'worker.spawn': ['parent','goal','name'], 'worker.integrate': ['id','commit'],
  'worker.reserve': ['id','kind'], 'worker.reserve_all': ['branch'], 'worker.auto_merge': ['id','enabled'],
  'worker.resolve': ['id'], 'worker.resolve_divergence': ['id'],
  'worker.accept': ['id'], 'worker.reopen': ['id'], 'worker.sync_parent': ['id'], 'worker.resolve_sync': ['id'],
  'worker.resolve_child_divergence': ['id'], 'worker.unreserve': ['id'],
  'worker.approve_merge': ['id','commit','baseline'], 'worker.message': ['id','body'],
  'worker.cancel': ['id'], 'worker.retry': ['id'], 'worker.cleanup': ['id','keep_branch'],
  'worker.delete_preview': ['id'], 'worker.delete': ['id','revision','confirm'],
  'worker.interrupt': ['id'], 'worker.resume': ['id','profile'], 'worker.configure': ['id','profile'],
  'progress.plan': ['steps'], 'progress.complete': ['step'],
  'notice.list': [], 'notice.page': ['status','before','limit'],
  'notice.post': ['task','title','body','questions'], 'notice.answer': ['id','answer'], 'notice.dismiss': ['id'], 'notice.read': ['id'],
  'branch.history': ['cursor','limit'], 'branch.tree': [], 'branch.show': ['branch'], 'branch.bind': ['branch','commit'],
  'branch.archive': ['branch','discard'], 'graph.get': [],
};
export const USER_ONLY = new Set([
  'system.stop','system.stop_if_idle','system.configure','agent.configure','agent.status','agent.environment','agent.environment.configure',
  'branch.history','worker.code_state','worker.code_tree','worker.code_file',
  'agent.usage.config','agent.usage.configure','agent.usage.history',
  'input.history','input.get','input.parents','draft.add','draft.update','draft.remove',
  'say.submit','worker.transcript_latest','worker.transcript_page','worker.transcript_step','worker.transcript_search',
  'worker.reserve','worker.reserve_all','worker.auto_merge','worker.resolve','worker.resolve_divergence','worker.unreserve','worker.approve_merge',
  'worker.cancel','worker.retry','worker.cleanup','worker.interrupt','worker.resume','worker.configure',
  'worker.reopen','worker.sync_parent','worker.resolve_sync','worker.delete_preview','worker.delete',
  'notice.answer','notice.dismiss','notice.read','branch.bind','branch.archive',
]);
export const AGENT_ONLY = new Set([
  'worker.integrate','worker.resolve_child_divergence','progress.plan','progress.complete',
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
