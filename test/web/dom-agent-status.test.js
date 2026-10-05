import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const fixture = () => ({ version: 1, agent: 'pi', checked_at: '2026-10-01T09:00:00.000Z',
  scope: { project: '/tmp/demo', role: 'agent', note: '项目 daemon 公共与 agent 角色环境' },
  runtime: { command: 'pi', executable: '/bin/pi', real_path: '/opt/pi/cli.js', version: '1.0.0', config_dir: '/tmp/demo/.lush/pi', backend: 'pi', model: 'openai-codex/gpt-test' },
  models: { source: 'cli', models: [
    { id: 'openai-codex/gpt-test', label: 'GPT Test', provider: 'openai-codex', context: '200K', max_output: '32K', thinking: true, images: true },
    { id: 'deepseek/flash', label: 'Flash', provider: 'deepseek', context: '128K', thinking: false, images: false },
  ] },
  resources: { packages: [{ source: 'npm:example', root: '/tmp/pi/npm/example' }], extensions: [{ label: 'review.ts', id: '/tmp/pi/extensions/review.ts', source: '用户扩展' }], skills: [] },
  accounts: [{ provider: 'deepseek', auth_type: 'api_key', source: '环境变量', status: 'configured',
    balance: { status: 'available', kind: 'balance', items: [{ label: '账户余额', remaining: 12.25, unit: 'USD' }], checked_at: '2026-10-01T09:00:00Z' } }], warnings: [] });
const json = data => ({ ok: true, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const world = makeWorld();
let statusData = fixture(), intercept = null, calls = 0, configIntercept = null, configCalls = 0, configureIntercept = null;
const dom = installDom({ fetch: (url, options) => {
  const path = String(url);
  if (path === '/api/agent/status') { calls++; return intercept?.() ?? Promise.resolve(json(statusData)); }
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

test('Agent配置独立导航默认读取配置，不查询旧账号；页面标题、分区和唯一选中准确', async () => {
  dom.node('sidebar').classList.add('mobile-open');
  const before = calls; await dom.node('agent-status-open').onclick();
  expectSelected('agent-status'); expect(dom.location.hash).toBe('#agent-status');
  expect(dom.node('view-title').textContent).toBe('Agent 配置'); expect(detail().querySelector('h1').textContent).toBe('Agent 配置');
  expect(dom.node('sidebar').classList.contains('mobile-open')).toBe(false);
  expect(tab('settings').getAttribute('aria-selected')).toBe('true'); expect(tab('connections')).toBeNull();
  expect(pageText()).toContain('模型与运行'); expect(pageText()).toContain('工作方式'); expect(pageText()).toContain('高级');
  expect(pageText()).toContain('Pi → 未选择来源 → 请选择来源内模型');
  expect(pageText()).toContain('不继承用户全局 Pi 设置或 Prompt');
  expect(refresh().parentNode.hidden).toBe(true); expect(calls).toBe(before);
  await findByText(detail().querySelector('[data-agent-target="default"]'), '读取项目连接').onclick();
  const content = pageText(), pushes = dom.pushed(); await openAgentStatus();
  await dom.intervalFor(1500)(); await dom.intervalFor(3000)();
  expect(calls).toBe(before); expect(pageText()).toBe(content); expect(dom.pushed()).toBe(pushes);
});

test('显式诊断查询Lush独立Pi且保留配置草稿；返回诊断不重复查询，失败不会阻断配置', async () => {
  await fresh(); const before = calls;
  const settingsPanel = detail().querySelector('.agent-management-settings');
  const model = settingsPanel.querySelector('input[data-agent-field="model"]'); model.value = 'unsaved-model';
  await tab('status').onclick(); expect(calls).toBe(before + 1);
  expect(detail().querySelector('.agent-management-status').hidden).toBe(false);
  expect(pageText()).toContain('独立 Pi 诊断'); expect(pageText()).toContain('不读取用户全局 Pi 配置'); expect(pageText()).toContain('1.0.0'); expect(pageText()).toContain('12.25 USD');
  expect(refresh().getAttribute('data-help')).toContain('不启动 Agent 或模型调用'); expect(refresh().classList.contains('agent-call')).toBe(false);
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
  const profile = detail().querySelector('[data-agent-target="default"]');
  await findByText(profile, '读取项目连接').onclick();
  const choice = profile.querySelector('[data-agent-field="connection_id"]'); choice.value = world.state.agentConnections.connections[0].id; choice.onchange();
  profile.querySelector('input[data-agent-field="model"]').value = 'openai-compatible/fixture-model';
  const save = findByText(profile, '保存配置'); expect(save.classList.contains('agent-call')).toBe(false); await save.onclick();
  expect(world.state.agentConfig.default.model).toBe('openai-compatible/fixture-model'); expect(pageText()).toContain('openai-compatible/fixture-model');
});

test('配置读取失败可重试，迟到读取不会覆盖系统设置或返回后的新Agent页', async () => {
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
  await fresh();
  await findByText(detail().querySelector('[data-agent-target="default"]'), '读取项目连接').onclick();
  const pending = deferred(); configureIntercept = () => pending.promise;
  const saving = findByText(detail().querySelector('[data-agent-target="default"]'), '保存配置').onclick();
  await dom.node('settings-open').onclick(); pending.resolve(json(world.state.agentConfig)); await saving; configureIntercept = null;
  expectSelected('settings'); expect(detail().querySelector('.agent-settings')).toBeNull();
});

test('诊断模型搜索与筛选本地完成，刷新单飞、失败保留旧值，离页响应不覆盖', async () => {
  await fresh(); await openDiagnosis(); const before = calls;
  const results = detail().querySelector('.agent-status-results');
  const search = results.querySelector('input'), provider = results.querySelector('select');
  search.value = 'gpt'; search.oninput(); expect(deepText(results)).toContain('显示 1 / 2');
  provider.value = 'deepseek'; provider.onchange(); expect(results.querySelector('tbody').children).toHaveLength(0);
  expect(calls).toBe(before);
  const pending = deferred(); intercept = () => pending.promise;
  const one = refresh().onclick(), two = refresh().onclick(); expect(calls).toBe(before + 1);
  pending.resolve(json(fixture())); await Promise.all([one, two]); intercept = () => Promise.reject(new Error('测试刷新失败'));
  await refresh().onclick(); expect(pageText()).toContain('并非最新状态'); expect(pageText()).toContain('12.25 USD');
  expect(refresh().disabled).toBe(false); intercept = null;
  await fresh(); const old = deferred(); intercept = () => old.promise;
  const loading = tab('status').onclick(); await dom.node('settings-open').onclick();
  old.resolve(json({ ...fixture(), runtime: { version: 'OLD-LATE' } })); await loading; intercept = null;
  expectSelected('settings'); expect(pageText()).not.toContain('OLD-LATE');
});

test('诊断首次失败仍保留本地历史入口并可返回配置', async () => {
  await fresh(); intercept = () => Promise.reject(new Error('测试连接失败')); await openDiagnosis(); intercept = null;
  expect(pageText()).toContain('查询失败：测试连接失败'); expect(detail().querySelector('.agent-usage-panel').hidden).toBe(false);
  expect(pageText()).toContain('已读取本地缓存'); expect(refresh().textContent).toBe('重新查询');
  await tab('settings').onclick(); expect(detail().querySelector('.agent-management-settings').hidden).toBe(false);
});

test('兼容诊断保留准确目录来源、套餐窗口与认证错误，配置包未安装不能宣称已安装', () => {
  const data = fixture(); data.models.source = 'local'; data.resources.packages = [{ source: 'npm:missing', root: null }];
  data.accounts = [{ provider: 'openai-codex', balance: { status: 'available', kind: 'quota', items: [
    { label: '主要额度窗口', remaining: 99.5, total: 100, used_percent: 0.5, unit: '%', window_seconds: 18000 },
    { label: '次要额度窗口', unit: '%', window_seconds: 604800 }, { label: '未知窗口', unit: '%', window_seconds: null },
  ] } }];
  const text = deepText(renderAgentStatus(data));
  for (const value of ['本地模型目录（未联网验证）', '不执行密钥命令或刷新登录凭证', '不加载扩展动态模型', '5 小时窗口', '7 天（周）窗口', '窗口时长未知', '已用百分比 0.5 %', '不是实际 token', '不能确认已安装']) expect(text).toContain(value);
  expect(text).not.toContain('每日');
  for (const [code, message] of [['rate_limited', 'HTTP 429'], ['timeout', '查询超时'], ['auth_locked', '其他进程'], ['refresh_failed', '凭证刷新失败']]) {
    data.accounts[0].balance = { status: 'error', error_code: code, items: [] }; expect(deepText(renderAgentStatus(data))).toContain(message);
  }
});

test('余额未知、失败、真实零和最后成功旧值分别展示；成功后不残留旧值', () => {
  const data = fixture(); data.models = { source: 'presets', models: [{ id: 'preset' }] };
  data.accounts = [
    { provider: 'unknown', balance: { status: 'available', kind: 'balance', items: [{ remaining: null, unit: 'USD' }] } },
    { provider: 'error', balance: { status: 'error', kind: 'balance', items: [{ remaining: 0, unit: 'USD' }] } },
    { provider: 'zero', balance: { status: 'available', kind: 'quota', items: [{ remaining: 0, unit: '请求' }] } },
  ];
  const text = deepText(renderAgentStatus(data)); expect(text).toContain('内置预设'); expect(text).toContain('剩余 未知 USD');
  expect(text).not.toContain('剩余 0 USD'); expect(text).toContain('非现金余额'); expect(text).toContain('剩余 0 请求');
  data.accounts = [{ provider: 'codex', balance: { status: 'error', reason: '本次网络失败' }, last_success: { checked_at: '2026-09-29T09:00:00Z', balance: { status: 'available', kind: 'quota', items: [{ remaining: 42, unit: '%' }] } } }];
  let root = renderAgentStatus(data); expect(deepText(root)).toContain('缓存旧值，并非最新状态'); expect(deepText(root)).toContain('剩余 42 %');
  expect(deepText(root)).toContain('2026-09-29T09:00:00Z');
  data.accounts[0].balance = { status: 'available', kind: 'quota', items: [{ remaining: 20, unit: '%' }] };
  root = renderAgentStatus(data); expect(root.querySelectorAll('.agent-status-last-success')).toHaveLength(0);
});

test('诊断资料中的HTML只当文本，配置与来源页面无内联样式和秘密回显', () => {
  const payload = '<img src=x onerror=alert(1)>', data = fixture();
  data.runtime.command = payload; data.models.models[0].id = payload; data.warnings = [payload];
  const root = renderAgentStatus(data); expect(deepText(root)).toContain(payload); expect(root.querySelectorAll('img')).toHaveLength(0);
  expect(root.querySelectorAll('script')).toHaveLength(0);
  const source = fs.readFileSync(new URL('../../src/ui/web/assets/render-agent-status.js', import.meta.url), 'utf8');
  expect(source).not.toContain('innerHTML'); expect(source).not.toContain('.style');
});

test('Agent配置深链接启动与重复boot不自动查询账号，双页导航发布且保留旧地址', async () => {
  dom.location.hash = '#agent-status'; const before = calls;
  await boot(); expectSelected('agent-status'); await boot(); expectSelected('agent-status'); expect(calls).toBe(before);
  const html = fs.readFileSync(new URL('../../src/ui/web/assets/index.html', import.meta.url), 'utf8');
  expect(html).toContain('id="agent-status-open"'); expect(html).toContain('id="model-sources-open"');
  expect(html).toContain('<strong>Agent 配置</strong>'); expect(html).toContain('<strong>模型来源</strong>');
  expect(html).toContain('打开只读本地配置'); expect(html).not.toContain('<strong>Agent 管理</strong>');
  const css = fs.readFileSync(new URL('../../src/ui/web/assets/styles-agent-status.css', import.meta.url), 'utf8');
  expect(css).toContain('var(--bg)'); expect(css).toContain('@media(max-width:600px)'); expect(css).toContain('.agent-config-section');
});
