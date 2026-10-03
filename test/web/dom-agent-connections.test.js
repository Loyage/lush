import { afterAll, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { answerDialog, deepText, installDom } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { normalizeAgentProfile } from '../../src/agent/settings.js';

const world = makeWorld(), requests = [], actions = [];
const json = value => ({ ok: true, status: 200, json: async () => value });
const fail = error => ({ ok: false, status: 400, json: async () => ({ error }) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const at = '2026-10-01T09:00:00.000Z';
const resource = (extra = {}) => ({ id: 'cash', kind: 'balance', scope: 'account', label: '账户余额', unit: 'USD', remaining: 12.5,
  total: null, used: null, used_percent: null, reset_at: null, window_seconds: null, models: [], ...extra });
const observation = (extra = {}) => ({ status: 'available', source: 'usage_api', checked_at: at, resources: [resource()], error_code: null, reason: null, ...extra });
const connection = (extra = {}) => ({ id: '11111111-1111-4111-8111-111111111111', label: '个人 DeepSeek', provider: 'deepseek', endpoint: 'https://api.deepseek.com',
  auth_type: 'api_key', enabled: true, models: ['deepseek-chat'], credential: { status: 'configured', identity: null, expires_at: null },
  observation: observation(), last_success: null, consumers: [{ task_id: 47, model: 'deepseek/deepseek-chat' }], ...extra });
const fixture = () => ({ version: 1, checked_at: at, sampling: { enabled: false, interval_minutes: 5, retention_days: 90 }, connections: [connection(),
  connection({ id: '22222222-2222-4222-8222-222222222222', label: '工作 DeepSeek', observation: observation({ status: 'unknown', source: 'none', checked_at: null, resources: [] }), consumers: [] }),
  connection({ id: '33333333-3333-4333-8333-333333333333', label: '个人 Codex', provider: 'openai-codex', auth_type: 'oauth', endpoint: 'https://chatgpt.com/backend-api/codex', models: [],
    observation: observation({ status: 'error', error_code: 'network', resources: [] }), credential: { status: 'expired', identity: 'u***@e***.com', expires_at: at }, consumers: [] })] });
const historyFixture = () => ({ version: 1, from: at, to: '2026-10-02T09:00:00.000Z', retention_days: 90, truncated: false,
  series: [{ id: 'a', provider: 'deepseek', account_key: 'anonymous-account', label: '现金余额', kind: 'balance', unit: 'USD', window_seconds: null, scope: 'account', models: [], source: 'usage_api', sample_count: 1,
    points: [{ at, remaining: 12.5, total: null, used: null, used_percent: null, status: 'available', reset_at: null, error_code: null }] }] });
let data = fixture(), intercept = null, current = true;
const dom = installDom({ fetch: async (url, options) => {
  url = String(url); requests.push({ url, options });
  const custom = intercept?.(url, options); if (custom !== undefined && custom !== null) return custom;
  if (url === '/api/agent/connections') return json(structuredClone(data));
  if (url.startsWith('/api/agent/connections/history?')) return json(historyFixture());
  if (url === '/api/action') {
    const action = JSON.parse(options.body);
    if (action.method.startsWith('agent.connections.')) {
      actions.push(action);
      if (action.method === 'agent.connections.query') return json(structuredClone(data));
      if (action.method === 'agent.connections.save') {
        const value = connection({ ...action.params.connection, id: action.params.connection.id || '44444444-4444-4444-8444-444444444444' });
        const index = data.connections.findIndex(entry => entry.id === value.id);
        if (index >= 0) data.connections[index] = value; else data.connections.push(value);
        return json(value);
      }
      if (action.method === 'agent.connections.remove') { data.connections = data.connections.filter(entry => entry.id !== action.params.id); return json({ removed: action.params.id }); }
      if (action.method === 'agent.connections.sampling') { data.sampling = action.params.sampling; return json(data.sampling); }
      if (action.method === 'agent.connections.login.start') return json({ id: action.params.id, login_id: 'login-1', url: 'https://auth.openai.com/oauth/authorize?state=SAFE',
        redirect_uri: 'http://localhost:1455/auth/callback', expires_at: '2099-10-01T09:00:00.000Z', instructions: 'paste callback' });
      if (action.method === 'agent.connections.login.finish') return json(connection({ id: action.params.id, provider: 'openai-codex', auth_type: 'oauth' }));
    }
  }
  return world.fetchImpl(url, options);
} });
dom.document.createElementNS = (_ns, tag) => dom.document.createElement(tag);
const { createAgentConnections, renderConnectionResources } = await import('../../src/ui/web/assets/render-agent-connections.js');
const { renderAgentSettings } = await import('../../src/ui/web/assets/render-settings.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { openAgentStatus } = await import('../../src/ui/web/assets/render-agent-status.js');
const { boot } = await import('../../src/ui/web/assets/app.js');
await boot();
afterAll(() => dom.restore());
beforeEach(() => { data = fixture(); intercept = null; current = true; requests.length = 0; actions.length = 0; });
const field = (root, key) => root.querySelector(`[data-connection-field="${key}"]`);
const btn = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const card = (panel, id = data.connections[0].id) => panel.node.querySelector(`[data-connection-id="${id}"]`);
const change = (input, value) => { input.value = value; input.oninput?.(); };
async function panel() { const value = createAgentConnections({ ownsPage: () => current }); await value.load(); return value; }

test('连接页进入只读本地列表，多账号不按服务商合并，资源和实际消费者分开显示', async () => {
  const p = await panel();
  expect(requests.map(entry => entry.url)).toEqual(['/api/agent/connections']); expect(actions).toHaveLength(0);
  expect(p.node.querySelectorAll('.agent-connection-card')).toHaveLength(3);
  const first = deepText(card(p)); expect(first).toContain('个人 DeepSeek'); expect(first).toContain('12.5 USD');
  expect(first).toContain('现金余额'); expect(first).toContain('专用余额 / 额度接口'); expect(first).toContain('Worker #47');
  expect(card(p).querySelector('a').href).toBe('#worker-47');
  expect(deepText(p.node)).toContain('不提供静态加密'); expect(deepText(p.node)).toContain('不自动切换模型');
  expect(p.node.querySelectorAll('.agent-call')).toHaveLength(0);
  const refresh = btn(p.node, '刷新全部资源'); expect(refresh.getAttribute('data-help')).toContain('不调用 Agent');
  expect(refresh.parentNode.classList.contains('help-host')).toBe(true);
});

test('添加和更换密钥只写password请求，提交立即清空，不回显秘密或持久化浏览器', async () => {
  const p = await panel(), secret = 'TEST-PRIVATE-API-KEY';
  const key = field(p.node, 'api_key'); expect(key.type).toBe('password'); expect(key.getAttribute('value')).toBeNull();
  change(field(p.node, 'label'), '新账号'); change(key, secret);
  const pending = deferred(); intercept = (url, opts) => url === '/api/action' && JSON.parse(opts.body).method === 'agent.connections.save' ? pending.promise : undefined;
  const saving = btn(p.node, '保存连接').onclick();
  expect(key.value).toBe(''); expect(deepText(p.node)).not.toContain(secret);
  const request = JSON.parse(requests.at(-1).options.body);
  expect(request).toEqual({ method: 'agent.connections.save', params: { connection: { label: '新账号', provider: 'deepseek', auth_type: 'api_key', enabled: true, models: [] }, credential: { api_key: secret } } });
  pending.resolve(fail(`SERVER ECHO ${secret}`)); await saving;
  expect(deepText(p.node)).not.toContain(secret); expect(deepText(p.node)).toContain('保存连接失败'); expect(key.value).toBe('');
  expect(globalThis.localStorage.getItem('api_key')).toBeNull();
  intercept = null; await btn(card(p), '编辑').onclick();
  expect(field(p.node, 'api_key').value).toBe(''); change(field(p.node, 'label'), '改名');
  await btn(p.node, '保存连接').onclick();
  expect(actions.at(-1).params).not.toHaveProperty('credential'); expect(actions.at(-1).params.connection.id).toBe(data.connections[0].id);
});

test('刷新与保存迟到响应保留未保存连接编辑及采样草稿', async () => {
  const p = await panel(); change(field(p.node, 'label'), '正在输入'); change(field(p.node, 'retention_days'), '365');
  const editor = field(p.node, 'label'); await btn(p.node, '重新读取本地连接').onclick();
  expect(field(p.node, 'label')).toBe(editor); expect(editor.value).toBe('正在输入'); expect(field(p.node, 'retention_days').value).toBe('365');
  const pending = deferred(); intercept = (url, opts) => url === '/api/action' && JSON.parse(opts.body).method === 'agent.connections.save' ? pending.promise : undefined;
  const saving = btn(p.node, '保存连接').onclick(); change(editor, '保存中继续编辑');
  pending.resolve(json(connection())); await saving;
  expect(field(p.node, 'label')).toBe(editor); expect(editor.value).toBe('保存中继续编辑'); expect(field(p.node, 'retention_days').value).toBe('365');
});

test('表单校验HTTPS端点、空名称和重复模型，不提交无效配置', async () => {
  const p = await panel(); await btn(p.node, '保存连接').onclick(); expect(actions).toHaveLength(0);
  expect(deepText(p.node)).toContain('请填写连接名称'); change(field(p.node, 'label'), '我的连接');
  change(field(p.node, 'endpoint'), 'https://user:secret@example.com/v1'); await btn(p.node, '保存连接').onclick();
  expect(actions).toHaveLength(0); expect(deepText(p.node)).not.toContain('user:secret');
  change(field(p.node, 'endpoint'), 'http://example.com/v1'); await btn(p.node, '保存连接').onclick(); expect(actions).toHaveLength(0);
  change(field(p.node, 'endpoint'), 'https://example.com/v1?api_key=PRIVATE'); await btn(p.node, '保存连接').onclick(); expect(actions).toHaveLength(0);
  expect(deepText(p.node)).not.toContain('PRIVATE');
  change(field(p.node, 'endpoint'), 'https://example.com/v1'); change(field(p.node, 'models'), 'a, a'); await btn(p.node, '保存连接').onclick();
  expect(actions).toHaveLength(0); expect(deepText(p.node)).toContain('模型 ID 不可重复');
  change(field(p.node, 'models'), 'deepseek-chat, deepseek-reasoner'); await btn(p.node, '保存连接').onclick();
  expect(actions[0].params.connection.models).toEqual(['deepseek-chat', 'deepseek-reasoner']);
});

test('结构化现金、Key预算和套餐窗口不互换；百分比、零和未知如实显示', () => {
  const root = renderConnectionResources(observation({ status: 'partial', resources: [resource({ remaining: 0 }),
    resource({ id: 'key', kind: 'quota', scope: 'key', label: 'Key 预算', remaining: null, total: null, used: 2 }),
    resource({ id: 'week', kind: 'quota', scope: 'model', label: '模型周额度', unit: '%', remaining: 80, used_percent: 20, window_seconds: 604800, reset_at: at, models: ['gpt-test'] })] }));
  const text = deepText(root); expect(text).toContain('部分指标可用'); expect(text).toContain('剩余 0 USD'); expect(text).toContain('剩余 未知 USD');
  expect(text).toContain('API Key 消费额度（非账户余额）'); expect(text).toContain('模型专属'); expect(text).toContain('7 天');
  expect(text).toContain('百分比不是实际 token'); expect(text).toContain('gpt-test');
  const failed = renderConnectionResources(observation({ status: 'error', resources: [resource({ remaining: 999 })] }));
  expect(deepText(failed)).toContain('查询失败（不代表资源耗尽）'); expect(deepText(failed)).not.toContain('999');
});

test('资源查询失败展示旧成功时间，旧值不伪装成最新；响应数据仅文本渲染', async () => {
  data.connections[0] = connection({ label: '<img onerror="evil()">', observation: observation({ status: 'error', error_code: 'rate_limited', resources: [] }),
    last_success: { checked_at: at, observation: observation() } });
  const p = await panel(), root = card(p); expect(root.querySelectorAll('.agent-connection-last-success')).toHaveLength(1);
  expect(deepText(root)).toContain('缓存旧值，不是当前资源状态'); expect(deepText(root)).toContain(at); expect(root.querySelectorAll('img')).toHaveLength(0);
  expect(deepText(root)).toContain('HTTP 429');
  await btn(root, '刷新此连接').onclick(); expect(actions.at(-1)).toEqual({ method: 'agent.connections.query', params: { id: data.connections[0].id } });
});

test('列表和查询单飞，保存后的新列表不能被旧读取结果覆盖；离页响应不更新', async () => {
  const p = createAgentConnections({ ownsPage: () => current }), pending = deferred();
  intercept = url => url === '/api/agent/connections' ? pending.promise : undefined;
  const first = p.load(), second = p.load(); expect(requests).toHaveLength(1);
  intercept = null; data.connections[0].label = '较新列表'; await btn(p.node, '重新读取本地连接').onclick();
  pending.resolve(json(fixture())); await Promise.all([first, second]); expect(deepText(p.node)).toContain('较新列表');
  const delayed = deferred(); intercept = (url, opts) => url === '/api/action' && JSON.parse(opts.body).method === 'agent.connections.query' ? delayed.promise : undefined;
  const a = btn(p.node, '刷新全部资源').onclick(), b = btn(p.node, '刷新全部资源').onclick();
  expect(requests.filter(entry => entry.url === '/api/action')).toHaveLength(1);
  current = false; const before = deepText(p.node); delayed.resolve(json(fixture())); await Promise.all([a, b]); expect(deepText(p.node)).toBe(before);
});

test('删除连接需确认，取消不提交，确认保留历史选项和旧ID查询', async () => {
  const p = await panel(), id = data.connections[0].id;
  let deleting = btn(card(p), '删除连接').onclick(); expect(deepText(dom.node('modal'))).toContain('历史观测保留');
  await answerDialog(dom, '取消'); await deleting; expect(actions).toHaveLength(0);
  deleting = btn(card(p), '删除连接').onclick(); await answerDialog(dom, '删除连接'); await deleting;
  expect(actions[0]).toEqual({ method: 'agent.connections.remove', params: { id } });
  expect(field(p.node, 'history-connection').children.some(entry => entry.value === id && entry.textContent.includes('已删除'))).toBe(true);
  change(field(p.node, 'history-id'), id); await btn(p.node, '读取历史').onclick();
  expect(requests.at(-1).url).toBe(`/api/agent/connections/history?id=${id}&days=7`);
  expect(p.node.querySelectorAll('svg')).toHaveLength(1);
});

test('采样默认关闭；校验间隔并确认保留期清理，显式保存不查上游', async () => {
  const p = await panel(); expect(field(p.node, 'sampling-enabled').checked).toBe(false);
  change(field(p.node, 'interval_minutes'), '0'); await btn(p.node, '保存采样设置').onclick(); expect(actions).toHaveLength(0);
  change(field(p.node, 'interval_minutes'), '10'); change(field(p.node, 'retention_days'), '30');
  field(p.node, 'sampling-enabled').checked = true; field(p.node, 'sampling-enabled').onchange();
  const saving = btn(p.node, '保存采样设置').onclick(); expect(deepText(dom.node('modal'))).toContain('永久清理');
  await answerDialog(dom, '保存并清理'); await saving;
  expect(actions[0]).toEqual({ method: 'agent.connections.sampling', params: { sampling: { enabled: true, interval_minutes: 10, retention_days: 30 } } });
  expect(actions.some(entry => entry.method === 'agent.connections.query')).toBe(false);
  expect(deepText(p.node)).toContain('关闭页面仍运行');
});

test('历史只读缓存，账号/范围切换拒绝迟到结果且各series独立绘图', async () => {
  const p = await panel(), choice = field(p.node, 'history-connection'), pending = deferred();
  choice.value = data.connections[0].id;
  intercept = url => url.includes('/history?') ? pending.promise : undefined;
  const old = choice.onchange(); choice.value = data.connections[1].id; intercept = null; await choice.onchange();
  const newer = deepText(p.node.querySelector('.agent-connection-history-content'));
  pending.resolve(json({ ...historyFixture(), series: [{ ...historyFixture().series[0], label: 'OLD-HISTORY' }] })); await old;
  expect(deepText(p.node.querySelector('.agent-connection-history-content'))).toBe(newer);
  expect(requests.filter(entry => entry.url.includes('/history?'))).toHaveLength(2); expect(actions).toHaveLength(0);
  field(p.node, 'history-days').value = '30'; await field(p.node, 'history-days').onchange();
  expect(requests.at(-1).url).toContain('days=30');
  intercept = url => url.includes('/history?') ? json({ ...historyFixture(), truncated: true, series: [historyFixture().series[0], { ...historyFixture().series[0], id: 'b', label: '旧账号', account_key: 'old', unit: '%' }] }) : undefined;
  await p.loadHistory(); expect(p.node.querySelectorAll('svg')).toHaveLength(2); expect(deepText(p.node)).toContain('历史已截断');
});

test('OAuth采用官方安全链接和手动回调，秘密提交后清空，错误不回显授权码', async () => {
  const p = await panel(), codex = data.connections[2]; await btn(card(p, codex.id), '登录 / 重新登录').onclick();
  const link = p.node.querySelector('.agent-connection-form').querySelector('a');
  expect(link.href).toStartWith('https://auth.openai.com/oauth/authorize'); expect(link.rel).toBe('noopener noreferrer'); expect(link.target).toBe('_blank');
  const callback = field(p.node, 'redirect_url'); expect(callback.type).toBe('password');
  const redirect = 'http://localhost:1455/auth/callback?code=PRIVATE-CODE&state=SAFE'; callback.value = redirect;
  intercept = (url, opts) => url === '/api/action' && JSON.parse(opts.body).method === 'agent.connections.login.finish' ? fail(redirect) : undefined;
  await btn(p.node, '完成登录').onclick(); expect(callback.value).toBe(''); expect(deepText(p.node)).not.toContain('PRIVATE-CODE');
  expect(JSON.parse(requests.at(-1).options.body)).toEqual({ method: 'agent.connections.login.finish', params: { id: codex.id, login_id: 'login-1', redirect_url: redirect } });
  expect(deepText(p.node)).toContain('登录未完成'); expect(p.node.querySelectorAll('.agent-call')).toHaveLength(0);
  callback.value = 'https://evil.invalid/auth/callback?code=STEAL'; await btn(p.node, '完成登录').onclick(); expect(callback.value).toBe(''); expect(deepText(p.node)).not.toContain('STEAL');
});

test('OAuth拒绝非官方链接且迟到登录不能覆盖用户新编辑', async () => {
  const p = await panel(), codex = data.connections[2];
  intercept = (url, opts) => url === '/api/action' && JSON.parse(opts.body).method === 'agent.connections.login.start' ? json({ id: codex.id, login_id: 'bad', url: 'javascript:evil()', redirect_uri: 'http://localhost:1455/auth/callback', expires_at: '2099-10-01T00:00:00Z' }) : undefined;
  await btn(card(p, codex.id), '登录 / 重新登录').onclick(); expect(field(p.node, 'redirect_url')).toBeNull();
  expect(deepText(p.node)).toContain('无法创建安全登录请求');
  const delayed = deferred(); intercept = (url, opts) => url === '/api/action' && JSON.parse(opts.body).method === 'agent.connections.login.start' ? delayed.promise : undefined;
  const login = btn(card(p, codex.id), '登录 / 重新登录').onclick(); change(field(p.node, 'label'), '新的编辑');
  delayed.resolve(json({ id: codex.id, login_id: 'late', url: 'https://auth.openai.com/oauth/authorize?state=x', redirect_uri: 'http://localhost:1455/auth/callback', expires_at: '2099-10-01T00:00:00Z' })); await login;
  expect(field(p.node, 'label').value).toBe('新的编辑'); expect(field(p.node, 'redirect_url')).toBeNull();
});

test('Agent管理接入独立tab，切换保留草稿且只在首次进入读取本地连接', async () => {
  ui.agentStatusPage = null; await openAgentStatus(); requests.length = 0;
  const detail = dom.node('detail'), tab = id => detail.querySelector(`button[data-agent-tab="${id}"]`);
  expect(detail.querySelector('.agent-management-connections').hidden).toBe(true);
  await tab('connections').onclick(); expect(requests.map(entry => entry.url)).toEqual(['/api/agent/connections']);
  expect(tab('connections').getAttribute('aria-selected')).toBe('true'); expect(detail.querySelector('.agent-management-connections').hidden).toBe(false);
  const input = field(detail, 'label'); change(input, '切页未保存'); await tab('status').onclick(); await tab('connections').onclick();
  expect(field(detail, 'label')).toBe(input); expect(input.value).toBe('切页未保存'); expect(requests).toHaveLength(1);
});

test('profile显式选择连接，保留已配置ID；检查固定模型和Pi限制，保存不触发额度查询', async () => {
  let settings = structuredClone(world.state.agentConfig), repaint = () => {};
  settings.default.connection_id = data.connections[0].id;
  const root = renderAgentSettings(settings, repaint, { ownsPage: () => current }), profile = root.querySelector('[data-agent-target="default"]');
  const choice = profile.querySelector('[data-agent-field="connection_id"]'); expect(choice.value).toBe(data.connections[0].id);
  await btn(profile, '读取项目连接').onclick(); expect(choice.value).toBe(data.connections[0].id);
  expect(requests.map(entry => entry.url)).toEqual(['/api/agent/connections']);
  const model = profile.querySelector('[data-agent-field="model"]'); model.value = 'wrong-provider/model';
  const before = world.state.actions.length; await btn(profile, '保存配置').onclick(); expect(world.state.actions).toHaveLength(before);
  model.value = 'deepseek/deepseek-chat'; await btn(profile, '保存配置').onclick();
  expect(world.state.actions.at(-1).params.config.default.connection_id).toBe(data.connections[0].id);
  expect(normalizeAgentProfile(world.state.actions.at(-1).params.config.default).connection_id).toBe(data.connections[0].id);
  const backend = profile.querySelector('[data-agent-field="agent"]'); backend.value = 'codex'; for (const fn of backend.listeners.change) fn();
  expect(choice.disabled).toBe(true);
  await btn(profile, '保存配置').onclick(); expect(world.state.actions.at(-1).params.config.default).not.toHaveProperty('connection_id');
  expect(actions.some(entry => entry.method === 'agent.connections.query')).toBe(false);
});

test('连接profile本地列表的迟到响应不在离页后显示错误或重绘', async () => {
  const settings = structuredClone(world.state.agentConfig), root = renderAgentSettings(settings, () => {}, { ownsPage: () => current });
  const profile = root.querySelector('[data-agent-target="default"]'), pending = deferred(); intercept = url => url === '/api/agent/connections' ? pending.promise : undefined;
  const reading = btn(profile, '读取项目连接').onclick(); current = false;
  const before = deepText(root); pending.resolve(json(data)); await reading; expect(deepText(root)).toBe(before);
});

test('发布入口加载连接样式且无秘密localStorage或HTML插值代码', () => {
  const html = fs.readFileSync(new URL('../../src/ui/web/assets/index.html', import.meta.url), 'utf8'); expect(html).toContain('/styles-agent-connections.css');
  const source = fs.readFileSync(new URL('../../src/ui/web/assets/render-agent-connections.js', import.meta.url), 'utf8');
  expect(source).not.toContain('localStorage'); expect(source).not.toContain('innerHTML'); expect(source).not.toContain('console.');
  const css = fs.readFileSync(new URL('../../src/ui/web/assets/styles-agent-connections.css', import.meta.url), 'utf8'); expect(css).toContain('@media(max-width:640px)');
});
