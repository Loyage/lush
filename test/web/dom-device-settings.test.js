import { afterAll, beforeEach, expect, test } from 'bun:test';
import { installDom, deepText, dialogButton, dialogText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { openAgentStatus } from '../../src/ui/web/assets/render-agent-status.js';
import { openQuickExplanationPage, openQuickExplanationHistory } from '../../src/ui/web/assets/render-quick-explanation.js';
import { openModelSources } from '../../src/ui/web/assets/render-model-sources.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { settingsClient, settingsClientFor, projectSettingsAction } from '../../src/ui/web/assets/settings-api.js';

import { openSettings } from '../../src/ui/web/assets/render-settings.js';
import { renderSettingsMigration } from '../../src/ui/web/assets/settings-migration.js';

const sourceA = 'aaaaaaaaaaaaaaaa', sourceB = 'bbbbbbbbbbbbbbbb';
let projects;
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
  const scope = params?.params?.scope || parsed.searchParams.get('scope') || 'device';
  requests.push({ url: raw, path, options, params });
  if (options.method === 'POST') writes.push(params);
  const custom = intercept?.({ raw, path, params, scope }); if (custom) return custom;
  if (path === '/api/host') return json({ mode: noProject ? 'host' : 'bound', projects: noProject ? [] : [...projects, { id: dom.location.pathname.split('/')[2] }] });
  if (path === '/api/host/projects') return json({ projects });
  if (path === '/api/runtime') return json(runtime.device);
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
    if (method === 'settings.migration.apply') return json({ version: 1, migrated: true, backup: '/fixture/project/.lush/migration-backup', items: migration.items, warnings: [] });
    if (method === 'agent.connections.save') { const row = sources.find(entry => entry.id === p.connection.id); Object.assign(row, p.connection); return json(row); }
  }
  return world.fetchImpl(`${path}${parsed.search}`, options);
} });
// Component boundary tests do not start app-wide inbox/policy observers.
const { ensureProject } = await import('../../src/ui/web/assets/project-picker.js');
const detail = () => dom.node('detail');
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const agentField = name => detail().querySelector(`[data-agent-target="default"]`).querySelector(`[data-agent-field="${name}"]`);
const quickField = name => detail().querySelector(`[data-quick-field="${name}"]`);
const sourceField = name => detail().querySelector(`[data-connection-field="${name}"]`);
const input = (node, value) => { node.value = value; node.oninput?.(); for (const listener of node.listeners.input || []) listener(); };
const system = async () => { await openSettings(); await detail().querySelector('button.settings-tab[data-settings-tab="system"]').onclick(); };
const onlyConfiguration = () => expect(writes.every(row => !/worker|quick_explain\.(start|followup)|agent\.usage\.query/.test(row.method))).toBe(true);

beforeEach(async () => {
  intercept = null; noProject = false; projects = [{ id: sourceA, name: '登记来源 A', running: true }, { id: sourceB, name: '离线来源 B', running: false }]; dom.location.pathname = `/p/${String(++seq).padStart(16, '0')}/`; dom.location.hash = '';
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
  migration = { version: 1, revision: 'revision-1', can_migrate: true, already_migrated: false, blockers: [], warnings: ['保留私有备份与历史'],
    items: [{ kind: 'Agent 配置', action: '导入共享配置并退役项目覆盖', source: '/fixture/project/.lush/agent.json', destination: '/fixture/device/shared/agent.json' }] };
  await ensureProject(); activateDetailView({ view: 'overview' });
  ui.lastSnapshot = await (await world.fetchImpl('/api/snapshot')).json(); requests.length = 0; writes.length = 0;
});
afterAll(() => dom.restore());


test('设备 transport 默认且仅支持 device，所有项目/无项目/离线始终根 Host', async () => {
  const client = settingsClient();
  for (const path of ['/p/cccccccccccccccc/', '/', '/p/dddddddddddddddd/']) {
    dom.location.pathname = path; noProject = true;
    await client.read('/api/agent/config'); await client.action('agent.configure', { config: {} });
  }
  expect(requests.every(row => row.url.startsWith('/api/host/settings/'))).toBe(true);
  expect(client.project).toBe(false); expect(client.isCurrent()).toBe(true);
  expect(writes.every(row => row.params.scope === 'device')).toBe(true);
  expect(() => settingsClient('project')).toThrow('覆盖已停用');
  expect(() => settingsClientFor({ configuration_scope: metadata('project') })).toThrow('覆盖已停用');
  await expect(client.read('/api/agent/config?scope=project')).rejects.toThrow('覆盖已停用');
  await expect(client.read('/api/quick-explain/history')).rejects.toThrow('不属于配置管理');
  await expect(client.read('https://elsewhere.invalid/api/agent/config')).rejects.toThrow('不属于配置管理');
  await expect(client.action('settings.clear_override', {})).rejects.toThrow('不属于配置管理');
  await expect(client.action('worker.start', { id: 1 })).rejects.toThrow('不属于配置管理');
  await expect(client.action('agent.configure', { scope: 'project' })).rejects.toThrow('覆盖已停用');
  await expect(client.action('agent.configure', { _token: 'private-agent-token' })).rejects.toThrow('token');
});

test('旧项目范围模型不能冒充设备配置，失败无项目回退写入', async () => {
  intercept = ({ path }) => path === '/api/agent/config' ? json(agents.project) : null;
  await expect(settingsClient().read('/api/agent/config')).rejects.toThrow('未确认设备设置来源');
  intercept = ({ path }) => path === '/api/agent/connections' ? json({ connections: sources, configuration_scope: metadata('device') }) : json(agents.project);
  await expect(settingsClient().read('/api/agent/connections')).rejects.toThrow('旧项目来源');
  await expect(settingsClient().read('/api/agent/environment')).rejects.toThrow('未确认设备设置来源');
  await openAgentStatus(); expect(deepText(detail())).toContain('未确认设备设置来源');
  expect(detail().querySelector('[data-agent-target="default"]')).toBeNull(); expect(writes).toHaveLength(0);
});

test('Agent 配置移除项目切换和清覆盖，保留完整角色显式运行参数，不改项目快照', async () => {
  await openAgentStatus(); const snapshot = ui.lastSnapshot.status.agent_config;
  expect(detail().querySelector('select[data-settings-scope=""]')).toBeNull();
  expect(detail().querySelectorAll('button').some(node => Object.hasOwn(node.dataset, 'clearOverride'))).toBe(false);
  expect(deepText(detail())).toContain('当前读取：设备设置');
  const card = detail().querySelector('[data-agent-target="default"]');
  input(agentField('append_prompt'), '更新设备规则'); await button(card, '读取设备来源').onclick(); await button(card, '保存配置').onclick();
  expect(writes.at(-1)).toMatchObject({ method: 'agent.configure', params: { scope: 'device', config: { default: { append_prompt: '更新设备规则' } } } });
  expect(agents.project.default.append_prompt).toBe('project-prompt'); expect(ui.lastSnapshot.status.agent_config).toBe(snapshot);
  const role = detail().querySelector('[data-agent-target="agent"]'); expect(button(role, '单独配置')).toBeTruthy(); onlyConfiguration();
});

test('Agent 离页后的迟到设备读取不能占用新页面，仍只请求根 Host', async () => {
  const pending = deferred(); intercept = ({ path }) => path === '/api/agent/config' ? pending.promise : null;
  const opening = openAgentStatus(); activateDetailView({ view: 'settings' }); detail().replaceChildren();
  pending.resolve(json(agents.device)); await opening;
  expect(ui.view.id).toBe('settings'); expect(detail().querySelector('[data-agent-target="default"]')).toBeNull();
  expect(requests.every(row => row.url.startsWith('/api/host/settings/'))).toBe(true); expect(writes).toHaveLength(0);
});

test('环境变量仅设备读取/保存，按角色文件保留编辑能力，无项目清覆盖', async () => {
  await openAgentStatus(); let env = detail().querySelector('.agent-env-block'); await button(env, '读取变量').onclick(); env = detail().querySelector('.agent-env-block');
  const value = env.querySelector('input.agent-env-value'); expect(value.value).toBe('device-value'); expect(value.type).toBe('password'); input(value, '设备变量更新');
  await env.querySelector('[data-env-action="save"]').onclick();
  expect(writes.at(-1)).toMatchObject({ method: 'agent.environment.configure', params: { scope: 'device', target: 'common', values: { CUSTOM_SETTING: '设备变量更新' } } });
  expect(detail().querySelectorAll('button').some(node => Object.hasOwn(node.dataset, 'clearOverride'))).toBe(false); onlyConfiguration();
});

test('设备快捷解释只配置，根设置链接且不读取历史/不调用模型，迟到保存不改新页', async () => {
  dom.location.pathname = '/'; noProject = true; await openQuickExplanationPage();
  expect(requests.map(row => row.url)).toEqual(['/api/host/settings/quick-explain/config?scope=device', '/api/host/settings/agent/connections?scope=device']);
  expect(detail().querySelector('.quick-explanation-history')).toBeNull(); expect(detail().querySelector('a').href).toBe('/#model-sources');
  input(quickField('prompt'), '设备解释草稿'); const pending = deferred();
  intercept = ({ params }) => params?.method === 'quick_explain.configure' ? pending.promise : null;
  const saving = button(detail(), '保存解释设置').onclick(); activateDetailView({ view: 'docs' }); detail().replaceChildren();
  pending.resolve(json({ ...quick.device, prompt: 'LATE-SAVE' })); await saving;
  expect(ui.view.id).toBe('docs'); expect(deepText(detail())).not.toContain('LATE-SAVE'); expect(writes.at(-1).params.scope).toBe('device'); onlyConfiguration();
});

test('快捷解释历史导出仅固定项目路由读取，根页不能创建或读取全局历史', async () => {
  dom.location.pathname = '/'; await openQuickExplanationHistory(); expect(requests).toHaveLength(0);
  expect(deepText(detail())).toContain('不创建全局历史');
  activateDetailView({ view: 'overview' }); dom.location.pathname = `/p/${sourceA}/`;
  await openQuickExplanationHistory();
  expect(requests.map(row => row.url)).toEqual([`/p/${sourceA}/api/quick-explain/history?limit=30`]);
  expect(ui.view.id).toBe('quick-explain-history'); expect(dom.location.hash).toBe('#quick-explain-history'); expect(writes).toHaveLength(0);
});

test('设备来源没有项目历史/伪造消费者，配置修改不按项目路由传输', async () => {
  sources[0].consumers = [{ task_worker_number: 'W123', model: 'private-project-model' }]; await openModelSources();
  expect(detail().querySelector('select[data-settings-scope=""]')).toBeNull();
  expect(detail().querySelectorAll('button').some(node => Object.hasOwn(node.dataset, 'clearOverride'))).toBe(false);
  expect(button(detail(), '查看历史')).toBeUndefined(); expect(button(detail(), '查看旧余额历史存档')).toBeUndefined();
  expect(deepText(detail())).not.toContain('W123'); expect(deepText(detail())).not.toContain('private-project-model'); expect(deepText(detail())).not.toContain('旧项目来源');
  await button(detail(), '编辑').onclick(); input(sourceField('label'), '设备来源修改'); await button(detail(), '保存连接').onclick();
  expect(requests.findLast(row => row.options.method === 'POST').url).toBe('/api/host/settings/action'); expect(writes.at(-1)).toMatchObject({ method: 'agent.connections.save', params: { scope: 'device' } }); onlyConfiguration();
});

test('设备系统参数无项目快照仍可编辑，没有继承/清覆盖/项目服务控制', async () => {
  noProject = true; ui.lastSnapshot = null; await system();
  expect(detail().querySelector('select[data-settings-scope=""]')).toBeNull(); expect(detail().querySelectorAll('button').some(node => Object.hasOwn(node.dataset, 'clearOverride'))).toBe(false);
  expect(detail().querySelector('[data-system-field="project"]')).toBeNull(); expect(detail().querySelector('.service-restart-controls')).toBeNull();
  const field = detail().querySelector('[data-runtime-input="concurrency"]'); input(field, '7');
  await detail().querySelector('[data-runtime-action="save"]').onclick(); expect(runtime.device.concurrency.value).toBe(7);
  expect(writes.at(-1)).toEqual({ method: 'system.configure', params: { scope: 'device', settings: { concurrency: 7, control_concurrency: 1 } } });
  expect(runtime.project.concurrency.value).toBe(2); expect(ui.lastSnapshot).toBeNull(); onlyConfiguration();
});

const migrationPanel = async () => { const root = renderSettingsMigration(); detail().replaceChildren(root); await root.ready; return root; };
const pickMigration = (root, id) => { const node = root.querySelector('[data-migration-source=""]'); node.value = id; node.onchange(); };

test('迁移仅登记来源；离线/任意路径禁止，无扫描/后台启动，online 固定预检与 revision 确认', async () => {
  projects.push({ id: '../../unsafe', name: '无效' }); const root = await migrationPanel();
  expect(requests.map(row => row.url)).toEqual(['/api/host/projects']);
  expect(root.querySelector('[data-migration-source=""]').children.map(node => node.value)).toEqual(['', sourceA, sourceB]);
  pickMigration(root, sourceB); const preview = root.querySelector('[data-migration-action="preview"]'); expect(preview.disabled).toBe(true);
  await preview.onclick(); expect(requests).toHaveLength(1); expect(preview.parentNode.classList.contains('help-host')).toBe(true);
  pickMigration(root, sourceA); await preview.onclick(); expect(requests.at(-1).url).toBe(`/p/${sourceA}/api/settings/migration`);
  const applying = root.querySelector('[data-migration-action="apply"]').onclick(); expect(writes).toHaveLength(0); expect(dialogText(dom)).toContain('登记来源 A');
  await dialogButton(dom, '备份并迁移').onclick(); await applying;
  expect(requests.at(-1).url).toBe(`/p/${sourceA}/api/action`); expect(writes).toEqual([{ method: 'settings.migration.apply', params: { revision: 'revision-1', confirm: true } }]);
  expect(deepText(root)).toContain('迁移完成');
  await expect(projectSettingsAction('settings.migration.apply', {}, '../../unsafe')).rejects.toThrow('已登记');
  await expect(projectSettingsAction('worker.start', {}, sourceA)).rejects.toThrow('不是旧项目');
});

for (const action of ['导入设备本机补充；旧文件保留但不再活跃', '复用相同设备内容；旧文件保留但不再活跃']) {
  test(`Markdown 补充通用预检：${action}，只显示元数据并明确确认`, async () => {
    const privatePrompt = '# PRIVATE-MARKDOWN-PROMPT-NOT-FOR-PREVIEW';
    migration.items = ['common', 'agent'].map(role => ({ kind: 'Markdown 本机补充', action,
      source: `/fixture/project/.lush/agent/${role}.md`, destination: `/fixture/device/shared/agent/${role}.md`,
      content: privatePrompt })); // Deliberately unexpected content must never be echoed; it is not an API field.
    migration.warnings = ['影响设备所有项目；只影响后续调用，当前调用快照不变。', '旧私有本机补充保留但不再活跃；AGENTS.md 与 .lush-agent 项目约定不迁移。'];
    const root = await migrationPanel(); pickMigration(root, sourceA); await root.querySelector('[data-migration-action="preview"]').onclick();
    expect(root.querySelectorAll('.settings-migration-item')).toHaveLength(2);
    for (const item of migration.items) {
      expect(deepText(root)).toContain(item.source); expect(deepText(root)).toContain(item.destination); expect(deepText(root)).toContain(item.action);
    }
    for (const warning of migration.warnings) expect(deepText(root)).toContain(warning);
    expect(deepText(root)).not.toContain(privatePrompt); expect(root.querySelector('textarea')).toBeNull();
    const apply = root.querySelector('[data-migration-action="apply"]'); expect(apply.disabled).toBe(false);
    const cancel = apply.onclick(); expect(writes).toHaveLength(0);
    for (const item of migration.items) { expect(dialogText(dom)).toContain(item.source); expect(dialogText(dom)).toContain(item.destination); expect(dialogText(dom)).toContain(item.action); }
    for (const warning of migration.warnings) expect(dialogText(dom)).toContain(warning);
    expect(dialogText(dom)).not.toContain(privatePrompt);
    await dialogButton(dom, '取消').onclick(); await cancel; expect(writes).toHaveLength(0);
    const confirmed = apply.onclick(); expect(writes).toHaveLength(0); await dialogButton(dom, '备份并迁移').onclick(); await confirmed;
    expect(writes).toEqual([{ method: 'settings.migration.apply', params: { revision: 'revision-1', confirm: true } }]);
    expect(requests.map(row => row.url)).toEqual(['/api/host/projects', `/p/${sourceA}/api/settings/migration`, `/p/${sourceA}/api/action`]);
    expect(deepText(root)).not.toContain(privatePrompt); onlyConfiguration();
  });
}

test('Markdown 内容冲突通用显示阻挡与影响警告，禁确认且不发起迁移或读取正文', async () => {
  migration.items = [{ kind: 'Markdown 本机补充', action: '冲突，禁止覆盖', source: '/fixture/project/.lush/agent/common.md', destination: '/fixture/device/shared/agent/common.md' }];
  migration.blockers = ['common.md 与设备已有本机补充内容不同；不能静默覆盖。'];
  migration.warnings = ['影响设备所有项目；AGENTS.md 与 .lush-agent 项目约定不迁移。'];
  migration.can_migrate = true; // Even an inconsistent optimistic flag cannot override blockers.
  const root = await migrationPanel(); pickMigration(root, sourceA); await root.querySelector('[data-migration-action="preview"]').onclick();
  expect(deepText(root)).toContain(`阻挡：${migration.blockers[0]}`); expect(deepText(root)).toContain(`注意：${migration.warnings[0]}`);
  expect(deepText(root)).toContain(migration.items[0].source); expect(deepText(root)).toContain(migration.items[0].destination);
  const apply = root.querySelector('[data-migration-action="apply"]'); expect(apply.disabled).toBe(true);
  expect(apply.parentNode.classList.contains('help-host')).toBe(true); expect(apply.parentNode.getAttribute('data-help')).toBeTruthy();
  await apply.onclick(); expect(dialogText(dom)).toBe(''); expect(writes).toHaveLength(0);
  expect(root.querySelector('[data-migration-source=""]').value).toBe(sourceA);
  expect(requests.map(row => row.url)).toEqual(['/api/host/projects', `/p/${sourceA}/api/settings/migration`]);
});

test('迁移来源切换作废旧预检和确认，失败保留来源但不能重复用旧版本', async () => {
  const root = await migrationPanel(); pickMigration(root, sourceA); const pending = deferred();
  intercept = ({ path }) => path === '/api/settings/migration' ? pending.promise : null;
  const reading = root.querySelector('[data-migration-action="preview"]').onclick(); pickMigration(root, sourceB);
  pending.resolve(json({ ...migration, items: [{ ...migration.items[0], source: 'STALE-PREVIEW' }] })); await reading;
  expect(deepText(root)).not.toContain('STALE-PREVIEW'); expect(root.querySelector('[data-migration-action="apply"]').disabled).toBe(true);
  intercept = null; pickMigration(root, sourceA); await root.querySelector('[data-migration-action="preview"]').onclick();
  const applying = root.querySelector('[data-migration-action="apply"]').onclick(); pickMigration(root, sourceB);
  await dialogButton(dom, '备份并迁移').onclick(); await applying; expect(writes).toHaveLength(0);
  pickMigration(root, sourceA); await root.querySelector('[data-migration-action="preview"]').onclick();
  intercept = ({ params }) => params?.method === 'settings.migration.apply' ? json({ error: 'revision changed' }, 409) : null;
  const failed = root.querySelector('[data-migration-action="apply"]').onclick(); await dialogButton(dom, '备份并迁移').onclick(); await failed;
  expect(deepText(root)).toContain('重新预检'); expect(root.querySelector('[data-migration-source=""]').value).toBe(sourceA);
  expect(root.querySelector('[data-migration-action="apply"]').disabled).toBe(true);
});

test('迁移成功后设备重读失败明确区分，不宣称回滚或重复迁移', async () => {
  const root = renderSettingsMigration({ onMigrated: async () => { throw new Error('read failed'); } }); detail().replaceChildren(root); await root.ready;
  pickMigration(root, sourceA); await root.querySelector('[data-migration-action="preview"]').onclick();
  const applying = root.querySelector('[data-migration-action="apply"]').onclick(); await dialogButton(dom, '备份并迁移').onclick(); await applying;
  expect(deepText(root)).toContain('迁移已完成，请手动刷新'); expect(writes).toHaveLength(1);
});

test('偏好只调用设备保存/重置契约；等待/失败可见且不重置项目工作状态', async () => {
  const saved = [], pending = deferred(); let resets = 0;
  const actions = { saveDevicePreference: (name, value) => { saved.push({ name, value }); return pending.promise; },
    devicePreferencesStatus: () => ({ revision: 4, ready: true }), resetDevicePreferences: async () => { resets++; } };
  await openSettings({ preferenceActions: actions }); await detail().querySelector('[data-settings-tab="interface"]').onclick();
  const original = globalThis.localStorage.getItem('lush.markdown'); globalThis.localStorage.setItem('lush.project-folds', 'kept');
  const control = detail().querySelector('[data-pref="markdown"]'); control.checked = false;
  const saving = control.listeners.change[0](); expect(control.disabled).toBe(true); expect(control.parentNode.parentNode.classList.contains('help-host')).toBe(true);
  expect(deepText(detail())).toContain('正在保存设备偏好'); pending.resolve(); await saving;
  expect(saved).toEqual([{ name: 'markdown', value: false }]); expect(globalThis.localStorage.getItem('lush.markdown')).toBe(original);
  await detail().querySelector('.pref-reset').onclick(); expect(resets).toBe(1); expect(globalThis.localStorage.getItem('lush.project-folds')).toBe('kept');
  expect(deepText(detail())).toContain('项目工作状态保留'); expect(writes).toHaveLength(0);
});

test('偏好保存失败或旧契约缺失不退回 localStorage；离页旧按钮不会写入', async () => {
  const actions = { saveDevicePreference: async () => { throw new Error('revision conflict'); } };
  await openSettings({ preferenceActions: actions }); await detail().querySelector('[data-settings-tab="interface"]').onclick();
  const control = detail().querySelector('[data-pref="markdown"]'), original = globalThis.localStorage.getItem('lush.markdown'); control.checked = false;
  await control.listeners.change[0](); expect(deepText(detail())).toContain('revision conflict'); expect(globalThis.localStorage.getItem('lush.markdown')).toBe(original);
  await openSettings({ preferenceActions: {} }); await detail().querySelector('[data-settings-tab="interface"]').onclick();
  const unsupported = detail().querySelector('[data-pref="markdown"]'); unsupported.checked = false; await unsupported.listeners.change[0]();
  expect(deepText(detail())).toContain('尚不支持设备偏好保存');
  const reset = detail().querySelector('.pref-reset'); activateDetailView({ view: 'docs' }); const before = requests.length;
  await reset.onclick(); await unsupported.listeners.change[0](); expect(requests).toHaveLength(before); expect(writes).toHaveLength(0);
});

test('偏好先 GET 水合权威配置，ready/saving 只更新可用性，不重画正在编辑的控件', async () => {
  const pending = deferred(), status = { ready: false, saving: false, error: '', revision: null };
  let publish, reads = 0, saves = 0;
  const actions = { devicePreferencesStatus: () => status, refreshDevicePreferences: () => { reads++; return pending.promise; },
    onDevicePreferences: listener => { publish = listener; listener(status); return () => {}; },
    saveDevicePreference: async () => { saves++; }, resetDevicePreferences: async () => {} };
  const opening = openSettings({ preferenceActions: actions }); await detail().querySelector('[data-settings-tab="interface"]').onclick();
  const control = detail().querySelector('[data-pref="markdown"]'), before = globalThis.localStorage.getItem('lush.markdown');
  expect(reads).toBe(1); expect(control.disabled).toBe(true); expect(detail().querySelector('.pref-reset').disabled).toBe(true);
  expect(deepText(detail())).toContain('当前仅显示缓存'); await control.listeners.change[0](); expect(saves).toBe(0);
  Object.assign(status, { ready: true, revision: 'device-revision-1' }); publish(status); pending.resolve(); await opening;
  expect(control.disabled).toBe(false); expect(deepText(detail())).toContain('device-revision-1');
  control.checked = false; Object.assign(status, { saving: true }); publish(status);
  expect(detail().querySelector('[data-pref="markdown"]')).toBe(control); expect(control.checked).toBe(false); expect(control.disabled).toBe(true);
  Object.assign(status, { saving: false }); publish(status); expect(control.disabled).toBe(false);
  await control.listeners.change[0](); expect(saves).toBe(1); expect(globalThis.localStorage.getItem('lush.markdown')).toBe(before);
});

test('偏好权威读取失败可就地重试，不将旧缓存写回，不修改控件草稿', async () => {
  const status = { ready: false, saving: false, error: 'Host offline', revision: null }; let publish, fail = true, reads = 0;
  const actions = { devicePreferencesStatus: () => status, onDevicePreferences: listener => { publish = listener; listener(status); return () => {}; },
    refreshDevicePreferences: async () => { reads++; if (fail) throw new Error('Host offline'); Object.assign(status, { ready: true, error: '', revision: 'fresh' }); publish(status); } };
  const before = globalThis.localStorage.getItem('lush.markdown'); await openSettings({ preferenceActions: actions });
  await detail().querySelector('[data-settings-tab="interface"]').onclick();
  const control = detail().querySelector('[data-pref="markdown"]'); expect(control.disabled).toBe(true); expect(deepText(detail())).toContain('Host offline');
  control.checked = false; fail = false; await button(detail(), '重新读取设备偏好').onclick();
  expect(reads).toBe(2); expect(detail().querySelector('[data-pref="markdown"]')).toBe(control); expect(control.checked).toBe(false); expect(control.disabled).toBe(false);
  expect(deepText(detail())).not.toContain('Host offline'); expect(globalThis.localStorage.getItem('lush.markdown')).toBe(before); expect(writes).toHaveLength(0);
});

test('偏好状态订阅和水合迟到响应不能更新离开的页面或下一次设置页', async () => {
  const pending = deferred(); let oldPublish, disposed = 0;
  const old = { devicePreferencesStatus: () => ({ ready: false }), refreshDevicePreferences: () => pending.promise,
    onDevicePreferences: listener => { oldPublish = listener; listener({ ready: false }); return () => { disposed++; }; } };
  const opening = openSettings({ preferenceActions: old }); await detail().querySelector('[data-settings-tab="interface"]').onclick();
  activateDetailView({ view: 'docs' }); detail().replaceChildren(); oldPublish({ ready: false, error: 'OLD-PREFERENCE-ERROR' }); expect(deepText(detail())).toBe('');
  await openSettings({ preferenceActions: { devicePreferencesStatus: () => ({ ready: true, revision: 'new-page' }) } });
  const control = detail().querySelector('[data-pref="markdown"]'); expect(disposed).toBe(1); expect(control.disabled).toBe(false);
  oldPublish({ ready: false, error: 'OLD-PREFERENCE-ERROR' }); pending.resolve(); await opening;
  expect(control.disabled).toBe(false); expect(deepText(detail())).toContain('new-page'); expect(deepText(detail())).not.toContain('OLD-PREFERENCE-ERROR');
});
