import { LushError, check, isPlainObject } from '../core/types.js';

// Public API for the Worker-centred workflow. Historical rows remain on disk, but
// Intent/Plan/Candidate and optional services cannot create new work.
export const PARAMS = {
  'system.status': [], 'system.summary': [], 'system.stop': [], 'system.stop_if_idle': [], 'system.configure': ['settings'],
  'agent.config': [], 'agent.models': ['agent'], 'agent.resources': [], 'agent.status': [], 'agent.configure': ['config'],
  'agent.network': [], 'agent.network.configure': ['config'],
  'agent.environment': ['target'], 'agent.environment.configure': ['target','values'],
  'agent.usage.config': [], 'agent.usage.configure': ['config'], 'agent.usage.history': ['provider','account_key','days'],
  'agent.selection.resources': [],
  'agent.connections.list': [], 'agent.connections.save': ['connection','credential'], 'agent.connections.remove': ['id'],
  'agent.connections.sampling': ['sampling'], 'agent.connections.query': ['id'], 'agent.connections.history': ['id','days'],
  'agent.connections.login.start': ['id'], 'agent.connections.login.finish': ['id','login_id','redirect_url'],
  'agent.connections.device.start': ['id'], 'agent.connections.device.poll': ['id','login_id'], 'agent.connections.device.cancel': ['id','login_id'],
  'agent.connections.models': ['id'], 'agent.connections.models.refresh': ['id'],
  'agent.packages.list': [], 'agent.packages.install': ['source'], 'agent.packages.remove': ['id'], 'agent.packages.update': ['id'],
  'quick_explain.config': [], 'quick_explain.configure': ['config'],
  'quick_explain.start': ['quote','location'], 'quick_explain.get': ['id'], 'quick_explain.list': ['before','limit'],
  'hooks.list': [], 'hooks.save': ['template','expected_revision'], 'hooks.remove': ['id','expected_revision'],
  'worker.hooks': ['id'], 'worker.hook_attach': ['id','hook','expected_revision'],
  'worker.hook_update': ['id','hook_id','enabled','expected_revision'], 'worker.hook_remove': ['id','hook_id','expected_revision'],
  'order.submit': ['content','branch','references','start','draft_id','expected_revision','profile','defer'],
  'input.history': ['cursor','limit','q','status','integration'], 'input.get': ['kind','id'], 'input.parents': [],
  'draft.add': ['content','references','branch'], 'draft.update': ['id','content','references','branch','expected_revision'],
  'draft.remove': ['id','expected_revision'],
  'worker.lookup': ['number'], 'worker.graph': [], 'worker.list': ['after','limit'], 'worker.activity': ['limit','scope'],
  'worker.page': ['before','limit','scope'], 'worker.tree': ['id'], 'worker.inspect': ['id'],
  'worker.history': ['id','after'], 'worker.history_page': ['id','before','limit'], 'worker.diff': ['id'], 'worker.usage': ['id'],
  'worker.code_state': ['id','scope','after','limit'],
  'worker.code_tree': ['id','scope','path','query','changed','after','limit','revision'],
  'worker.code_file': ['id','scope','path','view','side','offset','limit','context','revision'],
  'worker.transcript': ['id','after','limit'], 'worker.transcript_latest': ['id','after','before','limit'],
  'worker.transcript_page': ['id','seq','offset'], 'worker.transcript_step': ['id','seq','offset'],
  'worker.transcript_search': ['id','query','kind','tool','errors','after','limit'],
  'worker.runs_page': ['id','before','limit'], 'worker.artifacts_page': ['id','before','limit'], 'worker.artifact': ['id'],
  'worker.spawn': ['parent','goal','name'], 'worker.integrate': ['id','commit'],
  'worker.reserve': ['id','kind'], 'worker.reserve_all': ['branch'], 'worker.auto_merge': ['id','enabled'],
  'worker.resolve': ['id'], 'worker.resolve_divergence': ['id'],
  'worker.accept': ['id'], 'worker.reopen': ['id'], 'worker.sync_parent': ['id'], 'worker.resolve_sync': ['id'],
  'worker.resolve_child_divergence': ['id'], 'worker.unreserve': ['id'],
  'worker.approve_merge': ['id','commit','baseline'], 'worker.message': ['id','body'],
  'worker.cancel': ['id'], 'worker.retry': ['id','profile'], 'worker.clear_override': ['id'], 'worker.cleanup': ['id','keep_branch'],
  'worker.delete_preview': ['id'], 'worker.delete': ['id','revision','confirm'],
  'worker.interrupt': ['id'], 'worker.resume': ['id','profile'], 'worker.configure': ['id','profile','model_selection'],
  'progress.plan': ['steps'], 'progress.complete': ['step'],
  'notice.list': [], 'notice.page': ['status','before','limit'],
  'notice.post': ['task','title','body','questions'], 'notice.answer': ['id','answer'], 'notice.dismiss': ['id'], 'notice.read': ['id'],
  'branch.history': ['cursor','limit'], 'branch.tree': [], 'branch.show': ['branch'], 'branch.bind': ['branch','commit'],
  'branch.archive': ['branch','discard','continue'], 'graph.get': [],
};
export const USER_ONLY = new Set([
  'system.stop','system.stop_if_idle','system.configure','agent.configure','agent.status','agent.environment','agent.environment.configure','agent.network','agent.network.configure',
  'branch.history','worker.code_state','worker.code_tree','worker.code_file',
  'agent.usage.config','agent.usage.configure','agent.usage.history','agent.selection.resources',
  'agent.connections.list','agent.connections.save','agent.connections.remove','agent.connections.sampling',
  'agent.connections.query','agent.connections.history','agent.connections.login.start','agent.connections.login.finish',
  'agent.connections.device.start','agent.connections.device.poll','agent.connections.device.cancel',
  'agent.connections.models','agent.connections.models.refresh',
  'agent.packages.list','agent.packages.install','agent.packages.remove','agent.packages.update',
  'quick_explain.config','quick_explain.configure','quick_explain.start','quick_explain.get','quick_explain.list',
  'hooks.list','hooks.save','hooks.remove','worker.hooks','worker.hook_attach','worker.hook_update','worker.hook_remove',
  'input.history','input.get','input.parents','draft.add','draft.update','draft.remove',
  'order.submit','worker.transcript_latest','worker.transcript_page','worker.transcript_step','worker.transcript_search',
  'worker.runs_page','worker.artifacts_page','worker.artifact',
  'worker.reserve','worker.reserve_all','worker.auto_merge','worker.resolve','worker.resolve_divergence','worker.unreserve','worker.approve_merge',
  'worker.cancel','worker.retry','worker.clear_override','worker.cleanup','worker.interrupt','worker.resume','worker.configure',
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
