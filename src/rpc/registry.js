import { LushError, check, isPlainObject } from '../core/types.js';
import { normalizeConfigurationScope } from '../core/device-config.js';

// Public API for the Worker-centred workflow. Historical rows remain on disk, but
// Intent/Plan/Candidate and optional services cannot create new work.
export const PARAMS = {
  'system.status': [], 'system.summary': [], 'system.stop': [], 'system.stop_if_idle': [], 'system.configure': ['settings','scope'],
  'system.settings': ['scope'],
  'settings.clear_override': ['kind','target'], 'settings.migration.preview': [], 'settings.migration.apply': ['revision','confirm'],
  'agent.config': ['scope'], 'agent.models': ['agent','scope'], 'agent.resources': ['scope'], 'agent.status': ['scope'], 'agent.configure': ['config','scope'],
  'agent.network': ['scope'], 'agent.network.configure': ['config','scope'],
  'agent.environment': ['target','scope'], 'agent.environment.configure': ['target','values','scope'],
  'agent.usage.config': [], 'agent.usage.configure': ['config'], 'agent.usage.history': ['provider','account_key','days'],
  'agent.selection.resources': ['scope'],
  'agent.connections.list': ['scope'], 'agent.connections.save': ['connection','credential','scope'], 'agent.connections.remove': ['id','scope'],
  'agent.connections.sampling': ['sampling','scope'], 'agent.connections.query': ['id','scope'], 'agent.connections.history': ['id','days'],
  'agent.connections.login.start': ['id','scope'], 'agent.connections.login.finish': ['id','login_id','redirect_url','scope'],
  'agent.connections.device.start': ['id','scope'], 'agent.connections.device.poll': ['id','login_id','scope'], 'agent.connections.device.cancel': ['id','login_id','scope'],
  'agent.connections.models': ['id','scope'], 'agent.connections.models.refresh': ['id','scope'],
  'agent.packages.list': ['scope'], 'agent.packages.install': ['source','scope'], 'agent.packages.remove': ['id','scope'], 'agent.packages.update': ['id','scope'],
  'quick_explain.config': ['scope'], 'quick_explain.configure': ['config','scope'],
  'quick_explain.start': ['quote','location'], 'quick_explain.followup': ['id','question'],
  'quick_explain.get': ['id'], 'quick_explain.list': ['before','limit'],
  'quick_explain.delete': ['id'],
  'hooks.list': [], 'hooks.save': ['template','expected_revision'], 'hooks.remove': ['id','expected_revision'],
  'hooks.command_save': ['command','expected_revision'],
  'hooks.command_authorize': ['id','version','authorized','expected_revision'],
  'hooks.command_remove': ['id','expected_revision'],
  'hooks.command_run': ['id','version','worker_id','expected_revision'],
  'hooks.command_import': ['source','expected_revision'],
  'hooks.auto_select': ['enabled','expected_revision'],
  'hooks.completion_defaults': ['enabled','level','expected_revision'],
  'hooks.signal_save': ['signal','expected_revision'], 'hooks.signal_remove': ['id','expected_revision'],
  'management.create': ['name','instruction','signal_id','mode','profile','client_request_id'],
  'management.binding_update': ['id','enabled','expected_revision'],
  'manager.query': ['id'], 'manager.start': ['id'], 'manager.retry': ['id'],
  'worker.hooks': ['id'], 'worker.completion': ['id','level','expected_revision'],
  'worker.hook_attach': ['id','hook','expected_revision'],
  'worker.hook_update': ['id','hook_id','enabled','hook','expected_revision'], 'worker.hook_remove': ['id','hook_id','expected_revision'],
  'order.submit': ['content','branch','references','start','draft_id','expected_revision','profile','defer'],
  'input.history': ['cursor','limit','q','status','integration'], 'input.get': ['kind','id'], 'input.parents': [],
  'draft.add': ['content','references','branch'], 'draft.update': ['id','content','references','branch','expected_revision'],
  'draft.remove': ['id','expected_revision'],
  'worker.rename': ['id','title'], 'worker.lookup': ['number'], 'worker.graph': ['details'], 'worker.list': ['after','limit'], 'worker.activity': ['limit','scope'],
  'worker.page': ['before','limit','scope'], 'worker.tree': ['id'], 'worker.inspect': ['id'], 'worker.run_settings': ['id'],
  'worker.progress_history': ['id','before','limit'],
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
  'notice.list': [], 'notice.page': ['status','before','limit'], 'notice.sync': ['cursor','limit'],
  'notice.post': ['task','title','body','questions'], 'notice.answer': ['id','answer','expected_identity'],
  'notice.dismiss': ['id','expected_identity'], 'notice.read': ['id','expected_identity'],
  'branch.history': ['cursor','limit'], 'branch.tree': [], 'branch.show': ['branch'], 'branch.bind': ['branch','commit'],
  'branch.archive': ['branch','discard','continue'], 'graph.get': [],
};
export const USER_ONLY = new Set([
  'system.settings','settings.clear_override','settings.migration.preview','settings.migration.apply',
  'system.stop','system.stop_if_idle','system.configure','agent.config','agent.models','agent.resources','agent.configure','agent.status','agent.environment','agent.environment.configure','agent.network','agent.network.configure',
  'branch.history','worker.code_state','worker.code_tree','worker.code_file',
  'agent.usage.config','agent.usage.configure','agent.usage.history','agent.selection.resources',
  'agent.connections.list','agent.connections.save','agent.connections.remove','agent.connections.sampling',
  'agent.connections.query','agent.connections.history','agent.connections.login.start','agent.connections.login.finish',
  'agent.connections.device.start','agent.connections.device.poll','agent.connections.device.cancel',
  'agent.connections.models','agent.connections.models.refresh',
  'agent.packages.list','agent.packages.install','agent.packages.remove','agent.packages.update',
  'quick_explain.config','quick_explain.configure','quick_explain.start','quick_explain.followup','quick_explain.get','quick_explain.list','quick_explain.delete',
  'hooks.command_save','hooks.command_authorize','hooks.command_remove','hooks.command_run','hooks.command_import',
  'hooks.signal_save','hooks.signal_remove','management.create','management.binding_update',
  'hooks.list','hooks.save','hooks.remove','hooks.auto_select','hooks.completion_defaults','worker.hooks','worker.completion','worker.hook_attach','worker.hook_update','worker.hook_remove',
  'input.history','input.get','input.parents','draft.add','draft.update','draft.remove',
  'order.submit','worker.transcript_latest','worker.transcript_page','worker.transcript_step','worker.transcript_search',
  'worker.runs_page','worker.artifacts_page','worker.artifact',
  'worker.reserve','worker.reserve_all','worker.auto_merge','worker.resolve','worker.resolve_divergence','worker.unreserve','worker.approve_merge',
  'worker.cancel','worker.retry','worker.clear_override','worker.cleanup','worker.interrupt','worker.resume','worker.configure','worker.run_settings',
  'worker.rename','worker.reopen','worker.sync_parent','worker.resolve_sync','worker.delete_preview','worker.delete',
  'notice.sync','notice.answer','notice.dismiss','notice.read','branch.bind','branch.archive',
]);
export const AGENT_ONLY = new Set([
  'worker.integrate','worker.resolve_child_divergence','progress.plan','progress.complete',
  'manager.query','manager.start','manager.retry',
]);
/** Management invocations have a narrower capability than ordinary development Agents. */
export const MANAGER_METHODS = new Set(['manager.query','manager.start','manager.retry','worker.lookup']);

export function assertAllowed(method, params, actor) {
  check(isPlainObject(params), 'params must be an object');
  if (!Object.hasOwn(PARAMS, method)) throw new LushError(`unknown method: ${method}`, -32601);
  check(Object.keys(params).every(key => key === '_token' || PARAMS[method].includes(key)), 'unknown parameter');
  const who = typeof actor === 'function' ? actor() : actor;
  if (['system.', 'agent.', 'quick_explain.'].some(prefix => method.startsWith(prefix)) && Object.hasOwn(params, 'scope')) {
    normalizeConfigurationScope(params.scope);
    check(params.scope !== 'device' || who === null, 'device settings require user approval, not an agent');
  }
  check(who === null || !USER_ONLY.has(method), `${method} requires user approval, not an agent`);
  check(!(who === null && AGENT_ONLY.has(method)), `${method} is agent only`);
  return who;
}
