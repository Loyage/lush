import { PARAMS, USER_ONLY, AGENT_ONLY } from './registry.js';
import { check, isPlainObject } from '../core/types.js';

const reads = new Set([
  'system.summary','system.status','system.diagnostics','worker.lookup','worker.inspect','worker.list','worker.activity','worker.page','worker.tree',
  'worker.graph','worker.relations','worker.progress_history','branch.tree','branch.show','graph.get',
  'hooks.list','worker.hooks','hooks.command_history','input.history','input.get','input.parents',
  'notice.list','notice.page','branch.convergence','branch.convergence_list','branch.convergence_runs',
  'branch.convergence_defaults','branch.history','branch.version_graph','worker.delete_preview',
  'agent.connections.list','agent.connections.history','agent.connections.models','agent.usage.config','agent.usage.history',
  'agent.models','agent.resources','agent.selection.resources','agent.packages.list','agent.status','system.settings',
]);
const automatic = new Set(['draft.add','draft.update','draft.remove','input.emit','order.submit','worker.message',
  'input.emission_cancel','input.exclusive_release','worker.resume','worker.retry']);
export const MANAGEMENT_DEVICE_ALIASES = new Set(['hooks.auto_select','hooks.completion_defaults']);
export function managementDispatchParams(method, params) {
  if (!MANAGEMENT_DEVICE_ALIASES.has(method)) return params;
  // scope is management authorization metadata for these device-only legacy aliases,
  // not a new parameter accepted by their ordinary public RPC handlers.
  const { scope: _explicitDeviceScope, ...definition } = params;
  return definition;
}
const unavailable = new Set([
  'management.submit','management.create','management.binding_update', // no self-replicating managers/authorization changes
  'worker.spawn','worker.integrate','worker.resolve_child_divergence','notice.post',
  'agent.config','agent.environment','agent.environment.configure','agent.network','agent.network.configure',
  'agent.connections.save','agent.connections.login.start','agent.connections.login.finish',
  'agent.connections.device.start','agent.connections.device.poll','agent.connections.device.cancel',
  'settings.migration.preview','settings.migration.apply','settings.clear_override',
  'worker.run_settings','worker.code_state','worker.code_tree','worker.code_file',
  'worker.version_graph','worker.version_deliveries','worker.version_commit',
  'worker.reading_page','worker.reading_record','worker.history','worker.history_page',
  'worker.transcript','worker.transcript_latest','worker.transcript_page','worker.transcript_step','worker.transcript_search',
  'worker.runs_page','worker.artifacts_page','worker.artifact', // raw provider/tool material is not a credential-safe read surface
]);
export function managementPolicy(method) {
  if (!Object.hasOwn(PARAMS, method)) return { access: 'unavailable', reason: '当前版本没有此公开功能。' };
  if (method === 'system.stop_if_idle') return { access: 'unavailable',
    reason: '管理执行自身占用后台操作位，无法用空闲停机入口；请用户直接安全停机，或明确确认 system.stop 停止当前项目。' };
  if (unavailable.has(method) || AGENT_ONLY.has(method) || method.startsWith('manager.') || method.startsWith('progress.'))
    return { access: 'unavailable', reason: '需要用户交互、私有材料或专用身份；请使用用户界面。运行诊断使用 manager.history 的安全摘要。' };
  if (reads.has(method)) return { access: 'read', reason: null };
  if (automatic.has(method)) return { access: 'automatic', reason: null };
  if (USER_ONLY.has(method)) return { access: 'confirmation', reason: '必须预检并由用户确认精确操作；模型及自动选择不能授权。' };
  return { access: 'unavailable', reason: '尚未审核为管理能力，不开放泛化 RPC。' };
}

export function managementCatalog() {
  return { scope: 'current_project', methods: Object.keys(PARAMS).map(method => ({ method,
    parameters: [...PARAMS[method], ...(MANAGEMENT_DEVICE_ALIASES.has(method) ? ['scope'] : [])], ...managementPolicy(method) })),
    limitations: ['无任意 Shell 或文件工具', '不读取凭证、原始会话或私有配置', '不跨项目',
      '设备操作须指令及 scope 参数显式指定', '未知副作用不自动重放'] };
}

export function validateManagementCall(method, params, instruction = '') {
  check(typeof method === 'string' && Object.hasOwn(PARAMS, method), 'unknown management capability');
  const policy = managementPolicy(method);
  check(policy.access !== 'unavailable', policy.reason);
  check(isPlainObject(params) && Object.keys(params).every(key => PARAMS[method].includes(key)
    || key === 'scope' && MANAGEMENT_DEVICE_ALIASES.has(method)), 'unknown management parameter');
  // Auth identities and secret-bearing payloads must never be model-controlled, including nested dictionaries.
  const visit = (value, depth = 0) => {
    check(depth < 20, 'management parameter nesting exceeds limit');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      check(!['_token','credential','credentials','agent_token','agent_token_hash','env','default_prompt','append_prompt'].includes(key),
        'private authentication, environment and prompt payloads require the user interface');
      visit(child, depth + 1);
    }
  };
  visit(params);
  check(Buffer.byteLength(JSON.stringify(params)) <= 32768, 'management parameters exceed limit');
  if (Object.hasOwn(params, 'scope')) {
    check(params.scope === 'device', 'management settings must explicitly select device scope');
    check(/设备|全局|device/i.test(instruction), 'device scope must be explicitly requested in the user instruction');
  } else if ((PARAMS[method].includes('scope') || MANAGEMENT_DEVICE_ALIASES.has(method)) && method !== 'agent.status') {
    check(false, 'device settings require explicit scope in both user instruction and parameters');
  }
  // Strict registry validation still runs at the trusted dispatch boundary; never accept a replacement actor.
  return policy;
}
