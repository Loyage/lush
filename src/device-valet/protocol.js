import { AGENT_RESOURCE_READ_METHODS, DEVICE_VALET_READ_METHODS, DEVICE_VALET_WRITE_METHODS, DEVICE_VALET_METHODS } from '../core/agent-resource-policy.js';

/** Pure Node/Bun/browser protocol. Listing capabilities never grants execution. */
export { DEVICE_VALET_READ_METHODS, DEVICE_VALET_WRITE_METHODS, DEVICE_VALET_METHODS };
export const DEVICE_VALET_SCOPE = 'device_resources';
export const DEVICE_VALET_MODE = 'device_valet';
export const DEVICE_VALET_TOOL_NAMES = Object.freeze(['device_valet']);
export const DEVICE_VALET_API = '/api/host/device-valet';
export const DEVICE_VALET_ROUTES = Object.freeze({ options: 'options', status: 'status', list: 'list', detail: 'detail', submit: 'submit', receipt: 'receipt', stop: 'stop' });
export const DEVICE_VALET_RPC = Object.freeze({ status: 'device_valet.status', list: 'device_valet.list', detail: 'device_valet.detail', submit: 'device_valet.submit', receipt: 'device_valet.receipt', stop: 'device_valet.stop', shutdown: 'device_valet.shutdown', catalog: 'device_valet.catalog', call: 'device_valet.call' });
export const DEVICE_VALET_LIMITS = Object.freeze({ instruction: 32000, page: 30, maxPage: 100, resultBytes: 256 * 1024, parametersBytes: 32768 });
export const DEVICE_VALET_RISK = '设备管家可修改当前后台机器同一系统用户的 Lush 模型与来源资源，影响所有项目；仅本条指令授权，不是操作系统 root，不含跨项目开发、Host 控制或任意 Shell。联网刷新属于写操作。密码、凭证、token 和私有提示词不会交给模型。';
function requireValue(ok, message) { if (!ok) throw new Error(message); }
function plain(value) { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
function fields(value, allowed, required = []) {
  requireValue(plain(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)), 'invalid device Valet fields');
}
export function deviceValetIdentifier(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
export function normalizeDeviceValetProfile(value) {
  fields(value, ['agent','config_mode','connection_id','model','thinking'], ['agent','config_mode','connection_id','model']);
  requireValue(value.agent === 'pi' && value.config_mode === 'lush', 'device Valet requires a managed Pi source');
  requireValue(typeof value.connection_id === 'string' && /^[a-f0-9-]{36}$/i.test(value.connection_id), 'device Valet source identity required');
  requireValue(typeof value.model === 'string' && value.model.length > 0 && value.model.length <= 256 && !/[\x00-\x1f\x7f]/.test(value.model), 'device Valet model required');
  requireValue(value.thinking === undefined || ['', 'off','minimal','low','medium','high','xhigh'].includes(value.thinking), 'invalid device Valet thinking');
  return { agent: 'pi', config_mode: 'lush', connection_id: value.connection_id, model: value.model, thinking: value.thinking ?? '' };
}
export function normalizeDeviceValetDefinition(value) {
  fields(value, ['kind','mode','scope','instruction','client_request_id','profile','id','expected_revision'], ['kind','mode','scope','instruction','client_request_id','profile']);
  requireValue(['create','append'].includes(value.kind) && value.mode === DEVICE_VALET_MODE && value.scope === DEVICE_VALET_SCOPE, 'explicit device Valet mode and scope required');
  requireValue(typeof value.instruction === 'string' && value.instruction.trim().length > 0 && value.instruction.length <= DEVICE_VALET_LIMITS.instruction, 'device Valet instruction required');
  requireValue(deviceValetIdentifier(value.client_request_id), 'device Valet request identity required');
  if (value.kind === 'append') {
    requireValue(deviceValetIdentifier(value.id) && Number.isSafeInteger(value.expected_revision) && value.expected_revision > 0, 'device Valet append target and revision required');
  } else requireValue(!Object.hasOwn(value,'id') && !Object.hasOwn(value,'expected_revision'), 'create cannot select an existing device Valet');
  return { kind: value.kind, mode: DEVICE_VALET_MODE, scope: DEVICE_VALET_SCOPE, instruction: value.instruction,
    client_request_id: value.client_request_id, profile: normalizeDeviceValetProfile(value.profile),
    ...(value.kind === 'append' ? { id: value.id, expected_revision: value.expected_revision } : {}) };
}
export function normalizeDeviceValetTool(value) {
  fields(value, ['operation','method','params'], ['operation']);
  requireValue(['catalog','call'].includes(value.operation), 'unknown device Valet tool operation');
  if (value.operation === 'catalog') {
    requireValue(!Object.hasOwn(value,'method') && !Object.hasOwn(value,'params'), 'catalog has no parameters'); return { operation: 'catalog' };
  }
  requireValue(DEVICE_VALET_METHODS.includes(value.method) && plain(value.params), 'unreviewed device Valet capability');
  requireValue(JSON.stringify(value.params).length <= DEVICE_VALET_LIMITS.parametersBytes, 'device Valet parameters exceed limit');
  // Authentication and private payloads may not cross into the execution engine.
  function visit(item, depth = 0) {
    requireValue(depth < 20, 'device Valet nesting exceeds limit');
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      requireValue(!['credential','credentials','api_key','access_token','refresh_token','token','_token','env','default_prompt','append_prompt','password','authorization','agent_token'].includes(key.toLowerCase()), 'private device Valet parameters are prohibited');
      visit(child, depth + 1);
    }
  }
  visit(value.params);
  requireValue(!Object.hasOwn(value.params,'scope') || value.params.scope === 'device', 'device Valet only supports device resources');
  return { operation: 'call', method: value.method, params: value.params };
}
if (!DEVICE_VALET_READ_METHODS.every(method => AGENT_RESOURCE_READ_METHODS.includes(method))) throw new Error('device Valet read policy mismatch');

/** HTTP read models, version 1:
 * options -> {version,default_profile,connections,registered_models}; safe public model fields only.
 * status -> {version,online,active}; offline reads never start the service.
 * list -> {version,online,items,next_cursor,has_more,coverage}; before is an opaque string.
 * detail -> {version,worker,instructions,events,next_cursor,has_more,history_complete:false}.
 * worker -> {id,worker_number,status,revision,model_selection,result,error,can_append,append_reason,can_stop,...}.
 * submit -> receipt {version,found:true,definition,worker,instruction}; only after Web password revalidation.
 * receipt -> {version,found:false} or the above exact submission receipt (not execution success).
 * stop -> {version,worker}; stopping keeps true process/control owners until actual exit.
 * Tool: {operation:'catalog'} or {operation:'call',method,params}; no model-controlled request ID.
 */
