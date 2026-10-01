import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const fixture = () => ({ version: 1, agent: 'pi', checked_at: '2026-10-01T09:00:00.000Z',
  scope: { project: '/tmp/demo', role: 'agent', note: '项目 daemon 公共与 agent 角色环境' },
  runtime: { command: 'pi', executable: '/bin/pi', real_path: '/opt/pi/cli.js', version: '1.0.0', config_dir: '/tmp/pi', backend: 'pi', model: 'openai-codex/gpt-test' },
  models: { source: 'cli', models: [
    { id: 'openai-codex/gpt-test', label: 'GPT Test', provider: 'openai-codex', context: '200K', max_output: '32K', thinking: true, images: true },
    { id: 'deepseek/flash', label: 'Flash', provider: 'deepseek', context: '128K', thinking: false, images: false },
  ] },
  resources: { packages: [{ source: 'npm:example', root: '/tmp/pi/npm/example' }],
    extensions: [{ label: 'review.ts', id: '/tmp/pi/extensions/review.ts', source: '用户扩展' }],
    skills: [{ label: 'browser', id: '/tmp/pi/skills/browser/SKILL.md', description: '浏览器操作', source: '用户 Skills' }] },
  accounts: [
    { provider: 'openai-codex', auth_type: 'oauth', source: 'auth.json', identity: 't***@e***.com', status: 'expired', expires_at: '2026-09-30T00:00:00Z',
      balance: { status: 'unsupported', kind: null, items: [], reason: '订阅服务无可靠余额接口' } },
    { provider: 'deepseek', auth_type: 'api_key', source: '环境变量', identity: null, status: 'configured',
      balance: { status: 'available', kind: 'balance', items: [{ label: '账户余额', remaining: 12.25, total: null, used: null, unit: 'USD' }], checked_at: '2026-10-01T09:00:00Z' } },
  ], warnings: [] });
const json = data => ({ ok: true, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const world = makeWorld();
let statusData = fixture(), intercept = null, calls = 0;
const dom = installDom({ fetch: (url, options) => {
  const path = String(url);
  if (path === '/api/agent/status') { calls++; return intercept?.() ?? Promise.resolve(json(statusData)); }
  return world.fetchImpl(url, options);
} });
const { ui } = await import('../../src/ui/web/assets/state.js');
const { openAgentStatus, renderAgentStatus } = await import('../../src/ui/web/assets/render-agent-status.js');
const { boot } = await import('../../src/ui/web/assets/app.js');
await boot();
afterAll(() => dom.restore());
const pageText = () => deepText(dom.node('detail'));
const refresh = () => dom.node('detail').querySelector('.agent-status-refresh');
const expectSelected = id => {
  const entries = [...['overview', 'task-graph', 'agent-status', 'settings', 'docs'].map(key => [key, dom.node(`${key}-open`)]), ...ui.navButtons];
  expect(entries.filter(([, node]) => node.classList.contains('selected')).map(([key]) => key)).toEqual([id]);
  expect(entries.filter(([, node]) => node.getAttribute('aria-current') === 'page').map(([key]) => key)).toEqual([id]);
};

test('导航新增 Agent 状态平级页，查询安装、模型、账号与资源，轮询不重查/覆盖', async () => {
  dom.node('sidebar').classList.add('mobile-open');
  const before = calls;
  await dom.node('agent-status-open').onclick();
  expectSelected('agent-status');
  expect(dom.location.hash).toBe('#agent-status');
  expect(dom.node('view-title').textContent).toBe('Agent 状态');
  expect(dom.node('resource-panels').hidden).toBe(true);
  expect(dom.node('detail').hidden).toBe(false);
  expect(dom.node('sidebar').classList.contains('mobile-open')).toBe(false);
  expect(pageText()).toContain('1.0.0'); expect(pageText()).toContain('/opt/pi/cli.js');
  expect(pageText()).toContain('t***@e***.com'); expect(pageText()).toContain('凭证已过期');
  expect(pageText()).toContain('12.25 USD'); expect(pageText()).toContain('无法查询');
  expect(pageText()).toContain('npm:example'); expect(pageText()).toContain('review.ts');
  expect(dom.node('detail').querySelectorAll('details')).toHaveLength(3);
  expect(refresh().getAttribute('data-help')).toContain('不启动 Agent 或模型调用');
  expect(refresh().classList.contains('agent-call')).toBe(false);
  const content = pageText(), pushes = dom.pushed();
  await dom.node('agent-status-open').onclick();
  await dom.intervalFor(1500)(); await dom.intervalFor(3000)();
  expect(calls).toBe(before + 1); expect(pageText()).toBe(content); expect(dom.pushed()).toBe(pushes);
  dom.location.hash = '#tasks'; await dom.fire('hashchange'); expectSelected('tasks');
  dom.location.hash = '#agent-status'; await dom.fire('hashchange'); expectSelected('agent-status');
  expect(calls).toBe(before + 2);
});

test('模型搜索和服务商筛选在本地完成，不调用后台', async () => {
  await openAgentStatus(); const before = calls;
  const search = dom.node('detail').querySelector('input'), provider = dom.node('detail').querySelector('select');
  search.value = 'gpt'; search.oninput();
  expect(dom.node('detail').querySelectorAll('tbody').at(0).children).toHaveLength(1);
  expect(pageText()).toContain('显示 1 / 2');
  provider.value = 'deepseek'; provider.onchange();
  expect(pageText()).toContain('未找到匹配模型');
  search.value = ''; search.oninput();
  expect(dom.node('detail').querySelector('tbody').children).toHaveLength(1);
  expect(calls).toBe(before);
});

test('加载中重复导航/刷新单飞，刷新更新结果和时间', async () => {
  await dom.node('home').onclick();
  const pending = deferred(), before = calls; intercept = () => pending.promise;
  const opening = openAgentStatus();
  expect(refresh().disabled).toBe(true); expect(pageText()).toContain('正在读取 Pi 状态');
  const duplicate = openAgentStatus(), forced = refresh().onclick();
  expect(calls).toBe(before + 1);
  pending.resolve(json(fixture())); await Promise.all([opening, duplicate, forced]); intercept = null;
  statusData = { ...fixture(), checked_at: '2026-10-01T10:00:00Z' };
  await refresh().onclick();
  expect(calls).toBe(before + 2); expect(pageText()).toContain('2026-10-01T10:00:00Z');
  expect(refresh().disabled).toBe(false); statusData = fixture();
});

test('请求失败就地重试；刷新失败保留旧结果但明确标为旧状态', async () => {
  await dom.node('home').onclick();
  intercept = () => Promise.reject(new Error('测试连接失败'));
  await openAgentStatus();
  expect(pageText()).toContain('查询失败：测试连接失败');
  expect(refresh().textContent).toBe('重新查询');
  expect(dom.node('detail').querySelector('.agent-status-feedback').getAttribute('role')).toBe('alert');
  intercept = null; await refresh().onclick(); expect(pageText()).toContain('12.25 USD');
  intercept = () => Promise.reject(new Error('测试刷新失败')); await refresh().onclick();
  expect(pageText()).toContain('并非最新状态'); expect(pageText()).toContain('12.25 USD');
  expect(refresh().disabled).toBe(false); intercept = null;
});

test('离页迟到响应与离页后返回的新查询不会覆盖当前画布', async () => {
  await dom.node('home').onclick();
  const pending = deferred(); intercept = () => pending.promise;
  const first = openAgentStatus();
  await dom.node('settings-open').onclick();
  pending.resolve(json({ ...fixture(), runtime: { version: 'OLD-LATE' } })); await first;
  expectSelected('settings'); expect(pageText()).not.toContain('OLD-LATE');
  const old = deferred(); intercept = () => old.promise;
  const second = openAgentStatus(); await dom.node('home').onclick();
  intercept = null; await openAgentStatus();
  old.resolve(json({ ...fixture(), runtime: { version: 'STALE-RETURN' } })); await second;
  expectSelected('agent-status'); expect(pageText()).not.toContain('STALE-RETURN'); expect(pageText()).toContain('1.0.0');
});

test('local、cli 和 presets 来源分别标注，本地目录不冒充联网验证/插件模型', async () => {
  await dom.node('home').onclick();
  statusData = { ...fixture(), models: { ...fixture().models, source: 'local', warning: '未执行动态插件注册' } };
  await openAgentStatus();
  expect(pageText()).toContain('本地模型目录（未联网验证）');
  expect(pageText()).toContain('不执行密钥命令或刷新登录凭证');
  expect(pageText()).toContain('不加载扩展动态模型');
  expect(pageText()).toContain('未执行动态插件注册');
  expect(pageText()).not.toContain('模型目录来源未知');
  expect(pageText()).not.toContain('可用模型目录');
  const search = dom.node('detail').querySelector('input'); search.value = 'gpt'; search.oninput();
  expect(pageText()).toContain('显示 1 / 2 个本地目录模型');
  const cli = deepText(renderAgentStatus(fixture())); expect(cli).toContain('Pi CLI 模型目录（未联网验证）');
  expect(cli).not.toContain('本地模型目录');
  statusData = fixture();
});

test('空目录、预设、未知/失败余额和真实零分开呈现，额度不当成现金', () => {
  const data = fixture(); data.models = { source: 'presets', warning: 'CLI 不可用', models: [{ id: 'preset-only' }] };
  data.accounts = [
    { provider: 'unknown', balance: { status: 'available', kind: 'balance', items: [{ remaining: null, unit: 'USD' }] } },
    { provider: 'error', balance: { status: 'error', kind: 'balance', items: [{ remaining: 0, unit: 'USD' }], reason: '接口失败' } },
    { provider: 'zero', balance: { status: 'available', kind: 'quota', items: [{ remaining: 0, unit: '请求' }] } },
    { provider: 'missing', balance: { status: 'available', kind: null, items: [] } },
  ];
  const root = renderAgentStatus(data), text = deepText(root);
  expect(text).toContain('内置预设'); expect(text).toContain('不代表当前账号可用');
  expect(text).toContain('剩余 未知 USD'); expect(text).not.toContain('剩余 0 USD');
  expect(text).toContain('查询失败'); expect(text).toContain('接口失败');
  expect(text).toContain('非现金余额'); expect(text).toContain('剩余 0 请求');
  expect(text).toContain('未知不等于零');
  const empty = deepText(renderAgentStatus({ version: 1, agent: 'pi', accounts: [], resources: {}, models: {} }));
  expect(empty).toContain('未发现账号信息'); expect(empty).toContain('未发现扩展 / 插件');
});

test('配置包没有安装路径时不能宣称已安装', () => {
  const data = fixture(); data.resources.packages = [{ source: 'npm:missing', root: null }];
  const text = deepText(renderAgentStatus(data));
  expect(text).toContain('包配置 / 安装目录');
  expect(text).toContain('npm:missing');
  expect(text).toContain('不能确认已安装');
});

test('来自目录/账号/错误的 HTML 只作为文本，不生成元素或内联样式', () => {
  const payload = '<img src=x onerror=alert(1)>', data = fixture();
  data.runtime.command = payload; data.accounts[0].identity = payload;
  data.accounts[0].balance.reason = payload; data.models.models[0].id = payload;
  data.resources.extensions[0].label = payload; data.warnings = [payload];
  const root = renderAgentStatus(data);
  expect(deepText(root)).toContain(payload); expect(root.querySelectorAll('img')).toHaveLength(0);
  expect(root.querySelectorAll('script')).toHaveLength(0);
  const source = fs.readFileSync(new URL('../../src/ui/web/assets/render-agent-status.js', import.meta.url), 'utf8');
  expect(source).not.toContain('innerHTML'); expect(source).not.toContain('.style');
});

test('直接链接启动和重复 boot 复用页面身份，旧 boot 请求不覆盖新环境', async () => {
  dom.location.hash = '#agent-status'; const before = calls;
  await boot(); expectSelected('agent-status'); expect(calls).toBe(before + 1);
  expect(dom.node('detail').dataset.view).toBe('agent-status');
  await boot(); expectSelected('agent-status'); expect(calls).toBe(before + 2);
  const pending = deferred(), started = deferred();
  intercept = () => { started.resolve(); return pending.promise; };
  const oldBoot = boot(); await started.promise;
  intercept = null; await boot();
  pending.resolve(json({ ...fixture(), runtime: { version: 'OLD-BOOT' } })); await oldBoot;
  expectSelected('agent-status'); expect(pageText()).not.toContain('OLD-BOOT'); expect(pageText()).toContain('1.0.0');
});

test('发布 HTML 包含新导航和受控样式资源，不改变主页面 CSP', () => {
  const html = fs.readFileSync(new URL('../../src/ui/web/assets/index.html', import.meta.url), 'utf8');
  expect(html).toContain('id="agent-status-open"'); expect(html).toContain('/styles-agent-status.css');
  expect(html).toContain('只读查询当前项目 Pi');
  const css = fs.readFileSync(new URL('../../src/ui/web/assets/styles-agent-status.css', import.meta.url), 'utf8');
  expect(css).toContain('var(--bg)'); expect(css).toContain('@media(max-width:600px)');
});
