import { afterAll, beforeEach, expect, test } from 'bun:test';
import { installDom, deepText, dialogButton, dialogText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { openAgentStatus } from '../../src/ui/web/assets/render-agent-status.js';
import { openQuickExplanationPage } from '../../src/ui/web/assets/render-quick-explanation.js';
import { openModelSources } from '../../src/ui/web/assets/render-model-sources.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { settingsClient, projectSettingsAction } from '../../src/ui/web/assets/settings-api.js';

const world = makeWorld(), requests = [], writes = [];
let intercept, noProject, seq = 0, agents, quick, runtime, networks, environments, sources, migration;
const json = (value, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(value) });
const metadata = (selected, override = selected === 'project') => ({ selected, source: override ? 'project' : 'device',
  project_override: override, device_home: '/fixture/device/shared', project_home: '/fixture/project/.lush' });
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
const dom = installDom({ fetch: async (url, options = {}) => {
  const raw = String(url), parsed = new URL(raw, 'http://fixture');
  const path = parsed.pathname.replace(/^\/p\/[a-f0-9]+/, '').replace(/^\/api\/host\/settings\//, '/api/');
  const params = options.body ? JSON.parse(options.body) : null;
  const scope = params?.params?.scope || parsed.searchParams.get('scope') || 'project';
  requests.push({ url: raw, path, options, params });
  if (options.method === 'POST') writes.push(params);
  const custom = intercept?.({ raw, path, params, scope }); if (custom) return custom;
  if (path === '/api/host') return json(noProject ? { mode: 'host', projects: [] } : { mode: 'bound' });
  if (path === '/api/agent/config') return json(agents[scope]);
  if (path === '/api/settings/runtime') return json(runtime[scope]);
  if (path === '/api/agent/network') return json(networks[scope]);
  if (path === '/api/agent/environment') return json(environments[scope]);
  if (path === '/api/quick-explain/config') return json(quick[scope]);
  if (path === '/api/agent/connections') return json({ ...world.state.agentConnections, connections: scope === 'device' ? sources.slice(0, 1) : sources,
    configuration_scope: metadata(scope) });
  if (path === '/api/settings/migration') return json(migration);
  if ((path === '/api/action' || path === '/api/host/settings/action') && params) {
    const { method, params: p } = params;
    if (method === 'agent.configure') { agents[scope] = { ...agents[scope], ...p.config }; return json(agents[scope]); }
    if (method === 'quick_explain.configure') { quick[scope] = { ...quick[scope], ...p.config, ready: true }; return json(quick[scope]); }
    if (method === 'agent.network.configure') { networks[scope] = { ...networks[scope], ...p.config }; return json(networks[scope]); }
    if (method === 'agent.environment.configure') { environments[scope] = { ...environments[scope], values: p.values }; return json(environments[scope]); }
    if (method === 'system.configure') { for (const [key, value] of Object.entries(p.settings)) runtime[scope][key] = { ...runtime[scope][key],
      value: value ?? runtime.device[key].value, source: value === null ? 'device' : scope, overridden: value !== null };
      return json(runtime[scope]); }
    if (method === 'settings.clear_override') {
      const collection = { agent: agents, quick_explain: quick, network: networks, environment: environments }[p.kind];
      collection.project = { ...structuredClone(collection.device), configuration_scope: metadata('project', false) }; return json(collection.project);
    }
    if (method === 'settings.migration.apply') return json({ version: 1, migrated: true, backup: '/fixture/project/.lush/migration-backup', items: migration.items, warnings: [] });
    if (method === 'agent.connections.save') { const row = sources.find(entry => entry.id === p.connection.id); Object.assign(row, p.connection); return json(row); }
  }
  return world.fetchImpl(`${path}${parsed.search}`, options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const detail = () => dom.node('detail');
const select = () => detail().querySelector('select[data-settings-scope=""]');
const switchScope = async scope => { select().value = scope; await select().onchange(); };
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const agentField = name => detail().querySelector(`[data-agent-target="default"]`).querySelector(`[data-agent-field="${name}"]`);
const quickField = name => detail().querySelector(`[data-quick-field="${name}"]`);
const sourceField = name => detail().querySelector(`[data-connection-field="${name}"]`);
const input = (node, value) => { node.value = value; node.oninput?.(); for (const listener of node.listeners.input || []) listener(); };
const system = async () => { await dom.node('settings-open').onclick(); await detail().querySelector('button.settings-tab[data-settings-tab="system"]').onclick(); };
const onlyConfiguration = () => expect(writes.every(row => !/worker|quick_explain\.(start|followup)|agent\.usage\.query/.test(row.method))).toBe(true);

test('settings transport preserves scope for local model resources and explicit catalog refresh in project and Host contexts', async () => {
  intercept = ({ path, params, scope }) => path === '/api/agent/selection/resources' ? json({ scope })
    : params?.method === 'agent.connections.models.refresh' ? json({ scope }) : null;
  expect(await settingsClient().read('/api/agent/selection/resources')).toEqual({ scope: 'device' });
  await settingsClient().action('agent.connections.models.refresh', { id: sources[0].id });
  expect(writes.at(-1)).toEqual({ method: 'agent.connections.models.refresh', params: { id: sources[0].id, scope: 'device' } });
  noProject = true; await boot(); requests.length = 0;
  expect(await settingsClient().read('/api/agent/selection/resources')).toEqual({ scope: 'device' });
  await settingsClient().action('agent.connections.models.refresh', { id: sources[0].id });
  expect(requests.every(row => row.url.startsWith('/api/host/settings/'))).toBe(true);
});

beforeEach(async () => {
  intercept = null; noProject = false; dom.location.pathname = `/p/${String(++seq).padStart(16, '0')}/`; dom.location.hash = '';
  sources = [structuredClone(world.state.agentConnections.connections[0]), { ...structuredClone(world.state.agentConnections.connections[0]),
    id: '22222222-2222-4222-8222-222222222222', label: '旧项目来源', storage_scope: 'project' }];
  sources[0].storage_scope = 'device'; sources[0].label = '共享来源'; sources[0].models = ['fixture-model'];
  agents = {}; quick = {}; runtime = {}; networks = {}; environments = {};
  for (const scope of ['device', 'project']) {
    agents[scope] = { ...structuredClone(world.state.agentConfig), configuration_scope: metadata(scope) };
    agents[scope].default = { ...agents[scope].default, agent: 'pi', model: 'openai-compatible/fixture-model', connection_id: sources[0].id, append_prompt: `${scope}-prompt` };
    agents[scope].roles = {};
    quick[scope] = { ...structuredClone(world.state.quickExplanationConfig), connection_id: sources[0].id, model: 'fixture-model', prompt: `${scope}-explain`, configuration_scope: metadata(scope) };
    runtime[scope] = { ...structuredClone(world.state.runtimeSettings), configuration_scope: metadata(scope) };
    for (const entry of Object.values(runtime[scope])) if (entry && Object.hasOwn(entry, 'value')) entry.source = scope;
    networks[scope] = { version: 1, mode: 'proxy', proxy_url: `http://${scope}.invalid:8080`, no_proxy: [], has_proxy_auth: false,
      backend_support: { pi: true, codex: false }, runtime: { pi: { mode: 'proxy' }, codex: { mode: 'unsupported' } }, configuration_scope: metadata(scope) };
    environments[scope] = { target: 'common', file: `${scope}/agent.env`, values: { CUSTOM_SETTING: `${scope}-value` }, reserved_names: [], configuration_scope: metadata(scope) };
  }
  migration = { version: 1, revision: 'revision-1', can_migrate: true, already_migrated: false, blockers: [], warnings: ['其他旧项目仍保留覆盖'],
    items: [{ kind: 'Agent 配置', action: '导入共享配置并退役项目覆盖', source: '/fixture/project/.lush/agent.json', destination: '/fixture/device/shared/agent.json' }] };
  await boot(); requests.length = 0; writes.length = 0;
});
afterAll(() => dom.restore());

test('设置专用 transport 使用设备显式范围；历史和 Worker 通道不被改写', async () => {
  const client = settingsClient(); await client.read('/api/agent/config'); await client.action('agent.configure', { config: {} });
  expect(requests[0].url).toBe(`/p/${String(seq).padStart(16, '0')}/api/agent/config?scope=device`);
  expect(writes[0].params.scope).toBe('device');
  await expect(client.read('/api/quick-explain/history')).rejects.toThrow('不属于配置管理');
  await projectSettingsAction('settings.migration.apply', { revision: 'revision-1', confirm: true });
  expect(writes.at(-1)).toEqual({ method: 'settings.migration.apply', params: { revision: 'revision-1', confirm: true } });
  dom.location.pathname = '/'; await expect(client.action('agent.configure', { config: {} })).rejects.toThrow('项目上下文已改变');
});

test('Agent 默认设备编辑，双范围保留草稿；清除项目覆盖需确认并读取继承来源', async () => {
  await openAgentStatus(); expect(select().value).toBe('device'); expect(deepText(detail())).toContain('当前读取：设备共享');
  input(agentField('append_prompt'), '设备未保存'); await switchScope('project'); input(agentField('append_prompt'), '项目未保存');
  expect(deepText(detail())).toContain('当前读取：本项目独立覆盖'); await switchScope('device'); expect(agentField('append_prompt').value).toBe('设备未保存');
  await switchScope('project'); expect(agentField('append_prompt').value).toBe('项目未保存');
  const clearing = detail().querySelector('button[data-clear-override="agent"]').onclick();
  expect(writes).toHaveLength(0); expect(dialogText(dom)).toContain('设备共享默认'); await dialogButton(dom, '清除并继承').onclick(); await clearing;
  expect(writes).toEqual([{ method: 'settings.clear_override', params: { kind: 'agent' } }]);
  expect(agentField('append_prompt').value).toBe('device-prompt'); expect(deepText(detail())).toContain('当前读取：设备共享默认');
  onlyConfiguration();
});

test('Agent 保存只改当前层，不调用 Agent 或把设备配置写进项目快照', async () => {
  await openAgentStatus(); const snapshot = ui.lastSnapshot.status.agent_config;
  input(agentField('append_prompt'), '更新共享规则');
  const card = detail().querySelector('[data-agent-target="default"]'); await button(card, '读取共享来源').onclick(); await button(card, '保存配置').onclick();
  expect(writes.at(-1)).toMatchObject({ method: 'agent.configure', params: { scope: 'device', config: { default: { append_prompt: '更新共享规则' } } } });
  expect(agents.project.default.append_prompt).toBe('project-prompt'); expect(ui.lastSnapshot.status.agent_config).toBe(snapshot); onlyConfiguration();
});

test('Agent 迟到设备读取不能覆盖已切换项目层；返回设备重新读取', async () => {
  const pending = deferred(); intercept = ({ path, scope }) => path === '/api/agent/config' && scope === 'device' ? pending.promise : null;
  const opening = openAgentStatus(); await switchScope('project'); expect(agentField('append_prompt').value).toBe('project-prompt');
  intercept = null; pending.resolve(json({ ...agents.device, default: { ...agents.device.default, append_prompt: 'OLD-LATE' } })); await opening;
  expect(select().value).toBe('project'); expect(agentField('append_prompt').value).toBe('project-prompt');
  await switchScope('device'); expect(agentField('append_prompt').value).toBe('device-prompt');
});

test('环境变量按层隔离读取与草稿，项目可清除覆盖', async () => {
  await openAgentStatus(); let env = detail().querySelector('.agent-env-block'); await button(env, '读取变量').onclick(); env = detail().querySelector('.agent-env-block');
  const oldInput = env.querySelector('input.agent-env-value'); expect(oldInput.value).toBe('device-value'); input(oldInput, '设备变量草稿');
  await switchScope('project'); env = detail().querySelector('.agent-env-block'); await button(env, '读取变量').onclick(); env = detail().querySelector('.agent-env-block');
  expect(env.querySelector('input.agent-env-value').value).toBe('project-value');
  await switchScope('device'); env = detail().querySelector('.agent-env-block'); expect(env.querySelector('input.agent-env-value').value).toBe('设备变量草稿');
  await switchScope('project'); env = detail().querySelector('.agent-env-block');
  const clearing = env.querySelector('button[data-clear-override="environment"]').onclick(); await dialogButton(dom, '清除并继承').onclick(); await clearing;
  expect(writes.at(-1)).toEqual({ method: 'settings.clear_override', params: { kind: 'environment', target: 'common' } });
});

test('快捷解释配置双层保留草稿，历史始终是本项目 API；迟到保存不重画新层', async () => {
  await openQuickExplanationPage(); input(quickField('prompt'), '设备解释草稿');
  await switchScope('project'); input(quickField('prompt'), '项目解释草稿'); await switchScope('device'); expect(quickField('prompt').value).toBe('设备解释草稿');
  const pending = deferred(); intercept = ({ params }) => params?.method === 'quick_explain.configure' ? pending.promise : null;
  const saving = button(detail(), '保存解释设置').onclick(); await switchScope('project');
  pending.resolve(json({ ...quick.device, prompt: 'OLD-SAVE' })); await saving;
  expect(quickField('prompt').value).toBe('项目解释草稿'); expect(select().value).toBe('project');
  expect(writes.at(-1).params.scope).toBe('device');
  expect(requests.filter(row => row.path.includes('/history')).every(row => !row.url.includes('scope=') && !row.url.includes('/host/settings/'))).toBe(true); onlyConfiguration();
});

test('系统默认设备，设备与项目 runtime 草稿独立；恢复继承使用每键 null', async () => {
  await system(); expect(select().value).toBe('device');
  let field = detail().querySelector('input[data-runtime-input="concurrency"]'); input(field, '9');
  await switchScope('project'); input(detail().querySelector('input[data-runtime-input="concurrency"]'), '7');
  await switchScope('device'); expect(detail().querySelector('input[data-runtime-input="concurrency"]').value).toBe('9');
  await switchScope('project'); expect(detail().querySelector('input[data-runtime-input="concurrency"]').value).toBe('7');
  await detail().querySelector('button[data-runtime-action="reset"]').onclick();
  expect(writes.at(-1)).toEqual({ method: 'system.configure', params: { settings: { concurrency: null, control_concurrency: null }, scope: 'project' } });
});

test('网络非秘密草稿按层保存，切层清空认证；网络迟到读取与保存不覆盖新层', async () => {
  await system(); let root = detail().querySelector('.agent-network-block'); await button(root, '读取网络设置').onclick();
  input(root.querySelector('[data-network-field="proxy_url"]'), 'http://device-draft.invalid');
  const auth = root.querySelector('[data-network-field="auth"]'); auth.value = 'set'; auth.onchange();
  const secret = root.querySelector('[data-network-field="password"]'); input(secret, 'SECRET-INPUT');
  await switchScope('project'); expect(secret.value).toBe(''); root = detail().querySelector('.agent-network-block');
  const pending = deferred(); intercept = ({ path, scope }) => path === '/api/agent/network' && scope === 'project' ? pending.promise : null;
  const loading = button(root, '读取网络设置').onclick(); await switchScope('device'); intercept = null; pending.resolve(json(networks.project)); await loading;
  root = detail().querySelector('.agent-network-block'); expect(root.querySelector('[data-network-field="proxy_url"]').value).toBe('http://device-draft.invalid');
  const savePending = deferred(); intercept = ({ params }) => params?.method === 'agent.network.configure' ? savePending.promise : null;
  const saving = button(root, '保存网络设置').onclick(); await switchScope('project'); savePending.resolve(json(networks.device)); await saving;
  expect(select().value).toBe('project'); expect(deepText(detail())).not.toContain('SECRET-INPUT'); expect(writes.at(-1).params.scope).toBe('device');
});

test('来源范围只使用后台标识；项目视图编辑明确共享来源仍向设备层提交', async () => {
  Object.assign(sources[0], { scope: 'device', configuration_scope: metadata('device') });
  await openModelSources(); expect(select().value).toBe('device'); expect(detail().querySelectorAll('.model-source-row')).toHaveLength(1);
  await switchScope('project'); expect(detail().querySelectorAll('.model-source-row')).toHaveLength(2);
  const row = detail().querySelector(`[data-source-id="${sources[0].id}"]`); expect(deepText(row)).toContain('设备共享');
  const legacy = detail().querySelector(`[data-source-id="${sources[1].id}"]`); expect(deepText(legacy)).toContain('本项目来源');
  await button(row, '详情').onclick(); await button(detail().querySelector('.agent-connection-card'), '编辑').onclick(); input(sourceField('label'), '共享来源新名称');
  await button(detail(), '保存连接').onclick();
  const saved = writes.find(row => row.method === 'agent.connections.save'); expect(saved.params.scope).toBe('device');
  for (const key of ['storage_scope', 'scope', 'configuration_scope', 'credential', 'observation', 'consumers']) expect(saved.params.connection).not.toHaveProperty(key);
  onlyConfiguration();
});

test('批量完整保存过滤来源只读范围字段，仍按各来源实际存储范围提交', async () => {
  for (const row of sources) Object.assign(row, { scope: row.storage_scope, configuration_scope: metadata(row.storage_scope),
    default_model: 'fixture-model', default_thinking: 'high', notify_reset: true });
  await openModelSources(); await switchScope('project'); await button(detail(), '选择当前筛选结果').onclick();
  const disabling = button(detail(), '批量停用').onclick(); await dialogButton(dom, '确认执行').onclick(); await disabling;
  const saved = writes.filter(row => row.method === 'agent.connections.save'); expect(saved).toHaveLength(2);
  for (const request of saved) {
    const original = sources.find(row => row.id === request.params.connection.id);
    expect(request.params.scope).toBe(original.storage_scope);
    expect(request.params.connection).toMatchObject({ enabled: false, models: original.models, default_model: 'fixture-model', default_thinking: 'high', notify_reset: true });
    expect(Object.keys(request.params.connection).sort()).toEqual(['id', 'label', 'provider', 'endpoint', 'auth_type', 'enabled', 'models', 'default_model', 'default_thinking', 'notify_reset'].sort());
    expect(request.params).not.toHaveProperty('credential');
  }
  onlyConfiguration();
});

test('来源切层保留各层公开编辑草稿，但清除 API Key，不把项目来源猜成共享身份', async () => {
  await openModelSources(); await button(detail(), '添加连接').onclick(); input(sourceField('label'), '设备新来源草稿');
  const secret = sourceField('api_key'); input(secret, 'NEVER-PERSIST'); await switchScope('project'); expect(secret.value).toBe('');
  await button(detail(), '添加连接').onclick(); input(sourceField('label'), '项目新来源草稿');
  await switchScope('device'); expect(sourceField('label').value).toBe('设备新来源草稿'); expect(sourceField('api_key').value).toBe('');
  await switchScope('project'); expect(sourceField('label').value).toBe('项目新来源草稿'); expect(writes).toHaveLength(0);
});

test('迁移显式预检、不修改配置；确认后只提交固定 revision，不调用 Agent', async () => {
  await system(); expect(requests.filter(row => row.path === '/api/settings/migration')).toHaveLength(0);
  await button(detail(), '预检迁移范围').onclick(); expect(writes).toHaveLength(0); expect(deepText(detail())).toContain('/fixture/device/shared/agent.json');
  const applying = button(detail(), '确认迁移到设备共享').onclick(); expect(writes).toHaveLength(0); expect(dialogText(dom)).toContain('不迁移项目历史');
  await dialogButton(dom, '备份并迁移').onclick(); await applying;
  expect(writes).toEqual([{ method: 'settings.migration.apply', params: { revision: 'revision-1', confirm: true } }]);
  expect(deepText(detail())).toContain('备份：/fixture/project/.lush/migration-backup'); onlyConfiguration();
});

test('迁移冲突阻止应用；过期预检失败后要求重新预检，离页响应不重画', async () => {
  migration.blockers = ['共享层已有不同配置']; migration.can_migrate = false; await system(); await button(detail(), '预检迁移范围').onclick();
  expect(button(detail(), '确认迁移到设备共享').disabled).toBe(true); expect(deepText(detail())).toContain('阻挡：共享层已有不同配置');
  migration.blockers = []; migration.can_migrate = true; await button(detail(), '预检迁移范围').onclick();
  intercept = ({ params }) => params?.method === 'settings.migration.apply' ? json({ error: 'revision changed' }, 409) : null;
  const applying = button(detail(), '确认迁移到设备共享').onclick(); await dialogButton(dom, '备份并迁移').onclick(); await applying;
  expect(deepText(detail())).toContain('请重新预检'); expect(button(detail(), '确认迁移到设备共享').disabled).toBe(true);
  const pending = deferred(); intercept = ({ path }) => path === '/api/settings/migration' ? pending.promise : null;
  const preflight = button(detail(), '预检迁移范围').onclick(); activateDetailView({ view: 'docs' }); detail().replaceChildren(dom.document.createElement('h1'));
  pending.resolve(json(migration)); await preflight; expect(deepText(detail())).not.toContain('Agent 配置');
});

test('没有可迁移条目时不提交无操作迁移，也不误报迁移中断', async () => {
  migration.items = []; migration.warnings = ['当前项目没有可迁移的设置；没有扫描其他项目。'];
  await system(); await button(detail(), '预检迁移范围').onclick();
  expect(deepText(detail())).toContain('当前项目没有可迁移的设置；未修改任何配置。');
  expect(button(detail(), '确认迁移到设备共享').disabled).toBe(true);
  await button(detail(), '确认迁移到设备共享').onclick(); expect(writes).toHaveLength(0);
});

test('无项目允许三类配置与系统管理；只走 Host 配置 API，无历史/重启/消费者/模型调用', async () => {
  noProject = true; dom.location.pathname = '/'; await boot(); requests.length = 0; writes.length = 0;
  for (const id of ['agent-open', 'model-sources-open', 'quick-explain-open', 'settings-open']) expect(dom.node(id).disabled).toBe(false);
  await openAgentStatus(); expect(select().disabled).toBe(true); input(agentField('append_prompt'), 'Host 共享规则'); await button(detail(), '读取共享来源').onclick(); await button(detail().querySelector('[data-agent-target="default"]'), '保存配置').onclick();
  await openModelSources(); expect(button(detail(), '后台采样设置')).toBeUndefined(); expect(button(detail(), '查看旧余额历史存档')).toBeUndefined();
  await openQuickExplanationPage(); expect(button(detail(), '刷新历史')).toBeUndefined(); input(quickField('prompt'), 'Host 解释设置'); await button(detail(), '保存解释设置').onclick();
  await system(); expect(detail().querySelector('.settings-migration')).toBeNull(); expect(button(detail(), '重启后台')).toBeUndefined();
  expect(requests.every(row => row.url.startsWith('/api/host/settings/'))).toBe(true);
  expect(requests.every(row => !/history|consumers|restart|quick-explain\/start/.test(row.url))).toBe(true);
  expect(writes.every(row => row.params.scope === 'device')).toBe(true); onlyConfiguration();
});

test('旧后台缺少范围 metadata 时拒绝读成设备配置，来源读失败也不能提交写入', async () => {
  intercept = ({ path }) => path === '/api/agent/config' ? json({ ...agents.device, configuration_scope: undefined }) : null;
  await openAgentStatus(); expect(deepText(detail())).toContain('后台未确认所选设置作用域'); expect(button(detail(), '保存配置')).toBeUndefined();
  intercept = ({ path }) => path === '/api/agent/connections' ? json({ version: 1, connections: sources }) : null;
  await openModelSources(); await button(detail(), '添加连接').onclick(); input(sourceField('label'), '不应写入旧项目');
  await button(detail(), '保存连接').onclick(); expect(writes).toHaveLength(0);
  await expect(settingsClient().action('worker.spawn', { goal: '禁止' })).rejects.toThrow('不属于配置管理');
});

test('Agent 与 runtime 保存迟到成功不会丢失同层随后编辑的草稿', async () => {
  await openAgentStatus(); const card = detail().querySelector('[data-agent-target="default"]'); await button(card, '读取共享来源').onclick();
  input(agentField('append_prompt'), '提交时的规则'); const pending = deferred();
  intercept = ({ params }) => params?.method === 'agent.configure' ? pending.promise : null;
  const saving = button(card, '保存配置').onclick(); input(agentField('append_prompt'), '随后编辑的规则');
  pending.resolve(json({ ...agents.device, default: { ...agents.device.default, append_prompt: '提交时的规则' } })); await saving;
  expect(agentField('append_prompt').value).toBe('随后编辑的规则');
  intercept = null; await system(); input(detail().querySelector('input[data-runtime-input="concurrency"]'), '8');
  const runtimePending = deferred(); intercept = ({ params }) => params?.method === 'system.configure' ? runtimePending.promise : null;
  const saveRuntime = detail().querySelector('button[data-runtime-action="save"]').onclick();
  input(detail().querySelector('input[data-runtime-input="max_depth"]'), '11');
  runtimePending.resolve(json(runtime.device)); await saveRuntime; expect(detail().querySelector('input[data-runtime-input="max_depth"]').value).toBe('11');
});

test('切层后的网络迟到读取被丢弃，返回原层可以重新读取而不是永久禁用', async () => {
  await system(); await switchScope('project'); let root = detail().querySelector('.agent-network-block'); const pending = deferred();
  intercept = ({ path }) => path === '/api/agent/network' ? pending.promise : null;
  const loading = button(root, '读取网络设置').onclick(); await switchScope('device'); pending.resolve(json(networks.project)); await loading;
  intercept = null; await switchScope('project'); root = detail().querySelector('.agent-network-block');
  expect(button(root, '读取网络设置').disabled).toBe(false); await button(root, '读取网络设置').onclick();
  expect(root.querySelector('[data-network-field="proxy_url"]').value).toBe('http://project.invalid:8080');
});

test('后台即便误报 can_migrate，存在阻挡或已迁移时仍不可再次应用', async () => {
  await system(); migration.can_migrate = true; migration.blockers = ['不能覆盖共享凭证']; await button(detail(), '预检迁移范围').onclick();
  expect(button(detail(), '确认迁移到设备共享').disabled).toBe(true); await button(detail(), '确认迁移到设备共享').onclick(); expect(writes).toHaveLength(0);
  migration.blockers = []; migration.already_migrated = true; await button(detail(), '预检迁移范围').onclick();
  expect(button(detail(), '确认迁移到设备共享').disabled).toBe(true); expect(deepText(detail())).toContain('不会重复导入'); expect(writes).toHaveLength(0);
});

test('环境变量读取/目标切换只重画自己的面板，作用域分别保留目标与 Agent 草稿', async () => {
  await openAgentStatus(); input(agentField('append_prompt'), '不被环境读取覆盖的规则');
  let env = detail().querySelector('.agent-env-block'); await button(env, '读取变量').onclick();
  expect(agentField('append_prompt').value).toBe('不被环境读取覆盖的规则');
  env = detail().querySelector('.agent-env-block'); let target = env.querySelector('select.agent-env-target');
  target.value = 'agent'; await target.listeners.change[0]();
  expect(agentField('append_prompt').value).toBe('不被环境读取覆盖的规则');
  await switchScope('project'); env = detail().querySelector('.agent-env-block'); expect(env.querySelector('select.agent-env-target').value).toBe('common');
  await switchScope('device'); env = detail().querySelector('.agent-env-block'); expect(env.querySelector('select.agent-env-target').value).toBe('agent');
  expect(agentField('append_prompt').value).toBe('不被环境读取覆盖的规则');
  target = env.querySelector('select.agent-env-target'); target.value = 'common'; await target.listeners.change[0]();
  expect(detail().querySelector('.agent-env-block').querySelector('input.agent-env-value').value).toBe('device-value');
});

test('清除项目覆盖的迟到成功不干扰设备草稿，返回项目层重新读取已继承配置', async () => {
  await openAgentStatus(); input(agentField('append_prompt'), '设备保留草稿'); await switchScope('project');
  const pending = deferred(); intercept = ({ params }) => params?.method === 'settings.clear_override' ? pending.promise : null;
  const clearing = detail().querySelector('button[data-clear-override="agent"]').onclick(); const confirming = dialogButton(dom, '清除并继承').onclick();
  await confirming; await switchScope('device'); agents.project = { ...structuredClone(agents.device), configuration_scope: metadata('project', false) };
  pending.resolve(json(agents.project)); await clearing; expect(agentField('append_prompt').value).toBe('设备保留草稿');
  intercept = null; await switchScope('project'); expect(agentField('append_prompt').value).toBe('device-prompt');
});
