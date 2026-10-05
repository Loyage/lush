import { afterAll, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { answerDialog, deepText, installDom } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { normalizeAgentProfile } from '../../src/agent/settings.js';
import { normalizeConnection } from '../../src/agent/connections-utils.js';
import { validateRuntimeConnection } from '../../src/agent/connection-runtime.js';

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
      if (action.method === 'agent.connections.device.start') return json({ id: action.params.id, login_id: 'device-1',
        verification_uri: 'https://auth.openai.com/codex/device', user_code: 'ABCD-EFGH', interval_seconds: 5, expires_at: new Date(Date.now() + 10 * 60000).toISOString() });
      if (action.method === 'agent.connections.device.poll') return json({ ...action.params, status: 'pending', interval_seconds: 5, expires_at: new Date(Date.now() + 10 * 60000).toISOString() });
      if (action.method === 'agent.connections.device.cancel') return json({ ...action.params, status: 'cancelled' });
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
async function panel(options = {}) { const value = createAgentConnections({ ownsPage: () => current, ...options }); await value.load(); return value; }
function deviceClock() {
  let now = Date.now(), id = 0; const timers = new Map();
  return { timers, now: () => now,
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: key => timers.delete(key),
    advance: ms => { now += ms; },
    tick: async () => { const [key, timer] = timers.entries().next().value; timers.delete(key); now += timer.ms; await timer.fn(); },
    login: (values = {}) => ({ id: data.connections[2].id, login_id: 'device-1', verification_uri: 'https://auth.openai.com/codex/device',
      user_code: 'ABCD-EFGH', interval_seconds: 5, expires_at: new Date(now + 15 * 60000).toISOString(), ...values }),
  };
}
const actionOf = entry => entry.url === '/api/action' ? JSON.parse(entry.options.body) : null;
const deviceRequests = method => requests.map(actionOf).filter(action => action?.method === `agent.connections.device.${method}`);

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

test('备用OAuth采用官方安全链接和手动回调，秘密提交后清空，错误不回显授权码', async () => {
  const p = await panel(), codex = data.connections[2]; await btn(card(p, codex.id), '备用：回调 URL 登录').onclick();
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
  await btn(card(p, codex.id), '备用：回调 URL 登录').onclick(); expect(field(p.node, 'redirect_url')).toBeNull();
  expect(deepText(p.node)).toContain('无法创建安全登录请求');
  const delayed = deferred(); intercept = (url, opts) => url === '/api/action' && JSON.parse(opts.body).method === 'agent.connections.login.start' ? delayed.promise : undefined;
  const login = btn(card(p, codex.id), '备用：回调 URL 登录').onclick(); change(field(p.node, 'label'), '新的编辑');
  delayed.resolve(json({ id: codex.id, login_id: 'late', url: 'https://auth.openai.com/oauth/authorize?state=x', redirect_uri: 'http://localhost:1455/auth/callback', expires_at: '2099-10-01T00:00:00Z' })); await login;
  expect(field(p.node, 'label').value).toBe('新的编辑'); expect(field(p.node, 'redirect_url')).toBeNull();
});

test('设备码默认入口只展示官方链接与短码，按间隔自动等待、退避和完成', async () => {
  const clock = deviceClock(), p = await panel(clock), codex = data.connections[2], login = clock.login();
  let polls = 0;
  intercept = (url, opts) => {
    if (url !== '/api/action') return;
    const action = JSON.parse(opts.body);
    if (action.method === 'agent.connections.device.start') return json(login);
    if (action.method === 'agent.connections.device.poll') return json(++polls === 1
      ? { id: login.id, login_id: login.login_id, status: 'pending', interval_seconds: 10, expires_at: login.expires_at }
      : { id: login.id, login_id: login.login_id, status: 'complete', connection: codex });
  };
  await btn(card(p, codex.id), '登录 / 重新登录').onclick();
  const code = field(p.node, 'user_code'), link = p.node.querySelector('.agent-connection-form').querySelector('a');
  expect(code.value).toBe('ABCD-EFGH'); expect(code.readOnly).toBe(true); expect(field(p.node, 'redirect_url')).toBeNull();
  expect(link.href).toBe('https://auth.openai.com/codex/device'); expect(link.rel).toBe('noopener noreferrer'); expect(link.target).toBe('_blank');
  expect(deepText(p.node)).toContain('ChatGPT 安全设置'); expect(deepText(p.node)).toContain('不要分享');
  expect(p.node.querySelectorAll('.agent-call')).toHaveLength(0); expect(btn(p.node, '复制设备码').getAttribute('data-help')).toContain('不保存到浏览器');
  expect(deviceRequests('poll')).toHaveLength(0); expect([...clock.timers.values()][0].ms).toBe(5000);
  await clock.tick(); expect(deviceRequests('poll')).toHaveLength(1); expect([...clock.timers.values()][0].ms).toBe(10000);
  expect(deepText(p.node)).toContain('每 10 秒'); await clock.tick();
  expect(code.value).toBe(''); expect(field(p.node, 'user_code')).toBeNull(); expect(clock.timers.size).toBe(0);
  expect(deviceRequests('cancel')).toHaveLength(0); expect(deepText(p.node)).toContain('设备码登录已保存');
  expect(requests.filter(entry => entry.url === '/api/agent/connections')).toHaveLength(2);
});

test('取消设备码清空短码与定时器，备用回调仍需显式选择', async () => {
  const clock = deviceClock(), p = await panel(clock), codex = data.connections[2];
  await btn(card(p, codex.id), '登录 / 重新登录').onclick(); const code = field(p.node, 'user_code');
  await btn(p.node, '取消登录').onclick(); expect(code.value).toBe(''); expect(clock.timers.size).toBe(0);
  expect(deviceRequests('cancel').at(-1).params).toEqual({ id: codex.id, login_id: 'device-1' }); expect(deviceRequests('poll')).toHaveLength(0);
  await btn(card(p, codex.id), '登录 / 重新登录').onclick();
  await btn(card(p, codex.id), '备用：回调 URL 登录').onclick();
  expect(clock.timers.size).toBe(0); expect(field(p.node, 'user_code')).toBeNull(); expect(field(p.node, 'redirect_url')).not.toBeNull();
  expect(deviceRequests('cancel')).toHaveLength(2);
});

test('编辑变更与迟到设备码开始响应取消旧会话，不覆盖草稿', async () => {
  const clock = deviceClock(), p = await panel(clock), codex = data.connections[2], pending = deferred();
  intercept = (url, opts) => url === '/api/action' && JSON.parse(opts.body).method === 'agent.connections.device.start' ? pending.promise : undefined;
  const started = btn(card(p, codex.id), '登录 / 重新登录').onclick(); change(field(p.node, 'label'), '继续编辑');
  pending.resolve(json(clock.login())); await started;
  expect(field(p.node, 'label').value).toBe('继续编辑'); expect(field(p.node, 'user_code')).toBeNull(); expect(clock.timers.size).toBe(0);
  expect(deviceRequests('cancel')).toHaveLength(1);
  intercept = null; await btn(card(p, codex.id), '登录 / 重新登录').onclick();
  await btn(card(p), '编辑').onclick(); expect(clock.timers.size).toBe(0); expect(deviceRequests('cancel')).toHaveLength(2);
});

test('新登录已显示后，旧start迟到仅取消自己的login_id，不清除新设备码', async () => {
  const clock = deviceClock(), p = await panel(clock), codex = data.connections[2], old = deferred(); let starts = 0;
  intercept = (url, opts) => {
    if (url !== '/api/action' || JSON.parse(opts.body).method !== 'agent.connections.device.start') return;
    return ++starts === 1 ? old.promise : json(clock.login({ login_id: 'device-new', user_code: 'NEW-CODE' }));
  };
  const first = btn(card(p, codex.id), '登录 / 重新登录').onclick();
  await btn(card(p, codex.id), '登录 / 重新登录').onclick();
  old.resolve(json(clock.login({ login_id: 'device-old', user_code: 'OLD-CODE' }))); await first;
  expect(field(p.node, 'user_code').value).toBe('NEW-CODE'); expect(clock.timers.size).toBe(1);
  expect(deviceRequests('cancel').map(action => action.params.login_id)).toEqual(['device-old']);
  await btn(p.node, '取消登录').onclick(); expect(clock.timers.size).toBe(0);
  expect(deviceRequests('cancel').map(action => action.params.login_id)).toEqual(['device-old', 'device-new']);
});

test('离页或隐藏连接页签后不再poll，清除码并取消会话', async () => {
  for (const hide of [false, true]) {
    const clock = deviceClock(), p = await panel(clock), codex = data.connections[2]; current = true;
    await btn(card(p, codex.id), '登录 / 重新登录').onclick(); const code = field(p.node, 'user_code');
    if (hide) { const host = dom.document.createElement('div'); host.append(p.node); host.hidden = true; } else current = false;
    const previous = deviceRequests('poll').length; await clock.tick();
    expect(deviceRequests('poll')).toHaveLength(previous); expect(code.value).toBe(''); expect(clock.timers.size).toBe(0);
    current = true;
  }
  expect(deviceRequests('cancel')).toHaveLength(2);
});

test('页面关闭会立即停止计时器并取消设备码登录', async () => {
  const clock = deviceClock(), p = await panel(clock); await btn(card(p, data.connections[2].id), '登录 / 重新登录').onclick();
  await dom.fire('pagehide'); expect(clock.timers.size).toBe(0); expect(field(p.node, 'user_code').value).toBe('');
  expect(deviceRequests('cancel')).toHaveLength(1);
});

test('DOM隐藏观察器立即取消计时器，并在停止后断开监听', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver'), clock = deviceClock();
  let changed, disconnected = false, observed;
  try {
    Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: class {
      constructor(fn) { changed = fn; } observe(target, options) { observed = { target, options }; } disconnect() { disconnected = true; }
    } });
    const p = await panel(clock), host = dom.document.createElement('div'); host.append(p.node);
    await btn(card(p, data.connections[2].id), '登录 / 重新登录').onclick();
    expect(observed.target).toBe(dom.document.body); expect(observed.options.attributeFilter).toEqual(['hidden']);
    host.hidden = true; changed(); expect(clock.timers.size).toBe(0); expect(disconnected).toBe(true);
    expect(deviceRequests('cancel')).toHaveLength(1); expect(btn(p.node, '复制设备码').disabled).toBe(true);
  } finally { if (descriptor) Object.defineProperty(globalThis, 'MutationObserver', descriptor); else delete globalThis.MutationObserver; }
});

test('离页后设备poll迟到成功不读取列表或改变画布', async () => {
  const clock = deviceClock(), p = await panel(clock), codex = data.connections[2], pending = deferred();
  await btn(card(p, codex.id), '登录 / 重新登录').onclick();
  intercept = (url, opts) => url === '/api/action' && JSON.parse(opts.body).method === 'agent.connections.device.poll' ? pending.promise : undefined;
  const polling = clock.tick(); current = false;
  pending.resolve(json({ id: codex.id, login_id: 'device-1', status: 'complete', connection: codex })); await polling;
  expect(field(p.node, 'user_code').value).toBe(''); expect(clock.timers.size).toBe(0);
  expect(requests.filter(entry => entry.url === '/api/agent/connections')).toHaveLength(1);
  expect(deepText(p.node)).not.toContain('设备码登录已保存'); expect(deviceRequests('cancel')).toHaveLength(1);
});

test('新设备码登录不被旧poll迟到成功覆盖，旧完成不取消新会话', async () => {
  const clock = deviceClock(), p = await panel(clock), codex = data.connections[2], old = deferred(); let starts = 0;
  intercept = (url, opts) => {
    if (url !== '/api/action') return;
    const action = JSON.parse(opts.body);
    if (action.method === 'agent.connections.device.start') return json(clock.login({ login_id: `device-${++starts}`, user_code: `CODE-${starts}` }));
    if (action.method === 'agent.connections.device.poll') return old.promise;
  };
  await btn(card(p, codex.id), '登录 / 重新登录').onclick(); const pending = clock.tick();
  await btn(card(p, codex.id), '登录 / 重新登录').onclick();
  old.resolve(json({ id: codex.id, login_id: 'device-1', status: 'complete', connection: codex })); await pending;
  expect(field(p.node, 'user_code').value).toBe('CODE-2'); expect(clock.timers.size).toBe(1);
  expect(deviceRequests('cancel').map(action => action.params.login_id)).toEqual(['device-1']);
  expect(requests.filter(entry => entry.url === '/api/agent/connections')).toHaveLength(1);
  await btn(p.node, '取消登录').onclick();
});

test('设备码到期不再联网；失败不回显上游秘密且不自动回退登录', async () => {
  const clock = deviceClock(), p = await panel(clock), codex = data.connections[2];
  intercept = (url, opts) => url === '/api/action' && JSON.parse(opts.body).method === 'agent.connections.device.start' ? json(clock.login({ expires_at: new Date(clock.now() + 2000).toISOString() })) : undefined;
  await btn(card(p, codex.id), '登录 / 重新登录').onclick(); expect([...clock.timers.values()][0].ms).toBe(2000);
  await clock.tick(); expect(deviceRequests('poll')).toHaveLength(0); expect(deepText(p.node)).toContain('设备码已过期'); expect(clock.timers.size).toBe(0);
  intercept = null; await btn(card(p, codex.id), '登录 / 重新登录').onclick();
  intercept = (url, opts) => url === '/api/action' && JSON.parse(opts.body).method === 'agent.connections.device.poll' ? fail('RAW-PRIVATE-DEVICE-TOKEN') : undefined;
  await clock.tick(); expect(field(p.node, 'user_code').value).toBe(''); expect(clock.timers.size).toBe(0);
  expect(deepText(p.node)).toContain('登录检查未完成'); expect(deepText(p.node)).not.toContain('RAW-PRIVATE-DEVICE-TOKEN');
  expect(requests.map(actionOf).some(action => action?.method === 'agent.connections.login.start')).toBe(false);
});

test('浏览器检查最多持续15分钟，不因远端时钟偏差无限续期', async () => {
  const clock = deviceClock(), p = await panel(clock), codex = data.connections[2];
  intercept = (url, opts) => url === '/api/action' && JSON.parse(opts.body).method === 'agent.connections.device.start'
    ? json(clock.login({ expires_at: '2099-10-01T09:00:00.000Z' })) : undefined;
  await btn(card(p, codex.id), '登录 / 重新登录').onclick(); clock.advance(15 * 60000); await clock.tick();
  expect(deviceRequests('poll')).toHaveLength(0); expect(clock.timers.size).toBe(0); expect(deepText(p.node)).toContain('设备码已过期');
});

test('设备码开始拒绝非官方链接、过期或无效间隔并安全取消', async () => {
  const clock = deviceClock(), p = await panel(clock), codex = data.connections[2];
  for (const values of [{ verification_uri: 'https://evil.invalid/device' }, { verification_uri: 'javascript:evil()' }, { interval_seconds: 0 },
    { interval_seconds: Infinity }, { user_code: '<img>' }, { expires_at: new Date(clock.now() - 1).toISOString() }]) {
    intercept = (url, opts) => url === '/api/action' && JSON.parse(opts.body).method === 'agent.connections.device.start' ? json(clock.login(values)) : undefined;
    await btn(card(p, codex.id), '登录 / 重新登录').onclick();
    expect(field(p.node, 'user_code')).toBeNull(); expect(clock.timers.size).toBe(0); expect(deepText(p.node)).toContain('无法获取设备码');
  }
  expect(deviceRequests('cancel')).toHaveLength(6); expect(p.node.querySelectorAll('img')).toHaveLength(0);
});

test('设备码失败展示固定分类和恢复建议，不透传错误或秘密', async () => {
  const clock = deviceClock(), p = await panel(clock), codex = data.connections[2];
  for (const [message, expected] of [
    ['Codex device login failed (timeout)', '超过 8 秒'],
    ['Codex device login failed (network)', '后台机器的网络或代理'],
    ['Codex device login failed (unsupported)', '未开放设备码接口'],
    ['Codex device login failed (unauthorized)', 'OpenAI 拒绝'],
    ['Codex device login failed (invalid_response)', '响应格式'],
    ['Codex device login failed (unknown)', '私有文件权限'],
    ['unknown method: agent.connections.device.start', '分别重启两者'],
    ['method not allowed from Web UI', '分别重启两者'],
    ['Failed to fetch', '浏览器无法连接'],
    ['RAW-PRIVATE-DEVICE-TOKEN', '未取得可识别'],
    ['Codex device login failed (timeout) RAW-PRIVATE-DEVICE-TOKEN', '未取得可识别'],
  ]) {
    intercept = (url, opts) => url === '/api/action' && JSON.parse(opts.body).method === 'agent.connections.device.start' ? fail(message) : undefined;
    await btn(card(p, codex.id), '登录 / 重新登录').onclick();
    expect(deepText(p.node)).toContain(expected); expect(deepText(p.node)).not.toContain('RAW-PRIVATE-DEVICE-TOKEN');
    expect(field(p.node, 'user_code')).toBeNull(); expect(clock.timers.size).toBe(0);
  }
  intercept = (url, opts) => url === '/api/action' && JSON.parse(opts.body).method === 'agent.connections.device.start'
    ? json(clock.login({ expires_at: new Date(clock.now() - 1).toISOString() })) : undefined;
  await btn(card(p, codex.id), '登录 / 重新登录').onclick(); expect(deepText(p.node)).toContain('系统时间');
});

test('设备码poll拒绝会话错配或过小间隔，不展示原始错误', async () => {
  const clock = deviceClock(), p = await panel(clock), codex = data.connections[2];
  for (const values of [{ login_id: 'wrong' }, { interval_seconds: 0 }]) {
    intercept = null; await btn(card(p, codex.id), '登录 / 重新登录').onclick();
    intercept = (url, opts) => url === '/api/action' && JSON.parse(opts.body).method === 'agent.connections.device.poll'
      ? json({ id: codex.id, login_id: 'device-1', status: 'pending', interval_seconds: 5, expires_at: new Date(clock.now() + 1000).toISOString(), ...values }) : undefined;
    await clock.tick(); expect(clock.timers.size).toBe(0); expect(field(p.node, 'user_code').value).toBe('');
  }
});

test('设备码可复制，剪贴板失败提供手动选码，不浏览器持久化', async () => {
  const clock = deviceClock(), p = await panel(clock), descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); let copied;
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => { copied = value; } } } });
    await btn(card(p, data.connections[2].id), '登录 / 重新登录').onclick();
    await btn(p.node, '复制设备码').onclick(); expect(copied).toBe('ABCD-EFGH'); expect(deepText(p.node)).toContain('设备码已复制');
    globalThis.navigator.clipboard.writeText = async () => { throw new Error('PRIVATE-CLIPBOARD'); };
    await btn(p.node, '复制设备码').onclick(); expect(deepText(p.node)).toContain('请手动选中'); expect(dom.document.activeElement).toBe(field(p.node, 'user_code'));
    expect(deepText(p.node)).not.toContain('PRIVATE-CLIPBOARD'); expect(globalThis.localStorage.getItem('user_code')).toBeNull();
    await btn(p.node, '取消登录').onclick();
  } finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator; }
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

test('自定义兼容API必须显式填写端点和模型，密钥只写且余额未知不冒充零', async () => {
  const p = await panel();
  const provider = field(p.node, 'provider'); provider.value = 'openai-compatible'; provider.onchange();
  expect(field(p.node, 'endpoint').required).toBe(true); expect(field(p.node, 'models').required).toBe(true);
  expect(deepText(p.node)).toContain('仅支持 OpenAI Chat Completions');
  change(field(p.node, 'label'), '兼容服务');
  await btn(p.node, '保存连接').onclick(); expect(actions).toHaveLength(0);
  expect(deepText(p.node)).toContain('必须填写 HTTPS 模型端点');
  change(field(p.node, 'endpoint'), 'https://models.example/v1');
  await btn(p.node, '保存连接').onclick(); expect(actions).toHaveLength(0);
  expect(deepText(p.node)).toContain('至少一个物理模型 ID');
  change(field(p.node, 'models'), 'my-model, vendor/second-model'); change(field(p.node, 'api_key'), 'PRIVATE-COMPATIBLE-KEY');
  await btn(p.node, '保存连接').onclick();
  expect(actions[0]).toEqual({ method: 'agent.connections.save', params: { connection: {
    label: '兼容服务', provider: 'openai-compatible', endpoint: 'https://models.example/v1', models: ['my-model', 'vendor/second-model'],
    auth_type: 'api_key', enabled: true,
  }, credential: { api_key: 'PRIVATE-COMPATIBLE-KEY' } } });
  expect(deepText(p.node)).not.toContain('PRIVATE-COMPATIBLE-KEY');
  const saved = data.connections.at(-1), actual = normalizeConnection(actions[0].params.connection, saved.id);
  expect(actual).toMatchObject({ provider: 'openai-compatible', endpoint: 'https://models.example/v1', models: ['my-model', 'vendor/second-model'], auth_type: 'api_key' });
  expect(() => validateRuntimeConnection({ agent: 'pi', connection_id: actual.id, model: 'openai-compatible/vendor/second-model' },
    { connection: actual, credential: { type: 'api_key', key: 'MOCK-KEY' } })).not.toThrow();
  expect(deepText(card(p, saved.id))).toContain('余额查询尚不支持，不代表余额为零');
  expect(deepText(card(p, saved.id))).toContain('本地运行预算，不是已验证的上游限额或价格');
});

test('默认和角色profile只呈现连接匹配模型，切换不覆盖草稿并保存完整物理名', async () => {
  const custom = connection({ id: '44444444-4444-4444-8444-444444444444', label: '兼容服务', provider: 'openai-compatible',
    endpoint: 'https://models.example/v1', models: ['vendor/my-model'], consumers: [] });
  data.connections.push(custom);
  const settings = structuredClone(world.state.agentConfig); settings.default.agent = 'pi'; settings.roles.agent = { ...settings.default };
  const root = renderAgentSettings(settings, () => {}, { ownsPage: () => current });
  for (const target of ['default', 'agent']) {
    const profile = root.querySelector(`[data-agent-target="${target}"]`);
    const choice = profile.querySelector('[data-agent-field="connection_id"]'), model = profile.querySelector('[data-agent-field="model"]');
    model.value = 'unsaved/model'; await btn(profile, '读取项目连接').onclick(); expect(model.value).toBe('unsaved/model');
    choice.value = custom.id; choice.onchange(); expect(model.value).toBe('unsaved/model');
    const picker = profile.querySelector('[data-connection-model="choice"]');
    expect(picker.children.map(node => node.value)).toEqual(['', 'openai-compatible/vendor/my-model']);
    expect(profile.querySelectorAll('.model-preset')).toHaveLength(0);
    picker.value = 'openai-compatible/vendor/my-model'; picker.onchange(); await btn(profile, '保存配置').onclick();
    const saved = world.state.actions.at(-1).params.config;
    expect(target === 'default' ? saved.default : saved.roles.agent).toMatchObject({ connection_id: custom.id, model: 'openai-compatible/vendor/my-model' });
    choice.value = ''; choice.onchange(); expect(model.value).toBe('openai-compatible/vendor/my-model');
    await btn(profile, '保存配置').onclick();
    const unbound = world.state.actions.at(-1).params.config;
    expect(target === 'default' ? unbound.default : unbound.roles.agent).not.toHaveProperty('connection_id');
  }
  expect(requests.some(row => row.url.startsWith('/api/agent/models'))).toBe(false);
  expect(actions.some(row => row.method === 'agent.connections.query')).toBe(false);
});

test('连接读取单飞且在读取期间保留最新连接选择和模型草稿，停用连接无法保存', async () => {
  const settings = structuredClone(world.state.agentConfig); settings.default.agent = 'pi';
  const root = renderAgentSettings(settings, () => {}, { ownsPage: () => current });
  const profile = root.querySelector('[data-agent-target="default"]'), pending = deferred();
  const choice = profile.querySelector('[data-agent-field="connection_id"]'), model = profile.querySelector('[data-agent-field="model"]');
  intercept = url => url === '/api/agent/connections' ? pending.promise : undefined;
  const a = btn(profile, '读取项目连接').onclick(), b = btn(profile, '读取项目连接').onclick();
  expect(requests).toHaveLength(1);
  choice.value = data.connections[1].id; model.value = 'draft/value';
  data.connections[1].enabled = false;
  pending.resolve(json(data)); await Promise.all([a, b]);
  expect(choice.value).toBe(data.connections[1].id); expect(model.value).toBe('draft/value');
  model.value = 'deepseek/deepseek-chat'; const before = world.state.actions.length;
  await btn(profile, '保存配置').onclick(); expect(world.state.actions).toHaveLength(before);
});

test('发布入口加载连接样式且无秘密localStorage或HTML插值代码', () => {
  const html = fs.readFileSync(new URL('../../src/ui/web/assets/index.html', import.meta.url), 'utf8'); expect(html).toContain('/styles-agent-connections.css');
  const source = fs.readFileSync(new URL('../../src/ui/web/assets/render-agent-connections.js', import.meta.url), 'utf8');
  expect(source).not.toContain('localStorage'); expect(source).not.toContain('innerHTML'); expect(source).not.toContain('console.');
  const css = fs.readFileSync(new URL('../../src/ui/web/assets/styles-agent-connections.css', import.meta.url), 'utf8'); expect(css).toContain('@media(max-width:640px)');
});
