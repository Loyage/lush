import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { makeWorld } from './dom-world.js';

const fixture = () => ({ version: 2, checked_at: '2026-10-01T09:00:00.000Z',
  scope: { project: '/tmp/demo', note: '项目执行机器的软件安装检查' },
  software: [
    { agent: 'pi', command: 'pi', executable: '/bin/pi', real_path: '/opt/pi/cli.js', version: '1.0.0', status: 'available', warning: null },
    { agent: 'codex', command: 'codex', executable: null, real_path: null, version: null, status: 'unavailable', warning: '未发现 Codex 软件' },
  ], warnings: [] });
const json = data => ({ ok: true, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const world = makeWorld(), requests = [];
let intercept = null, calls = 0, configIntercept = null, configCalls = 0, configureIntercept = null;
const dom = installDom({ fetch: (url, options) => {
  const path = String(url); requests.push(path);
  if (path === '/api/agent/status') { calls++; return intercept?.() ?? Promise.resolve(json(fixture())); }
  if (path === '/api/agent/config') { configCalls++; if (configIntercept) return configIntercept(); }
  if (path === '/api/action' && configureIntercept && JSON.parse(options.body).method === 'agent.configure') return configureIntercept();
  return world.fetchImpl(url, options);
} });
const { ui } = await import('../../src/ui/web/assets/state.js');
const { openAgentStatus, renderAgentStatus } = await import('../../src/ui/web/assets/render-agent-status.js');
const { boot } = await import('../../src/ui/web/assets/app.js');
await boot();
afterAll(() => dom.restore());
const detail = () => dom.node('detail');
const pageText = () => deepText(detail());
const refresh = () => detail().querySelector('.agent-status-refresh');
const tab = id => detail().querySelector(`button[data-agent-tab="${id}"]`);
const openDiagnosis = async () => { await openAgentStatus(); return tab('status').onclick(); };
const fresh = async () => { await dom.node('home').onclick(); return openAgentStatus(); };
const expectSelected = id => {
  const entries = [...['overview', 'task-graph', 'agent-status', 'model-sources', 'settings', 'docs'].map(key => [key, dom.node(`${key}-open`)]), ...ui.navButtons];
  expect(entries.filter(([, node]) => node.classList.contains('selected')).map(([key]) => key)).toEqual([id]);
  expect(entries.filter(([, node]) => node.getAttribute('aria-current') === 'page').map(([key]) => key)).toEqual([id]);
};

test('Agent配置默认读取配置不检查软件或旧查询，Prompt与资源管理保留，导航准确', async () => {
  dom.node('sidebar').classList.add('mobile-open');
  const before = calls; requests.length = 0; await dom.node('agent-status-open').onclick();
  expectSelected('agent-status'); expect(dom.location.hash).toBe('#agent-status');
  expect(dom.node('view-title').textContent).toBe('Agent 配置'); expect(detail().querySelector('h1').textContent).toBe('Agent 配置');
  expect(dom.node('sidebar').classList.contains('mobile-open')).toBe(false);
  expect(tab('settings').getAttribute('aria-selected')).toBe('true'); expect(tab('connections')).toBeNull();
  for (const value of ['模型与运行', '工作方式', '高级', 'Prompt', 'Skills', '扩展', 'Pi → 未选择来源 → 请选择来源内模型', '不继承用户全局 Pi 设置或 Prompt']) expect(pageText()).toContain(value);
  expect(refresh().parentNode.hidden).toBe(true); expect(calls).toBe(before);
  expect(requests.some(path => path.includes('/usage/'))).toBe(false);
  await findByText(detail().querySelector('[data-agent-target="default"]'), '读取项目连接').onclick();
  await until(() => !pageText().includes('读取中…'));
  const content = pageText(), pushes = dom.pushed(); await openAgentStatus();
  await dom.intervalFor(1500)(); await dom.intervalFor(3000)();
  expect(calls).toBe(before); expect(pageText()).toBe(content); expect(dom.pushed()).toBe(pushes);
});

test('显式软件检查保留配置草稿，诊断缓存且不读旧账号历史/配置，不联网不调用Agent', async () => {
  await fresh(); const before = calls; requests.length = 0;
  const settingsPanel = detail().querySelector('.agent-management-settings');
  const model = settingsPanel.querySelector('input[data-agent-field="model"]'); model.value = 'unsaved-model';
  await tab('status').onclick(); expect(calls).toBe(before + 1);
  expect(detail().querySelector('.agent-management-status').hidden).toBe(false);
  for (const value of ['软件诊断', '不读取账号或凭证', '1.0.0', '不可用']) expect(pageText()).toContain(value);
  expect(requests).toEqual(['/api/agent/status']); expect(detail().querySelector('.agent-usage-panel')).toBeNull();
  expect(refresh().getAttribute('data-help')).toContain('不启动 Agent 或模型调用'); expect(refresh().getAttribute('data-help')).toContain('不联网');
  expect(refresh().parentNode.classList.contains('help-host')).toBe(true); expect(refresh().classList.contains('agent-call')).toBe(false);
  expect(tab('status').getAttribute('data-help')).toContain('不联网');
  await tab('settings').onclick(); await dom.intervalFor(1500)(); await tab('status').onclick(); await tab('settings').onclick();
  expect(settingsPanel.querySelector('input[data-agent-field="model"]')).toBe(model); expect(model.value).toBe('unsaved-model');
  expect(calls).toBe(before + 1); expectSelected('agent-status');
});

test('默认配置按需单飞读取，不依赖overview完整配置，保存不调用Agent', async () => {
  await dom.node('home').onclick(); delete ui.lastSnapshot.status.agent_config;
  const pending = deferred(); configIntercept = () => pending.promise;
  const beforeConfig = configCalls, before = calls;
  const first = openAgentStatus(), second = openAgentStatus();
  expect(configCalls).toBe(beforeConfig + 1); expect(calls).toBe(before); expect(pageText()).toContain('正在读取 Agent 配置');
  pending.resolve(json(world.state.agentConfig)); await Promise.all([first, second]); configIntercept = null;
  expect(pageText()).toContain('默认 Agent');
  const profile = detail().querySelector('[data-agent-target="default"]'); await findByText(profile, '读取项目连接').onclick();
  const choice = profile.querySelector('[data-agent-field="connection_id"]'); choice.value = world.state.agentConnections.connections[0].id; choice.onchange();
  profile.querySelector('input[data-agent-field="model"]').value = 'openai-compatible/fixture-model';
  const save = findByText(profile, '保存配置'); expect(save.classList.contains('agent-call')).toBe(false); await save.onclick();
  expect(world.state.agentConfig.default.model).toBe('openai-compatible/fixture-model'); expect(pageText()).toContain('openai-compatible/fixture-model');
});

test('配置读取失败可重试，迟到读取不覆盖系统设置或返回后的新Agent页', async () => {
  await dom.node('home').onclick(); delete ui.lastSnapshot.status.agent_config;
  configIntercept = () => Promise.reject(new Error('配置不可用')); await openAgentStatus();
  expect(pageText()).toContain('读取 Agent 配置失败：配置不可用');
  const pending = deferred(); configIntercept = () => pending.promise;
  const retry = findByText(detail(), '重新读取配置').onclick(); await dom.node('settings-open').onclick();
  pending.resolve(json({ ...world.state.agentConfig, file: 'OLD-CONFIG' })); await retry; configIntercept = null;
  expectSelected('settings'); expect(pageText()).not.toContain('OLD-CONFIG');
  await dom.node('home').onclick(); delete ui.lastSnapshot.status.agent_config;
  const old = deferred(); configIntercept = () => old.promise; const stale = openAgentStatus();
  await dom.node('home').onclick(); configIntercept = null; await openAgentStatus();
  old.resolve(json({ ...world.state.agentConfig, file: 'STALE-CONFIG' })); await stale;
  expectSelected('agent-status'); expect(pageText()).not.toContain('STALE-CONFIG'); expect(pageText()).toContain('默认 Agent');
});

test('配置保存的迟到回调不能抢回已离开的页面', async () => {
  await fresh(); await findByText(detail().querySelector('[data-agent-target="default"]'), '读取项目连接').onclick();
  const pending = deferred(); configureIntercept = () => pending.promise;
  const saving = findByText(detail().querySelector('[data-agent-target="default"]'), '保存配置').onclick();
  await dom.node('settings-open').onclick(); pending.resolve(json(world.state.agentConfig)); await saving; configureIntercept = null;
  expectSelected('settings'); expect(detail().querySelector('.agent-settings')).toBeNull();
});

test('软件刷新单飞，失败保留上次检查，离页响应不覆盖', async () => {
  await fresh(); await openDiagnosis(); const before = calls;
  const results = detail().querySelector('.agent-status-results'); expect(results.querySelector('input')).toBeNull(); expect(results.querySelector('select')).toBeNull();
  const pending = deferred(); intercept = () => pending.promise;
  const one = refresh().onclick(), two = refresh().onclick(); expect(calls).toBe(before + 1);
  pending.resolve(json(fixture())); await Promise.all([one, two]); intercept = () => Promise.reject(new Error('测试刷新失败'));
  await refresh().onclick(); expect(pageText()).toContain('并非最新状态'); expect(pageText()).toContain('1.0.0');
  expect(refresh().disabled).toBe(false); intercept = null;
  await fresh(); const old = deferred(); intercept = () => old.promise;
  const loading = tab('status').onclick(); await dom.node('settings-open').onclick();
  const stale = fixture(); stale.software[0].version = 'OLD-LATE'; old.resolve(json(stale)); await loading; intercept = null;
  expectSelected('settings'); expect(pageText()).not.toContain('OLD-LATE');
});

test('诊断首次失败可重试且仍可编辑配置，不创建旧历史或查询设置', async () => {
  await fresh(); intercept = () => Promise.reject(new Error('测试连接失败')); await openDiagnosis(); intercept = null;
  expect(pageText()).toContain('检查失败：测试连接失败'); expect(detail().querySelector('.agent-usage-panel')).toBeNull();
  expect(refresh().textContent).toBe('重新检查'); await refresh().onclick(); expect(pageText()).toContain('检查完成');
  await tab('settings').onclick(); expect(detail().querySelector('.agent-management-settings').hidden).toBe(false);
});

test('软件只展示命令、路径、版本与可用性，忽略所有额外旧诊断字段', () => {
  const data = { ...fixture(), runtime: { config_dir: 'OLD-CONFIG-DIR' }, accounts: [{ identity: 'OLD-ACCOUNT' }],
    models: { models: [{ id: 'OLD-MODEL' }] }, resources: { skills: [{ label: 'OLD-RESOURCE' }] }, usage_config: { custom: [{ label: 'OLD-QUERY' }] } };
  const text = deepText(renderAgentStatus(data));
  for (const value of ['Pi 软件', 'Codex 软件', '/opt/pi/cli.js', '1.0.0', '可用', '不可用', '未发现 Codex 软件',
    '安装路径可能是全局目录', '软件可用不代表账号已认证或模型可调用']) expect(text).toContain(value);
  for (const value of ['OLD-CONFIG-DIR', 'OLD-ACCOUNT', 'OLD-MODEL', 'OLD-RESOURCE', 'OLD-QUERY']) expect(text).not.toContain(value);
});

test('缺少软件、重复软件或未知可用性不能冒充有效新诊断', () => {
  for (const software of [[fixture().software[0]], [fixture().software[0], fixture().software[0]],
    [fixture().software[0], { ...fixture().software[1], status: 'configured' }]]) {
    const text = deepText(renderAgentStatus({ ...fixture(), software }));
    expect(text).toContain('请更新项目后台与界面服务'); expect(text).not.toContain('Pi 软件');
  }
});

test('拒绝旧version1响应，提示更新服务并允许重试软件契约', async () => {
  const legacy = { version: 1, agent: 'pi', accounts: [{ identity: 'LEGACY-ACCOUNT' }], runtime: { version: 'LEGACY-VERSION' } };
  const text = deepText(renderAgentStatus(legacy)); expect(text).toContain('请更新项目后台与界面服务'); expect(text).not.toContain('LEGACY-');
  await fresh(); intercept = () => Promise.resolve(json(legacy)); await openDiagnosis(); intercept = null;
  expect(pageText()).toContain('请更新项目后台与界面服务'); expect(pageText()).not.toContain('LEGACY-');
  await refresh().onclick(); expect(pageText()).toContain('1.0.0');
});

test('离页返回的新诊断不会接受旧页面迟到软件结果', async () => {
  await fresh(); const pending = deferred(); intercept = () => pending.promise;
  const old = tab('status').onclick(); await fresh(); intercept = null; await tab('status').onclick();
  const stale = fixture(); stale.software[0].version = 'STALE-VERSION'; pending.resolve(json(stale)); await old;
  expect(pageText()).toContain('1.0.0'); expect(pageText()).not.toContain('STALE-VERSION');
});

test('诊断资料中的HTML只当文本，无内联样式或秘密回显', () => {
  const payload = '<img src=x onerror=alert(1)>', data = fixture();
  data.software[0].command = payload; data.software[1].warning = payload; data.warnings = [payload];
  const root = renderAgentStatus(data); expect(deepText(root)).toContain(payload); expect(root.querySelectorAll('img')).toHaveLength(0);
  expect(root.querySelectorAll('script')).toHaveLength(0);
  const source = fs.readFileSync(new URL('../../src/ui/web/assets/render-agent-status.js', import.meta.url), 'utf8');
  expect(source).not.toContain('innerHTML'); expect(source).not.toContain('.style');
});

test('深链接与重复boot不自动检查，双页导航发布且保留旧地址', async () => {
  dom.location.hash = '#agent-status'; const before = calls;
  await boot(); expectSelected('agent-status'); await boot(); expectSelected('agent-status'); expect(calls).toBe(before);
  const html = fs.readFileSync(new URL('../../src/ui/web/assets/index.html', import.meta.url), 'utf8');
  expect(html).toContain('id="agent-status-open"'); expect(html).toContain('id="model-sources-open"');
  expect(html).toContain('<strong>Agent 配置</strong>'); expect(html).toContain('<strong>模型来源</strong>');
  expect(html).toContain('打开只读本地配置'); expect(html).not.toContain('<strong>Agent 管理</strong>');
  const css = fs.readFileSync(new URL('../../src/ui/web/assets/styles-agent-status.css', import.meta.url), 'utf8');
  expect(css).toContain('var(--bg)'); expect(css).toContain('@media(max-width:600px)'); expect(css).toContain('.agent-config-section');
});
