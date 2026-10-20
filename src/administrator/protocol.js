/** Shared browser/Node/Bun contract. This is discovery and validation, never authorization. */
export const ADMINISTRATOR_MODE = 'administrator';
export const ADMINISTRATOR_SCOPE = 'device_user';
export const ADMINISTRATOR_API = '/api/host/administrator';
// A 64000-code-unit instruction can require six JSON bytes per unit when escaped.
export const ADMINISTRATOR_HTTP_INPUT_BYTES = 512 * 1024;
export const ADMINISTRATOR_LIMITS = Object.freeze({ instruction: 64000, name: 200, page: 100, confirmationSeconds: 300 });
export const ADMINISTRATOR_ROUTES = Object.freeze({
  status: 'status', list: 'workers', detail: 'worker', receipt: 'receipt', preview: 'preview', commit: 'commit', stop: 'stop',
});
export const ADMINISTRATOR_RISK = '管理员管家可跨项目使用当前后台系统用户可操作的管理、开发与诊断能力。仅创建和每条新指令需要用户确认，执行中不逐项询问；凭证、token 和私有提示词不向模型输出。免逐项授权确认不豁免 revision、生命周期、Git、资源归属和未知副作用保护；不等于操作系统 root 或跨机器权限。';

function requireValue(condition, message) { if (!condition) throw new Error(message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function fields(value, allowed, required) {
  requireValue(object(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)), 'invalid administrator definition fields');
}
function identifier(value, name) { requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), `invalid administrator ${name}`); }

/** No user-supplied actor, grant, service credential, project-token or confirmation status. */
export function normalizeAdministratorDefinition(value) {
  const common = ['kind', 'mode', 'scope', 'client_request_id'];
  requireValue(object(value), 'administrator definition must be an object');
  requireValue(value.mode === ADMINISTRATOR_MODE && value.scope === ADMINISTRATOR_SCOPE, 'explicit administrator mode and device_user scope required');
  identifier(value.client_request_id, 'client_request_id');
  if (value.kind === 'create') {
    fields(value, [...common, 'name'], [...common, 'name']);
    requireValue(typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= ADMINISTRATOR_LIMITS.name, 'administrator name required (max 200 characters)');
    // Creation grants no instruction. The first instruction uses the same input gate as every append.
    return { kind: 'create', mode: ADMINISTRATOR_MODE, scope: ADMINISTRATOR_SCOPE, client_request_id: value.client_request_id, name: value.name };
  }
  requireValue(value.kind === 'input', 'administrator kind must be create or input');
  fields(value, [...common, 'id', 'instruction'], [...common, 'id', 'instruction']);
  identifier(value.id, 'id');
  requireValue(typeof value.instruction === 'string' && value.instruction.trim().length > 0 && value.instruction.length <= ADMINISTRATOR_LIMITS.instruction, 'administrator instruction required (max 64000 characters)');
  // Never trim or rewrite confirmed content; edits, including whitespace, invalidate the binding.
  return { kind: 'input', mode: ADMINISTRATOR_MODE, scope: ADMINISTRATOR_SCOPE, client_request_id: value.client_request_id, id: value.id, instruction: value.instruction };
}

/** Exact canonical definition for a server-owned digest; not a bearer authorization. */
export function administratorDefinitionText(value) { return JSON.stringify(normalizeAdministratorDefinition(value)); }
