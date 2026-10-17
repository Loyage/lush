import { LushError, check, isPlainObject } from '../core/types.js';
import { normalizeConfigurationScope } from '../core/device-config.js';
import { INPUT_OPTION_KEYS as ALL_INPUT_OPTION_KEYS } from '../core/input-option-keys.js';
import { HOOK_INSTALL_PARAMETERS } from '../core/hook-install.js';
import { HOOK_REGISTER_PARAMETERS } from '../core/hook-registration.js';
import { WORKER_QUERY_PARAMETERS } from '../core/worker-query.js';

const INPUT_OPTION_KEYS = ALL_INPUT_OPTION_KEYS.filter(key => key !== 'runner_node_id');

// Public API for the Worker-centred workflow. Historical rows remain on disk, but
// Intent/Plan/Candidate and optional services cannot create new work.
export const PARAMS = {
  'cli.catalog': [],
  'system.status': [], 'system.summary': ['development'], 'system.stop': [], 'system.stop_if_idle': [], 'system.configure': ['settings','scope'],
  'system.settings': ['scope'], 'system.diagnostics': [], 'system.interrupt_all': ['notify_completion'], 'system.resume_all': [],
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
  'hooks.list': [], 'hooks.save': ['template','expected_revision'], 'hooks.remove': ['id','expected_revision'],
  'hooks.command_save': ['command','expected_revision'],
  'hooks.install': HOOK_INSTALL_PARAMETERS,
  'hooks.register': HOOK_REGISTER_PARAMETERS, 'hooks.upgrade': ['expected_revision'],
  'hooks.command_export': ['id','version'],
  'hooks.command_remove': ['id','expected_revision'],
  'hooks.command_history': ['before','limit','execution_id'],
  'hooks.command_history_remove': ['execution_id','clear'],
  'hooks.command_import': ['source','expected_revision'],
  'hooks.auto_select': ['enabled','expected_revision'],
  'hooks.completion_defaults': ['enabled','level','expected_revision'],
  'hooks.automation_settings': ['patch','expected_revision'],
  'worker.acceptance_notice': ['id','enabled','expected_revision'],
  'hooks.signal_save': ['signal','expected_revision'], 'hooks.signal_remove': ['id','expected_revision'],
  'management.permissions': [], 'management.permissions_update': ['permissions','expected_revision'],
  'management.permission_get': ['method','scope'],
  'management.permission_set': ['method','access','expected_revision','scope'],
  'management.create': ['name','instruction','signal_id','mode','profile','client_request_id'],
  'management.binding_update': ['id','enabled','expected_revision'],
  'management.submit': ['instruction','profile','client_request_id'],
  'manager.catalog': [], 'manager.history': WORKER_QUERY_PARAMETERS['manager.history'], 'manager.call': ['method','params','request_id'],
  'manager.query': WORKER_QUERY_PARAMETERS['manager.query'], 'manager.start': ['id'], 'manager.retry': ['id'],
  'worker.hooks': ['id'], 'worker.completion_page': ['before','limit'], 'worker.completion': ['id','level','expected_revision'],
  'worker.hook_attach': ['id','hook','expected_revision'],
  'worker.hook_update': ['id','hook_id','enabled','hook','expected_revision'], 'worker.hook_remove': ['id','hook_id','expected_revision'],
  'order.submit': ['content','branch','references','start','draft_id','expected_revision','profile','defer'],
  'input.history': ['cursor','limit','q','status','integration','conditional','view','modes'], 'input.get': ['kind','id'], 'input.parents': [],
  'input.emit': ['content','references','branch',...INPUT_OPTION_KEYS,'profile','client_request_id','draft_id','expected_revision'],
  'input.emission_cancel': ['draft_id','expected_revision'], 'input.exclusive_release': ['draft_id','expected_revision'],
  'draft.add': ['content','references','branch',...INPUT_OPTION_KEYS],
  'draft.update': ['id','content','references','branch','expected_revision',...INPUT_OPTION_KEYS],
  'draft.remove': ['id','expected_revision'],
  'worker.auto_title': ['title'], 'worker.rename': ['id','title'], 'worker.lookup': ['number'],
  'worker.graph': WORKER_QUERY_PARAMETERS['worker.graph'], 'worker.list': WORKER_QUERY_PARAMETERS['worker.list'],
  'worker.activity': WORKER_QUERY_PARAMETERS['worker.activity'], 'worker.delivery_graph': ['history','cursor','limit'],
  'worker.page': WORKER_QUERY_PARAMETERS['worker.page'], 'worker.tree': ['id'], 'worker.inspect': ['id'], 'worker.run_settings': ['id'],
  'worker.progress_history': ['id','before','limit'], 'worker.relations': ['id','after','limit'],
  'worker.version_graph': ['id','delivery','cursor','limit'], 'worker.version_deliveries': ['id','before','limit'],
  'worker.version_commit': ['id','snapshot','commit'],
  'worker.version_lineage': ['id','cursor','limit'], 'worker.version_lineage_commit': ['id','snapshot','commit'],
  'worker.reading_page': ['id','before_event','before_message','limit','query'],
  'worker.reading_record': ['id','kind','record_id','offset'],
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
  'worker.accept': ['id'], 'worker.accept_preview': ['id'], 'worker.accept_force': ['id','revision','confirm'], 'worker.reopen': ['id'], 'worker.sync_parent': ['id'], 'worker.resolve_sync': ['id'],
  'worker.resolve_child_divergence': ['id'], 'worker.unreserve': ['id'],
  'worker.approve_merge': ['id','commit','baseline'], 'worker.message': ['id','body'],
  'worker.cancel': ['id'], 'worker.retry': ['id','profile'], 'worker.clear_override': ['id'], 'worker.cleanup': ['id','keep_branch'],
  'worker.delete_preview': ['id','force'], 'worker.delete': ['id','revision','confirm','force'],
  'worker.interrupt': ['id'], 'worker.resume': ['id','profile'], 'worker.configure': ['id','profile','model_selection'],
  'progress.plan': ['steps'], 'progress.complete': ['step'],
  'notice.list': [], 'notice.page': ['status','before','limit'], 'notice.sync': ['cursor','limit'],
  'notice.post': ['task','title','body','questions'], 'notice.answer': ['id','answer','expected_identity'],
  'notice.dismiss': ['id','expected_identity'], 'notice.read': ['id','expected_identity'],
  'branch.history': ['cursor','limit'], 'branch.version_graph': ['delivery','cursor','limit'], 'branch.tree': [], 'branch.show': ['branch'], 'branch.bind': ['branch','commit'],
  'branch.archive': ['branch','discard','continue'],
  'branch.integrate_plan': ['branch'], 'branch.integrate_start': ['branch','expected_revision'],
  'branch.integration': ['id'], 'branch.integrate_cancel': ['id','expected_revision'], 'branch.integrate_retry': ['id','expected_revision'],
  'branch.convergence': ['branch'], 'branch.convergence_list': [],
  'branch.convergence_set': ['branch','enabled','validation','expected_revision','mounted'],
  'branch.convergence_defaults': [], 'branch.convergence_defaults_set': ['mounted','enabled','expected_revision','scope'],
  'branch.convergence_runs': ['branch','before','limit'], 'branch.convergence_retry': ['id','expected_revision'],
  'graph.get': [],
};
export const USER_ONLY = new Set([
  'cli.catalog','worker.delivery_graph',
  'system.diagnostics','system.settings','settings.clear_override','settings.migration.preview','settings.migration.apply',
  'system.stop','system.stop_if_idle','system.interrupt_all','system.resume_all','system.configure','agent.config','agent.models','agent.resources','agent.configure','agent.status','agent.environment','agent.environment.configure','agent.network','agent.network.configure',
  'branch.history','branch.version_graph','worker.version_graph','worker.version_deliveries','worker.version_commit','worker.version_lineage','worker.version_lineage_commit','worker.code_state','worker.code_tree','worker.code_file',
  'agent.usage.config','agent.usage.configure','agent.usage.history','agent.selection.resources',
  'agent.connections.list','agent.connections.save','agent.connections.remove','agent.connections.sampling',
  'agent.connections.query','agent.connections.history','agent.connections.login.start','agent.connections.login.finish',
  'agent.connections.device.start','agent.connections.device.poll','agent.connections.device.cancel',
  'agent.connections.models','agent.connections.models.refresh',
  'agent.packages.list','agent.packages.install','agent.packages.remove','agent.packages.update',
  'hooks.install','hooks.register','hooks.upgrade','hooks.command_save','hooks.command_export','hooks.command_remove','hooks.command_history','hooks.command_history_remove','hooks.command_import',
  'management.permissions','management.permissions_update','management.permission_get','management.permission_set',
  'hooks.signal_save','hooks.signal_remove','management.create','management.binding_update','management.submit',
  'hooks.list','hooks.save','hooks.remove','hooks.auto_select','hooks.completion_defaults','hooks.automation_settings','worker.acceptance_notice','worker.hooks','worker.completion_page','worker.completion','worker.hook_attach','worker.hook_update','worker.hook_remove',
  'input.history','input.get','input.parents','input.emit','input.emission_cancel','input.exclusive_release','draft.add','draft.update','draft.remove',
  'order.submit','worker.transcript_latest','worker.transcript_page','worker.transcript_step','worker.transcript_search',
  'worker.runs_page','worker.artifacts_page','worker.artifact','worker.reading_page','worker.reading_record','worker.relations',
  'worker.reserve','worker.reserve_all','worker.auto_merge','worker.resolve','worker.resolve_divergence','worker.unreserve','worker.approve_merge',
  'worker.cancel','worker.retry','worker.clear_override','worker.cleanup','worker.interrupt','worker.resume','worker.configure','worker.run_settings',
  'worker.accept_preview','worker.accept_force',
  'worker.rename','worker.reopen','worker.sync_parent','worker.resolve_sync','worker.delete_preview','worker.delete',
  'notice.sync','notice.answer','notice.dismiss','notice.read','branch.bind','branch.archive',
  'branch.integrate_plan','branch.integrate_start','branch.integration','branch.integrate_cancel','branch.integrate_retry',
  'branch.convergence','branch.convergence_list','branch.convergence_set','branch.convergence_defaults','branch.convergence_defaults_set','branch.convergence_runs','branch.convergence_retry',
]);
export const AGENT_ONLY = new Set([
  'worker.auto_title','worker.integrate','worker.resolve_child_divergence','progress.plan','progress.complete',
  'manager.query','manager.start','manager.retry','manager.catalog','manager.history','manager.call',
]);
/** Management invocations have a narrower capability than ordinary development Agents. */
export { MANAGER_METHODS } from './management-methods.js';
/** Integration invocations can inspect fixed work and ask/report for themselves, never deliver or spawn. */
export const INTEGRATION_METHODS = new Set([
  'notice.post','progress.plan','progress.complete',
  'system.status','system.summary',
  'worker.lookup','worker.inspect','worker.diff','worker.history','worker.history_page','worker.transcript',
  'branch.tree','branch.show','graph.get','notice.list','notice.page',
]);

export function assertAllowed(method, params, actor) {
  check(isPlainObject(params), 'params must be an object');
  if (typeof method === 'string' && method.startsWith('runner.')) throw new LushError('Runner execution nodes are retired; only local execution is supported', -32601);
  if (!Object.hasOwn(PARAMS, method)) throw new LushError(`unknown method: ${method}`, -32601);
  check(!Object.hasOwn(params, 'runner_node_id'), 'runner_node_id is retired; new Workers always execute locally');
  check(Object.keys(params).every(key => key === '_token' || PARAMS[method].includes(key)), 'unknown parameter');
  const who = typeof actor === 'function' ? actor() : actor;
  if (['system.', 'agent.'].some(prefix => method.startsWith(prefix)) && Object.hasOwn(params, 'scope')) {
    normalizeConfigurationScope(params.scope);
    check(params.scope !== 'device' || who === null, 'device settings require user approval, not an agent');
  }
  check(who === null || !USER_ONLY.has(method), `${method} requires user approval, not an agent`);
  check(!(who === null && AGENT_ONLY.has(method)), `${method} is agent only`);
  return who;
}
