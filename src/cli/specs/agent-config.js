import { defineCommands } from '../command-spec.js';
import { AGENT_ROLES, THINKING_LEVELS } from '../../agent/settings-protocol.js';
import { RUNTIME_SETTINGS_LIMITS } from '../../core/settings.js';
import { INPUT_EMIT_SCHEMA } from '../../core/input-emission-protocol.js';

const string = { type: 'string' };
const bool = { type: 'boolean' };
const enumeration = values => ({ type: 'string', enum: values });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const array = (items, maxItems) => ({ type: 'array', items, ...(maxItems ? { maxItems } : {}) });
const position = (name, schema = string, required = true) => ({ name, ...schema, required });
const scope = { '--scope': { ...enumeration(['device']), description: '用户可省略；Valet 设备操作须显式 device 且本轮用户已授权设备范围。' } };
const localScope = { '--scope': { ...enumeration(['device']), description: '选择设备唯一配置；不支持 project。' } };
const revision = { '--revision': { ...string, required: true, maxLength: 256, source: '对应 show 返回的 revision；不同对象不可互换。' } };
const file = schema => ({ '--file': { ...string, format: 'path', content_schema: schema,
  description: '有界、owner-only 普通 JSON 文件；不跟随符号链接；Valet 不可读取。' } });
const data = schema => ({ '--data': { type: 'json', schema, maxBytes: 40000 } });
const structured = schema => ({ ...data(schema), ...file(schema) });
const structuredRules = ['exactly one of --data and --file'];
const roles = enumeration(AGENT_ROLES);
const configModes = enumeration(['lush', 'pi']);
const profile = INPUT_EMIT_SCHEMA.properties.profile.anyOf[0];
const agentConfig = object({ version: { type: 'integer', const: 1 }, default: profile,
  roles: object(Object.fromEntries(AGENT_ROLES.map(role => [role, nullable(profile)]))) }, ['default', 'roles']);
const runtimePatch = object({
  ...Object.fromEntries(Object.entries(RUNTIME_SETTINGS_LIMITS).map(([key, { max }]) => [key, nullable(integer(1, max))])),
  ...Object.fromEntries(['progress_reporting', 'worker_delegation', 'worker_auto_title', 'context_retrieval', 'result_notice'].map(key => [key, nullable(bool)])),
  input_routes: nullable(array(object({ prefix: { ...string, minLength: 1, maxLength: 32, pattern: '^\\S+$' }, target: enumeration(['worker', 'research']) }, ['prefix', 'target']), 32)),
});
const sampling = object({ enabled: bool, interval_minutes: integer(1, 1440), retention_days: integer(1, 3650) }, ['enabled', 'interval_minutes', 'retention_days']);
const network = object({ version: { type: 'integer', const: 1 }, mode: enumeration(['inherit', 'direct', 'proxy']),
  proxy_url: nullable({ ...string, format: 'http-or-https-origin-without-credentials' }), no_proxy: array({ ...string, maxLength: 256 }, 128),
  proxy_auth: nullable(object({ username: { ...string, minLength: 1, maxLength: 1024 }, password: { ...string, maxLength: 4096 } }, ['username', 'password'])),
}, ['version', 'mode', 'no_proxy']);
const connection = object({ id: { ...string, format: 'uuid' }, label: { ...string, maxLength: 256 }, provider: string,
  endpoint: { ...string, format: 'https-url' }, auth_type: enumeration(['api_key', 'oauth']), enabled: bool,
  models: { ...array({ ...string, maxLength: 256 }, 100), uniqueItems: true }, default_model: { ...string, maxLength: 256 }, default_thinking: enumeration(THINKING_LEVELS.pi), notify_reset: bool,
}, ['label', 'provider', 'auth_type']);
const connectionInput = object({ connection, credential: object({ api_key: { ...string, writeOnly: true } }) }, ['connection']);
const fieldPath = nullable({ ...string, maxLength: 240, pattern: '^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*$' });
const usageItem = object({ id: string, label: string, unit: string, remaining: fieldPath, total: fieldPath, used: fieldPath,
  reset_at: fieldPath, window_seconds: nullable(integer(1, 315360000)) }, ['id', 'label', 'unit']);
const usageCustom = object({ provider: string, label: string, url: { ...string, format: 'https-url-without-secrets' },
  method: enumeration(['GET', 'POST']), headers: { type: 'object', additionalProperties: { ...string, description: '凭证仅能用环境引用，不得提供明文秘密。' }, maxProperties: 20 },
  body: nullable({ ...string, maxLength: 16384, description: 'JSON 文本；GET 禁止 body；凭证须环境引用。' }), kind: enumeration(['balance', 'quota']),
  items: { ...array(usageItem, 10), minItems: 1 } }, ['provider', 'label', 'url', 'method', 'kind', 'items']);
const usageConfig = object({ version: { type: 'integer', const: 1 }, ...sampling.properties,
  providers: { ...array(string, 20), uniqueItems: true }, custom: array(usageCustom, 20) });

const deviceBoundary = '设备策略不随 cwd 改变；Valet 仍逐 RPC 检查最新权限、显式设备范围和本轮用户授权。保存只影响后续调用，不自动继续、重试或热换当前 invocation。秘密不得经 argv，私有配置读取仍拒绝 Valet。';
const unknownBoundary = '请求受理不证明后续业务完成；pending_confirmation/waiting 应结束本轮，unknown 不自动重放或更换去重身份。';

export const COMMANDS = defineCommands(add => {
  const declare = (path, args, description, example, rpc, kind = 'read', parameters = {}, details = {}) => add(path, args,
    description, example, rpc, kind, `${deviceBoundary} ${unknownBoundary}`, {
      parameters: { positionals: [], ...parameters,
        options: Object.fromEntries(Object.entries(parameters.options ?? scope).map(([flag, spec]) => [flag, {
          ...spec, arity: spec.takes_value === false ? 0 : 1,
        }])),
        mutuallyExclusive: parameters.options?.['--data'] && parameters.options?.['--file'] ? [['--data', '--file']] : [] },
      sources: {}, preconditions: ['真实用户或固定 Valet bridge；普通开发 Agent 不开放此管理入口。'],
      effects: { operation: kind, scope: 'device', network: false, invokes_agent: false },
      recovery: unknownBoundary, ...details,
    });

  declare('config runtime show', '[--scope device]', '读取设备运行设置，含只读历史字段；仅调用 system.settings。', '', ['system.settings']);
  declare('config runtime set', '(KEY VALUE | --data JSON | --file PATH) [--scope device]', '局部更新设备运行设置；不先读取私有配置。', 'max-depth 4', ['system.configure'], 'write', {
    positionals: [position('KEY', enumeration(['call-timeout', 'worker-call-limit', 'max-depth']), false), position('VALUE', integer(1, 86400), false)],
    options: { ...scope, ...structured(runtimePatch) }, rules: ['KEY VALUE and structured input are mutually exclusive', 'one mode is required', 'call-timeout 1..86400; worker-call-limit 1..1000; max-depth 1..64', 'structured input: exactly one of --data/--file'],
  }, { modes: [{ name: 'field', rpc: ['system.configure'], required: ['KEY', 'VALUE'] }, { name: 'patch', rpc: ['system.configure'], required: ['--data or --file'] }] });
  declare('config runtime reset', '[KEY|all] [--scope device]', '仅恢复三个运行限额；all 不清空整个设备配置。', 'max-depth', ['system.configure'], 'write', {
    positionals: [position('KEY', { ...enumeration(['call-timeout', 'worker-call-limit', 'max-depth', 'all']), default: 'all' }, false)], options: scope,
  });
  declare('config agent show', '[--scope device]', '读取私有设备 Agent 配置；Valet 不能用安全摘要重建此配置。', '', ['agent.config']);
  declare('config agent replace', '(--data JSON | --file PATH) [--scope device]', '提交完整显式设备配置，不依赖 agent.config 私有读取。', `--data '{"version":1,"default":{"agent":"pi","config_mode":"pi"},"roles":{}}' --scope device`, ['agent.configure'], 'write', {
    options: { ...scope, ...structured(agentConfig) }, rules: [...structuredRules, '完整显式 default 与 roles；不是 patch', 'pi 模式仅适用于 Pi；不得混入托管来源、Prompt、资源、预算或 env', 'Valet 不允许私有 Prompt/env；最新后台校验仍是权威'],
  }, { modes: [{ name: 'replace', rpc: ['agent.configure'], preconditions: ['无需 agent.config 读取。'] }] });
  declare('config agent set', 'TARGET [--agent pi|codex] [--config-mode lush|pi] [--connection UUID|off] [--model MODEL] [--thinking LEVEL] [--default-prompt TEXT] [--append-prompt TEXT] [--budget-responses N|off] [--budget-tokens N|off] [--scope device]', '先读私有配置，再仅修改显式字段；保留其它配置。', 'default --config-mode pi', ['agent.config', 'agent.configure'], 'write', {
    positionals: [position('TARGET', enumeration(['default', ...AGENT_ROLES]))], options: { ...scope,
      '--agent': enumeration(['pi', 'codex']), '--config-mode': configModes, '--connection': { ...string, description: '来源 UUID，或 off 清除。' },
      '--model': { ...string, maxLength: 256 }, '--thinking': enumeration([...new Set(Object.values(THINKING_LEVELS).flat())]),
      '--default-prompt': { ...string, maxBytes: 32768 }, '--append-prompt': { ...string, maxBytes: 32768 },
      '--budget-responses': { anyOf: [integer(1, 10000), { type: 'string', const: 'off' }] },
      '--budget-tokens': { anyOf: [integer(1, 1000000000), { type: 'string', const: 'off' }] },
    }, rules: ['at least one setting', 'pi 模式不能同时设置托管覆盖；非 Pi 后端不支持 pi 模式', '切换后端会清理不兼容的隐式模型/来源/思考深度'],
  }, { preconditions: ['需要 agent.config 与 agent.configure 两项真实权限；Valet 私有读取不可用，不改走旁路。'],
    sources: { TARGET: 'agent 配置角色名；default 或固定角色枚举', '--connection': 'agent.source.list', '--model': 'agent.model.choices' } });
  declare('config agent reset', 'ROLE [--scope device]', '只清角色覆盖以恢复继承；没有 default reset 模式。', 'agent', ['agent.config', 'agent.configure'], 'write', {
    positionals: [position('ROLE', roles)], options: scope,
  }, { preconditions: ['需要 agent.config 私有读取和 agent.configure；不新增 Valet 读取权限。'] });

  for (const action of ['show', 'set', 'reset']) declare(`config network ${action}`, action === 'set' ? '--file PATH [--scope device]' : '[--scope device]', {
    show: '读取脱敏设备代理策略，不回显认证。', set: '从私有文件保存出站代理；不热改旧调用。', reset: '恢复继承后台启动环境，不清空其它配置。',
  }[action], action === 'set' ? '--file network.json' : '', [action === 'show' ? 'agent.network' : 'agent.network.configure'], action === 'show' ? 'read' : 'write', {
    options: { ...localScope, ...(action === 'set' ? Object.fromEntries(Object.entries(file(network)).map(([key, value]) => [key, { ...value, required: true }])) : {}) },
  }, { applicability: ['user'], preconditions: ['本地用户专属；Valet 不获得代理凭证文件或此本地工作流。'] });
  declare('config auto-answer show', '[--scope device]', '读取设备自动答复策略及真实 revision、可用性和错误；不执行答复。', '', ['hooks.list'], 'read', {}, {
    sources: { result: 'hooks.list.daemon_hooks 的完整安全投影' },
  });
  declare('config auto-answer set', 'on|off --revision REV [--scope device]', '设置设备自动答复策略；启用可能答复已有问题并恢复调用。', 'off --revision REV --scope device', ['hooks.auto_select'], 'write', {
    positionals: [position('ENABLED', enumeration(['on', 'off']))], options: { ...scope, ...revision },
  }, { sources: { '--revision': 'config.auto-answer.show' }, preconditions: ['读取 config auto-answer show 的 daemon policy revision；设备授权仍需本轮明确。'],
    effects: { operation: 'write', scope: 'device', network: false, invokes_agent: true } });
  for (const action of ['show', 'set']) declare(`config valet-permission ${action}`, action === 'set' ? 'METHOD ACCESS --revision REV --scope device' : 'METHOD --scope device',
    action === 'set' ? '逐项精确审核修改设备 Valet 权限，不能自动批准或提升固有上限。' : '读取单项权限、允许值与设备全局 revision。',
    action === 'set' ? 'worker.cancel confirmation --revision REV --scope device' : 'worker.cancel --scope device', [action === 'set' ? 'management.permission_set' : 'management.permission_get'], action === 'show' ? 'read' : 'write', {
      positionals: [position('METHOD'), ...(action === 'set' ? [position('ACCESS', enumeration(['read', 'automatic', 'confirmation', 'unavailable']))] : [])],
      options: { '--scope': { ...scope['--scope'], required: true }, ...(action === 'set' ? revision : {}) },
    }, { sources: { METHOD: '已注册且审核的 management 权限方法名', '--revision': 'config.valet-permission.show' },
      preconditions: ['显式 --scope device；Valet 还须真实用户本轮明确设备授权。', ...(action === 'set' ? ['真实用户批准精确 METHOD、旧值、新值与 revision；不继承或复制其它方法授权。'] : [])] });
  declare('config migration preview', '', '只读预检当前项目旧设置到设备根的迁移，不自动执行。', '', ['settings.migration.preview'], 'read', { options: {} }, {
    effects: { operation: 'read', scope: 'current_project', network: false }, applicability: ['user'],
  });
  declare('config migration apply', '--confirm --revision REV', '按精确预检迁移旧设置，保留私有备份与原件；未知不重放。', '--confirm --revision REV', ['settings.migration.apply'], 'write', {
    options: { ...revision, '--confirm': { type: 'boolean', takes_value: false, required: true } },
  }, { applicability: ['user'], sources: { '--revision': 'config.migration.preview' }, preconditions: ['先读取本项目 preview，再精确确认；不接受 scope。'], effects: { operation: 'write', scope: 'current_project', network: false } });

  declare('agent status', '[--scope device]', '执行软件安装、路径和版本诊断；不是额度、认证或调用状态。', '', ['agent.status']);
  declare('agent model list', '--backend pi|codex [--scope device]', '读取指定后端的模型候选，不冒充来源缓存或可用额度。', '--backend pi', ['agent.models'], 'read', {
    options: { ...scope, '--backend': { ...enumeration(['pi', 'codex']), required: true } },
  });
  declare('agent model choices', '[--scope device]', '读取托管来源、模型及额度缓存，不联网或探测模型。', '', ['agent.selection.resources']);
  declare('agent resource list', '[--scope device]', '读取本机扩展、Skills 与安装资源；不是模型或额度。', '', ['agent.resources']);

  for (const action of ['list', 'show', 'remove', 'refresh', 'history']) {
    const targeted = ['show', 'remove', 'history'].includes(action), optionalTarget = action === 'refresh';
    const rpc = { list: ['agent.connections.list'], show: ['agent.connections.list'], remove: ['agent.connections.remove'], refresh: ['agent.connections.query', 'agent.connections.list'], history: ['agent.connections.history'] }[action];
    declare(`agent source ${action}`, `${targeted ? 'ID ' : optionalTarget ? '[ID] ' : ''}${action === 'history' ? '[--days N] ' : ''}[--scope device]`, {
      list: '读取设备模型来源安全列表和最新观测缓存，不隐式刷新。', show: '读取单来源安全详情，不披露凭证。', remove: '删除托管来源，不删除历史或外部客户端凭证。',
      refresh: '显式联网查询额度再读取缓存；省略 ID 查询全部来源。', history: '读取当前项目归因的来源观测历史，不冒充全设备统计。',
    }[action], targeted || optionalTarget ? 'CONNECTION_ID' : '', rpc, ['refresh', 'remove'].includes(action) ? 'write' : 'read', {
      positionals: targeted || optionalTarget ? [position('ID', { ...string, maxLength: 80 }, targeted)] : [],
      options: { ...scope, ...(action === 'history' ? { '--days': { type: 'integer', enum: [1, 7, 30, 90], default: 7 } } : {}) },
    }, { sources: targeted || optionalTarget ? { ID: 'agent.source.list' } : {}, effects: { operation: ['refresh', 'remove'].includes(action) ? 'write' : 'read',
      scope: action === 'history' ? 'current_project' : 'device', network: action === 'refresh', invokes_agent: false } });
  }
  declare('agent source save', '--file PATH [--scope device]', '从私有文件保存来源和凭证；秘密不经 argv、不回显，不自动查询。', '--file connection.json', ['agent.connections.save'], 'write', {
    options: { ...localScope, '--file': { ...file(connectionInput)['--file'], required: true } },
  }, { applicability: ['user'], preconditions: ['真实本地用户；Valet 不读取连接秘密文件。'] });
  for (const action of ['list', 'refresh']) declare(`agent source models ${action}`, 'ID [--scope device]',
    action === 'list' ? '只读该来源缓存的模型目录，不联网。' : '显式联网刷新来源模型目录；失败不把旧缓存当新成功。', 'CONNECTION_ID',
    [action === 'list' ? 'agent.connections.models' : 'agent.connections.models.refresh'], action === 'list' ? 'read' : 'write', {
      positionals: [position('ID', { ...string, maxLength: 80 })], options: scope,
    }, { sources: { ID: 'agent.source.list' }, effects: { operation: action === 'list' ? 'read' : 'write', scope: 'device', network: action === 'refresh', invokes_agent: false } });
  declare('agent source sampling set', '(--data JSON | --file PATH) [--scope device]', '显式保存设备来源采样配置，不隐式启用，不改变历史归属。', '--data \'{"enabled":false,"interval_minutes":5,"retention_days":90}\' --scope device', ['agent.connections.sampling'], 'write', {
    options: { ...scope, ...structured(sampling) }, rules: structuredRules,
  }, { effects: { operation: 'write', scope: 'device', network: '仅 enabled=true 授权后续采样查询', invokes_agent: false } });
  for (const action of ['start', 'poll', 'cancel', 'finish']) {
    const rpc = { start: ['agent.connections.device.start', 'agent.connections.login.start'], poll: ['agent.connections.device.poll'], cancel: ['agent.connections.device.cancel'], finish: ['agent.connections.login.finish'] }[action];
    declare(`agent source login ${action}`, `ID${action === 'start' ? ' [--method device|callback]' : ' LOGIN_ID'}${action === 'finish' ? ' --url-file PATH' : ''} [--scope device]`, {
      start: '用户显式启动设备码或回调认证，返回真实登录身份和操作提示。', poll: '用户显式推进原设备流；可能完成认证写入，不是只读 status。',
      cancel: '取消原设备登录流，不删除已保存凭证或撤回未知副作用。', finish: '从私有回调 URL 文件完成原回调流，不接受 argv 中的回调秘密。',
    }[action], action === 'start' ? 'CONNECTION_ID --method device' : `CONNECTION_ID LOGIN_ID${action === 'finish' ? ' --url-file callback.txt' : ''}`, rpc, 'write', {
      positionals: [position('ID', { ...string, maxLength: 80 }), ...(action === 'start' ? [] : [position('LOGIN_ID', { ...string, maxLength: 80 })])],
      options: { ...localScope, ...(action === 'start' ? { '--method': { ...enumeration(['device', 'callback']), default: 'device' } } : {}),
        ...(action === 'finish' ? { '--url-file': { ...string, format: 'path', required: true, description: 'owner-only 普通文件，最多10000字节；单条回调URL；禁止符号链接。' } } : {}) },
    }, { applicability: ['user'], sources: { ID: 'agent.source.list', ...(action === 'start' ? {} : { LOGIN_ID: 'agent.source.login.start 的原始 login_id，不可跨流互换' }) },
      preconditions: ['真实本地用户；Valet 不获得交互认证或回调文件读取。', ...(action === 'poll' || action === 'cancel' ? ['只支持原 device 流。'] : [])],
      modes: action === 'start' ? [{ name: 'device', rpc: ['agent.connections.device.start'] }, { name: 'callback', rpc: ['agent.connections.login.start'] }] : [],
      effects: { operation: 'write', scope: 'device', network: action !== 'cancel', invokes_agent: false } });
  }
  for (const action of ['list', 'install', 'remove', 'update']) declare(`agent package ${action}`, `${action === 'install' ? 'SOURCE ' : ['remove', 'update'].includes(action) ? 'ID ' : ''}[--scope device]`, {
    list: '读取设备插件与 Skills 安装库；不联网、不加载代码。', install: '安装显式固定来源，不自动启用；包可含可执行代码。', remove: '移除设备安装包，不改历史显式资源引用。', update: '显式更新包；git branch ref 可能移动，不声称不可变。',
  }[action], action === 'install' ? 'npm:@scope/tools@1.0.0' : ['remove', 'update'].includes(action) ? 'PACKAGE_ID' : '', [`agent.packages.${action}`], action === 'list' ? 'read' : 'write', {
    positionals: action === 'install' ? [position('SOURCE', { ...string, description: '固定版本 npm:pkg@1.2.3、带 ref 的 git:owner/repo@ref，或显式本地目录。' })]
      : ['remove', 'update'].includes(action) ? [position('ID', { ...string, pattern: '^pkg-[0-9a-f]{16}$' })] : [], options: scope,
  }, { sources: { ID: 'agent.package.list' }, effects: { operation: action === 'list' ? 'read' : 'write', scope: 'device', network: ['install', 'update'].includes(action), invokes_agent: false },
    preconditions: ['设备范围与逐项权限；安装库管理不等于向 Valet invocation 加载插件。'] });

  declare('agent usage config show', '', '读取项目历史统计配置，不是统计数据或当前来源额度。', '', ['agent.usage.config'], 'read', { options: {} }, {
    effects: { operation: 'read', scope: 'current_project', network: false },
  });
  declare('agent usage config set', '(--data JSON | --file PATH)', '历史兼容配置入口；原独立用量写服务已退役，后台仍明确拒绝，不恢复采样。', '--data {}', ['agent.usage.configure'], 'write', {
    options: structured(usageConfig), rules: structuredRules,
  }, { preconditions: ['仅迁移旧路径；现有后端拒绝 retired 写入，不把失败包装成保存成功。'], effects: { operation: 'write', scope: 'current_project', network: false } });
  declare('agent usage history', '[--provider NAME] [--account-key KEY] [--days N]', '读取项目历史用量安全存档，不查询当前账号或全设备数据。', '', ['agent.usage.history'], 'read', {
    options: { '--provider': { ...string, pattern: '^[A-Za-z][A-Za-z0-9_-]{0,79}$' }, '--account-key': { ...string, maxLength: 128 }, '--days': { type: 'integer', enum: [1, 7, 30, 90], default: 7 } },
  }, { effects: { operation: 'read', scope: 'current_project', network: false } });
  declare('agent prompt show', 'ROLE', '本地读取最终组合 Prompt，仅真实用户；不向 Valet 披露。', 'agent', [], 'local-read', {
    positionals: [position('ROLE', roles)], options: {},
  }, { applicability: ['user'], preconditions: ['用户本地文件读取；不可代理到 Valet。'], effects: { operation: 'read', scope: 'project_and_device', network: false } });
  declare('agent prompt init', '[ROLE] [--local]', '创建补充约定文件，不覆盖已有文件；--local 选择设备私有约定。', 'agent', [], 'local-write', {
    positionals: [position('ROLE', roles, false)], options: { '--local': { type: 'boolean', takes_value: false, default: false } },
  }, { applicability: ['user'], preconditions: ['真实用户；不接受 --scope。'], effects: { operation: 'write', scope: '--local=device; otherwise=project', network: false } });
  declare('agent env show', 'ROLE', '仅本地显示环境键及来源，值脱敏；不是私有配置读取代理。', 'agent', [], 'local-read', {
    positionals: [position('ROLE', roles)], options: {},
  }, { applicability: ['user'], preconditions: ['真实用户本地检查，不接受 --scope；Valet 不可用。'], effects: { operation: 'read', scope: 'project_and_device', network: false } });
});
