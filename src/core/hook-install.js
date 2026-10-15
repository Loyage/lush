import { check } from './types.js';
import { hookObject, normalizeHook, HOOK_ACTIONS } from './hooks.js';
import { normalizeShortcut } from './shortcut-command-definition.js';

const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const commandProperties = { name: string(120), kind: { const: 'shell' }, command: string(16000),
  description: { type: 'string', maxLength: 2000 }, warnings: { type: 'string', maxLength: 4000 } };
const hookProperties = { name: string(120), trigger: { const: 'worker.merge_received' },
  mode: { enum: HOOK_ACTIONS.find(action => action.type === 'command').modes }, enabled: { type: 'boolean' },
  conditions: { type: 'object', additionalProperties: false, properties: {
    statuses: { type: 'array', items: { type: 'string' } }, integrations: { type: 'array', items: { type: 'string' } },
  } } };
export const HOOK_INSTALL_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false,
  required: ['id', 'command', 'hook', 'expected_revisions', 'client_request_id'], properties: {
    id: { type: 'integer', minimum: 1, description: '挂载 Worker 的真实整数 ID；先查询 main 对应身份，不从编号推算。' },
    command: { type: 'object', additionalProperties: false, required: ['name', 'command'], properties: commandProperties },
    hook: { type: 'object', additionalProperties: false, required: ['name', 'trigger', 'mode', 'enabled'], properties: hookProperties },
    expected_revisions: { type: 'object', additionalProperties: false, required: ['commands', 'worker_hooks'],
      properties: { commands: string(256), worker_hooks: string(256) } },
    client_request_id: string(128),
  } });
export const HOOK_INSTALL_PARAMETERS = Object.freeze(Object.keys(HOOK_INSTALL_SCHEMA.properties));
export const HOOK_INSTALL_CAPABILITY = Object.freeze({ schema: HOOK_INSTALL_SCHEMA,
  description: '原子注册一条新 Shell 快捷指令并在指定 Worker 挂载引用；保存不执行命令，只订阅未来事件。仅当前项目，管家须一次精确用户确认。',
  examples: [{ id: 7, command: { name: '重启应用', kind: 'shell', command: 'bun run restart' },
    hook: { name: 'main 合并后重启', trigger: 'worker.merge_received', mode: 'persistent', enabled: true },
    expected_revisions: { commands: '<hooks.list.commands.revision>', worker_hooks: '<worker.hooks.revision>' },
    client_request_id: '<本次安装的稳定唯一标识>' }],
  limitations: ['id 是查询得到的挂载 Worker，不是示例中的固定数字', '不接受内联 Hook actions、任意 cwd 或现有命令的改写',
    '同 key 同参数返回原安装收据，不重装已移除的配置；不同参数拒绝', 'Shell 最多 60 秒／64 KiB，非沙箱；失败或 unknown 不自动重放'],
});

export function validateHookInstallation(value) {
  hookObject(value, HOOK_INSTALL_PARAMETERS, 'Hook installation');
  check(Number.isSafeInteger(value.id) && value.id > 0, 'installation id must be a positive integer');
  hookObject(value.command, Object.keys(commandProperties), 'installation command');
  check(value.command.kind === undefined || value.command.kind === 'shell', 'installation requires a new Shell command');
  normalizeShortcut(value.command);
  hookObject(value.hook, Object.keys(hookProperties), 'installation hook');
  for (const field of HOOK_INSTALL_SCHEMA.properties.hook.required)
    check(Object.hasOwn(value.hook, field), `installation hook requires ${field}`);
  check(value.hook.trigger === 'worker.merge_received', 'installation supports worker.merge_received only');
  // Reuse the actual action/trigger/mode/condition validator; the real UUID is allocated transactionally.
  normalizeHook({ ...value.hook, actions: [{ type: 'command', command_id: '00000000-0000-0000-0000-000000000000' }] });
  hookObject(value.expected_revisions, ['commands', 'worker_hooks'], 'expected_revisions');
  for (const field of ['commands', 'worker_hooks']) {
    const revision = value.expected_revisions[field];
    check(typeof revision === 'string' && revision.length > 0 && revision.length <= 256 && revision === revision.trim()
      && !/[\x00-\x1f\x7f]/.test(revision), `expected_revisions.${field} must be a Hooks read revision`);
  }
  const key = value.client_request_id;
  check(typeof key === 'string' && key.length > 0 && key.length <= 128 && key === key.trim()
    && !/[\x00-\x1f\x7f]/.test(key), 'invalid client_request_id');
  return value;
}
