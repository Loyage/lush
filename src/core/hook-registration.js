import { check } from './types.js';
import { hookObject, normalizeHook } from './hooks.js';
import { normalizeShortcut } from './shortcut-command-definition.js';

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
export const AUTOMATION_CAPABILITIES = Object.freeze({ 'hooks.register': HOOK_REGISTER_CAPABILITY, 'worker.hook_attach': HOOK_MOUNT_CAPABILITY });
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
