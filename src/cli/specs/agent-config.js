import { defineCommands } from '../command-spec.js';
import { AGENT_ROLES } from '../../agent/settings-protocol.js';
import { RUNTIME_SETTINGS_LIMITS } from '../../core/settings.js';
import { INPUT_EMIT_SCHEMA } from '../../core/input-emission-protocol.js';

const string = { type: 'string' }, bool = { type: 'boolean' };
const enumeration = values => ({ type: 'string', enum: values });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const position = (name, schema = string, required = true) => ({ name, ...schema, required });
const scope = { '--scope': { ...enumeration(['device']), description: '安全模型资源读取可省略，无需设备关键词；显式值只能为 device。项目 Valet 不可写设备共享资源。' } };
const revision = { '--revision': { ...string, required: true, maxLength: 256, source: '对应 show 返回的 revision；不同对象不可互换。' } };
const data = schema => ({ '--data': { type: 'json', schema, maxBytes: 40000 } });
const profile = INPUT_EMIT_SCHEMA.properties.profile.anyOf[0];
const agentConfig = object({ version: { type: 'integer', const: 1 }, default: profile,
  roles: object(Object.fromEntries(AGENT_ROLES.map(role => [role, nullable(profile)]))) }, ['default', 'roles']);
const runtimePatch = object({
  ...Object.fromEntries(Object.entries(RUNTIME_SETTINGS_LIMITS).map(([key, { max }]) => [key, nullable(integer(1, max))])),
  ...Object.fromEntries(['progress_reporting', 'worker_delegation', 'worker_auto_title', 'context_retrieval', 'result_notice'].map(key => [key, nullable(bool)])),
  input_routes: nullable({ type: 'array', maxItems: 32, items: object({ prefix: { ...string, minLength: 1, maxLength: 32, pattern: '^\\S+$' }, target: enumeration(['worker', 'research']) }, ['prefix', 'target']) }),
});
const deviceBoundary = '设备策略不随 cwd 改变。项目 Valet 的安全模型／来源／缓存读取不要求设备关键词或显式 scope，但仍检查最新只读权限；其它设备查询按各自授权前置条件执行。设备共享资源写入、删除及联网刷新只向设备级管家开放，不因 scope、确认或项目提权放行；真实用户终端／Web 原入口不变。保存只影响后续调用，不自动继续、重试或热换当前 invocation。秘密不得经 argv，私有字段仍拒绝 Valet。';
const unknownBoundary = '请求受理不证明后续业务完成；pending_confirmation/waiting 应结束本轮，unknown 不自动重放或更换去重身份。';

export const COMMANDS = defineCommands(add => {
  const declare = (path, args, description, example, rpc, kind = 'read', parameters = {}, details = {}) => add(path, args,
    description, example, rpc, kind, `${deviceBoundary} ${unknownBoundary}`, {
      parameters: { positionals: [], ...parameters, options: Object.fromEntries(Object.entries(parameters.options ?? scope)
        .map(([flag, spec]) => [flag, { ...spec, arity: spec.takes_value === false ? 0 : 1 }])) },
      sources: {}, preconditions: ['真实用户或固定 Valet bridge；普通开发 Agent 不开放此管理入口。'],
      effects: { operation: kind, scope: 'device', network: false, invokes_agent: false }, recovery: unknownBoundary, ...details,
    });
  declare('config runtime show', '[--scope device]', '读取设备运行设置，含只读历史字段；仅调用 system.settings。', '', ['system.settings']);
  declare('config runtime set', '(KEY VALUE | --data JSON) [--scope device]', '局部更新设备运行设置；不先读取私有配置。', 'max-depth 4', ['system.configure'], 'write', {
    positionals: [position('KEY', enumeration(['call-timeout', 'worker-call-limit', 'max-depth']), false), position('VALUE', integer(1, 86400), false)],
    options: { ...scope, ...data(runtimePatch) }, rules: ['KEY VALUE and --data are mutually exclusive', 'one mode is required', 'call-timeout 1..86400; worker-call-limit 1..1000; max-depth 1..64'],
  }, { modes: [{ name: 'field', rpc: ['system.configure'], required: ['KEY', 'VALUE'] }, { name: 'patch', rpc: ['system.configure'], required: ['--data'] }] });
  declare('config runtime reset', '[KEY|all] [--scope device]', '仅恢复三个运行限额；all 不清空整个设备配置。', 'max-depth', ['system.configure'], 'write', {
    positionals: [position('KEY', { ...enumeration(['call-timeout', 'worker-call-limit', 'max-depth', 'all']), default: 'all' }, false)], options: scope,
  });
  declare('config agent replace', '--data JSON [--scope device]', '提交完整显式设备配置，不依赖 agent.config 私有读取。', `--data '{"version":1,"default":{"agent":"pi","config_mode":"pi"},"roles":{}}' --scope device`, ['agent.configure'], 'write', {
    options: { ...scope, '--data': { ...data(agentConfig)['--data'], required: true } },
    rules: ['完整显式 default 与 roles；不是 patch', 'pi 模式仅适用于 Pi；不得混入托管来源、Prompt、资源、预算或 env', 'Valet 不允许私有 Prompt/env；最新后台校验仍是权威'],
  }, { modes: [{ name: 'replace', rpc: ['agent.configure'], preconditions: ['无需 agent.config 读取。'] }] });
  declare('config auto-answer show', '[--scope device]', '读取设备自动答复策略及真实 revision、可用性和错误；不执行答复。', '', ['hooks.list'], 'read', {}, {
    sources: { result: 'hooks.list.daemon_hooks 的完整安全投影' },
  });
  declare('config auto-answer set', 'on|off --revision REV [--scope device]', '设置设备自动答复策略；启用可能答复已有问题并恢复调用。', 'off --revision REV --scope device', ['hooks.auto_select'], 'write', {
    positionals: [position('ENABLED', enumeration(['on', 'off']))], options: { ...scope, ...revision },
  }, { sources: { '--revision': 'config.auto-answer.show' }, preconditions: ['读取 config auto-answer show 的 daemon policy revision；项目 Valet 不可代理设备自动答复写入。'],
    effects: { operation: 'write', scope: 'device', network: false, invokes_agent: true } });
  for (const action of ['show', 'set']) declare(`config valet-permission ${action}`, action === 'set' ? 'METHOD ACCESS --revision REV --scope device' : 'METHOD --scope device',
    action === 'set' ? '真实用户逐项修改设备 Valet 权限；项目 Valet 不可代理修改，不能提升固有上限。' : '读取单项权限、允许值与设备全局 revision。',
    action === 'set' ? 'worker.cancel confirmation --revision REV --scope device' : 'worker.cancel --scope device', [action === 'set' ? 'management.permission_set' : 'management.permission_get'], action === 'show' ? 'read' : 'write', {
      positionals: [position('METHOD'), ...(action === 'set' ? [position('ACCESS', enumeration(['read', 'automatic', 'confirmation', 'unavailable']))] : [])],
      options: { '--scope': { ...scope['--scope'], required: true }, ...(action === 'set' ? revision : {}) },
    }, { sources: { METHOD: '已注册且审核的 management 权限方法名', '--revision': 'config.valet-permission.show' },
      preconditions: ['显式 --scope device；只读权限查询仍须 Valet 本轮明确设备授权。', ...(action === 'set' ? ['项目 Valet 不可代理权限写入；用户终端／Web 核对精确 METHOD、旧值、新值与 revision，不继承或复制其它方法授权。'] : [])] });
  declare('agent status', '[--scope device]', '执行软件安装、路径和版本诊断；不是额度、认证或调用状态。', '', ['agent.status']);
  declare('agent model list', '[--backend pi|codex] [--scope device]', '默认列设备已注册命名模型（含不可选原因），不联网；显式 --backend 另查后端候选，不是登记清单。', '--scope device', ['agent.registered_models.list', 'agent.models'], 'read', {
    options: { ...scope, '--backend': enumeration(['pi', 'codex']) },
  }, { modes: [{ name: 'registered', when: '省略 --backend', rpc: ['agent.registered_models.list'] },
    { name: 'backend-candidates', when: '显式 --backend pi|codex', rpc: ['agent.models'] }] });
  declare('agent model resolve', 'NAME_OR_ID [--scope device]', '精确解析已注册名称或稳定 ID 为具体来源和模型；失效或未找到拒绝，不猜选、不联网。', 'astra --scope device', ['agent.registered_models.resolve'], 'read', {
    positionals: [position('NAME_OR_ID')], options: scope,
  }, { sources: { NAME_OR_ID: 'agent model list 返回的精确 name 或 id；名称设备唯一。' } });
  declare('agent model choices', '[--scope device]', '读取托管来源、模型及额度缓存，不联网或探测模型。', '', ['agent.selection.resources']);
  for (const action of ['list', 'show', 'remove', 'refresh']) {
    const targeted = ['show', 'remove'].includes(action), optionalTarget = action === 'refresh';
    const rpc = { list: ['agent.connections.list'], show: ['agent.connections.list'], remove: ['agent.connections.remove'], refresh: ['agent.connections.query', 'agent.connections.list'] }[action];
    declare(`agent source ${action}`, `${targeted ? 'ID ' : optionalTarget ? '[ID] ' : ''}[--scope device]`, {
      list: '读取设备模型来源安全列表和最新观测缓存，不隐式刷新。', show: '读取单来源安全详情，不披露凭证。', remove: '删除托管来源，不删除历史或外部客户端凭证。',
      refresh: '显式联网查询额度再读取缓存；省略 ID 查询全部来源。',
    }[action], targeted || optionalTarget ? 'CONNECTION_ID' : '', rpc, ['refresh', 'remove'].includes(action) ? 'write' : 'read', {
      positionals: targeted || optionalTarget ? [position('ID', { ...string, maxLength: 80 }, targeted)] : [], options: scope,
    }, { sources: targeted || optionalTarget ? { ID: 'agent.source.list' } : {}, effects: { operation: ['refresh', 'remove'].includes(action) ? 'write' : 'read', scope: 'device', network: action === 'refresh', invokes_agent: false } });
  }
  for (const action of ['list', 'refresh']) declare(`agent source models ${action}`, 'ID [--scope device]',
    action === 'list' ? '只读该来源缓存的模型目录，不联网。' : '显式联网刷新来源模型目录；失败不把旧缓存当新成功。', 'CONNECTION_ID',
    [action === 'list' ? 'agent.connections.models' : 'agent.connections.models.refresh'], action === 'list' ? 'read' : 'write', {
      positionals: [position('ID', { ...string, maxLength: 80 })], options: scope,
    }, { sources: { ID: 'agent.source.list' }, effects: { operation: action === 'list' ? 'read' : 'write', scope: 'device', network: action === 'refresh', invokes_agent: false } });
});
