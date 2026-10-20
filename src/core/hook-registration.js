import { check } from './types.js';
import { hookObject, normalizeHook, HOOK_ACTIONS, HOOK_TRIGGERS } from './hooks.js';
import { normalizeShortcut } from './shortcut-command-definition.js';
import { INPUT_EMIT_SCHEMA } from './input-emission-protocol.js';

const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const commandProperties = { name: string(120), kind: { const: 'shell' }, command: string(16000),
  description: { type: 'string', maxLength: 2000 }, warnings: { type: 'string', maxLength: 4000 } };
const hookProperties = { name: string(120), trigger: { const: 'worker.merge_received' },
  mode: { enum: ['once','persistent'] }, enabled: { type: 'boolean' },
  conditions: { type: 'object', additionalProperties: false, properties: {
    statuses: { type: 'array', items: { type: 'string' } }, integrations: { type: 'array', items: { type: 'string' } },
  } } };
export const HOOK_REGISTER_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false,
  required: ['command','hook','expected_revisions','client_request_id'], properties: {
    command: { type: 'object', additionalProperties: false, required: ['name','command'], properties: commandProperties },
    hook: { type: 'object', additionalProperties: false, required: ['name','trigger','mode','enabled'], properties: hookProperties },
    expected_revisions: { type: 'object', additionalProperties: false, required: ['commands','registry'],
      properties: { commands: string(256), registry: string(256) } }, client_request_id: string(128),
  } });
export const HOOK_MOUNT_KEYS = Object.freeze(['template_id','template_version','enabled']);
export const HOOK_MOUNT_REFERENCE_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false,
  required: ['template_id','template_version'], properties: { template_id: string(128),
    template_version: { type: 'integer', minimum: 1 }, enabled: { type: 'boolean' } } });
export const HOOK_MOUNT_CAPABILITY = Object.freeze({ schema: { type: 'object', additionalProperties: false,
  required: ['id','hook','expected_revision'], properties: { id: { type: 'integer', minimum: 1 },
    hook: HOOK_MOUNT_REFERENCE_SCHEMA, expected_revision: string(256) } },
  description: '只挂载已经注册完成的明确功能版本，独立指定目标与启停；默认按最新权限自动执行，用户可收紧为精确确认或禁用，不接受内联动作。' });
export const HOOK_REGISTER_PARAMETERS = Object.freeze(Object.keys(HOOK_REGISTER_SCHEMA.properties));
export const HOOK_REGISTER_CAPABILITY = Object.freeze({ schema: HOOK_REGISTER_SCHEMA,
  description: '只注册 Shell 指令及项目自动化功能，不挂载、不执行。成功后独立请求 worker.hook_attach 的目标、登记 ID、明确版本及启停；默认自动执行，可由用户逐项收紧权限。',
  examples: [{ command: { name: '重启应用', command: 'bun run restart' },
    hook: { name: '合并后重启', trigger: 'worker.merge_received', mode: 'persistent', enabled: true },
    expected_revisions: { commands: '<hooks.list.commands.revision>', registry: '<hooks.list.registry.revision>' }, client_request_id: '<稳定唯一注册标识>' }],
  limitations: ['Shell 非沙箱；注册不授予任何 Worker 执行授权', '同 key 精确返回原收据，不恢复已移除的定义', '不能传目标、内联 actions 或 cwd', '必须先注册成功再独立请求挂载；需要 confirmation 时仅真实用户可批准'] });
// Temporary describes definition lifetime, not invocation frequency. Reuse the
// controlled action catalogue; target validation still belongs to mounting.
const profile = INPUT_EMIT_SCHEMA.properties.profile.anyOf[0];
const actionProperties = {
  command: { command_id: string(128), command_version: { type: 'integer', minimum: 1 } },
  prompt_command: { command_id: string(128), command_version: { type: 'integer', minimum: 1 } },
  request_merge: {}, create_worker: { content: string(32000), references: INPUT_EMIT_SCHEMA.properties.references.anyOf[0], start: { type: 'boolean' }, profile },
  notify: { title: string(32000), body: { type: 'string', maxLength: 32000 } },
  message: { target_id: { type: 'integer', minimum: 1 }, body: string(32000) },
  retry_worker: { target_id: { type: 'integer', minimum: 1 }, profile }, resume_worker: { target_id: { type: 'integer', minimum: 1 }, profile },
};
const actionRequired = { command: ['command_id'], prompt_command: ['command_id'], request_merge: [], create_worker: ['content'],
  notify: ['title','body'], message: ['target_id','body'], retry_worker: ['target_id'], resume_worker: ['target_id'] };
export const HOOK_SCHEDULE_SCHEMA = { oneOf: [
    { type: 'object', additionalProperties: false, required: ['kind','at','timezone'], properties: { kind: { const: 'once' }, at: string(100), timezone: string(100) } },
    { type: 'object', additionalProperties: false, required: ['kind','time','timezone'], properties: { kind: { const: 'daily' }, time: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }, timezone: string(100) } },
  ] };
export const HOOK_ACTIONS_SCHEMA = { type: 'array', minItems: 1, maxItems: 4, items: { oneOf: HOOK_ACTIONS.filter(a => !a.builtin_only).map(action => ({
    type: 'object', additionalProperties: false, required: ['type', ...actionRequired[action.type]],
    properties: { type: { const: action.type }, ...actionProperties[action.type] },
  })) } };
const temporaryHookProperties = { ...hookProperties, trigger: { enum: HOOK_TRIGGERS.filter(t => t.id !== 'delivery.requested').map(t => t.id) },
  mode: { enum: ['once','persistent'], default: 'once' }, enabled: { type: 'boolean', default: false },
  purpose: { type: 'string', maxLength: 2000 }, schedule: HOOK_SCHEDULE_SCHEMA, actions: HOOK_ACTIONS_SCHEMA };
export const TEMPORARY_AUTOMATION_CAPABILITIES = Object.freeze({
  'hooks.temporary_create': { schema: { type: 'object', additionalProperties: false,
    required: ['hook','expected_revisions','client_request_id'],
    oneOf: [{ required: ['command'], properties: { hook: { not: { required: ['actions'] } }, expected_revisions: { required: ['commands'] } } },
      { not: { required: ['command'] }, properties: { hook: { required: ['actions'] } } }], properties: {
      hook: { type: 'object', additionalProperties: false, required: ['name','trigger'], properties: temporaryHookProperties },
      command: HOOK_REGISTER_SCHEMA.properties.command,
      expected_revisions: { type: 'object', additionalProperties: false, required: ['registry'],
        properties: { commands: string(256), registry: string(256) } }, client_request_id: string(128) } },
    description: '创建固定版本的临时功能，不挂载、不执行；优先复用已有功能。默认 once、停用；可显式授权 persistent。',
    limitations: ['无 command 时 hook.actions 必填，支持全部既有受控动作', '可选 command 仅新建 Shell，此时禁止 actions，由后端生成固定版本引用',
      '临时定义不可经 save/remove 修改、转长期或删除；用完显式安全回收，保留定义及审计'] },
  'hooks.temporary_reclaim': { schema: { type: 'object', additionalProperties: false,
    required: ['id','expected_revision','client_request_id'], properties: { id: string(128), expected_revision: string(256), client_request_id: string(128) } },
    description: '显式回收无任何挂载、待执行、真实执行或未知副作用的临时功能；事务重检，保留固定定义及审计，不可再次挂载。' },
  'hooks.temporary_history': { schema: { type: 'object', additionalProperties: false, required: ['id'],
    properties: { id: string(128), before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } } },
    description: '只读临时功能的固定定义与使用审计；已回收仍可查，按真实 Event 游标续读，不重放。' },
});
export const TEMPORARY_AUTOMATION_PARAMETERS = Object.freeze(Object.fromEntries(Object.entries(TEMPORARY_AUTOMATION_CAPABILITIES)
  .map(([method, capability]) => [method, Object.keys(capability.schema.properties)])));
export const AUTOMATION_CAPABILITIES = Object.freeze({ 'hooks.register': HOOK_REGISTER_CAPABILITY, 'worker.hook_attach': HOOK_MOUNT_CAPABILITY,
  ...TEMPORARY_AUTOMATION_CAPABILITIES });
export function validateTemporaryAutomation(method, value) {
  hookObject(value, TEMPORARY_AUTOMATION_PARAMETERS[method], method);
  if (method === 'hooks.temporary_create') {
    hookObject(value.hook, Object.keys(temporaryHookProperties), 'temporary hook');
    const { purpose, ...raw } = value.hook;
    check(purpose === undefined || typeof purpose === 'string' && purpose.length <= 2000 && !purpose.includes('\0'), 'invalid automation purpose');
    if (value.command !== undefined) {
      hookObject(value.command, Object.keys(commandProperties), 'temporary command');
      check(value.command.kind === undefined || value.command.kind === 'shell', 'temporary command must be Shell');
      normalizeShortcut(value.command);
      check(raw.actions === undefined, 'command and hook.actions are mutually exclusive');
    }
    normalizeHook({ mode: 'once', enabled: false, ...raw, ...(value.command === undefined ? {} : {
      actions: [{ type: 'command', command_id: '00000000-0000-0000-0000-000000000000' }] }) });
    hookObject(value.expected_revisions, ['registry','commands'], 'expected_revisions');
    for (const key of ['registry', ...(value.command !== undefined || value.expected_revisions.commands !== undefined ? ['commands'] : [])])
      check(typeof value.expected_revisions[key] === 'string' && value.expected_revisions[key].length > 0 && value.expected_revisions[key].length <= 256, `invalid expected_revisions.${key}`);
  } else {
    check(typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 128, 'invalid temporary automation id');
    if (method === 'hooks.temporary_history') {
      check(value.before === undefined || Number.isSafeInteger(value.before) && value.before > 0, 'before must be a positive event cursor');
      check(value.limit === undefined || Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= 100, 'limit must be 1..100');
      return value;
    }
    check(typeof value.expected_revision === 'string' && value.expected_revision.length > 0 && value.expected_revision.length <= 256, 'invalid expected_revision');
  }
  check(typeof value.client_request_id === 'string' && value.client_request_id.length > 0 && value.client_request_id.length <= 128
    && value.client_request_id === value.client_request_id.trim() && !/[\x00-\x1f\x7f]/.test(value.client_request_id), 'invalid client_request_id');
  return value;
}
export function validateHookRegistration(value) {
  hookObject(value, HOOK_REGISTER_PARAMETERS, 'Hook registration');
  hookObject(value.command, Object.keys(commandProperties), 'registration command');
  check(value.command.kind === undefined || value.command.kind === 'shell', 'registration requires a new Shell command');
  normalizeShortcut(value.command);
  hookObject(value.hook, Object.keys(hookProperties), 'registration hook');
  check(value.hook.trigger === 'worker.merge_received', 'registration supports worker.merge_received only');
  normalizeHook({ ...value.hook, actions: [{ type: 'command', command_id: '00000000-0000-0000-0000-000000000000' }] });
  hookObject(value.expected_revisions, ['commands','registry'], 'expected_revisions');
  for (const key of ['commands','registry']) check(typeof value.expected_revisions[key] === 'string'
    && value.expected_revisions[key].length > 0 && value.expected_revisions[key].length <= 256, `invalid expected_revisions.${key}`);
  check(typeof value.client_request_id === 'string' && value.client_request_id.length > 0 && value.client_request_id.length <= 128
    && value.client_request_id === value.client_request_id.trim() && !/[\x00-\x1f\x7f]/.test(value.client_request_id), 'invalid client_request_id');
  return value;
}
