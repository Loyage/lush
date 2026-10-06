import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { answerDialog, deepText, installDom } from '../dom-stub.js';
import { fixture as projectFixture } from '../helpers.js';
import { AgentConnectionsService } from '../../src/core/agent-connections.js';

const at = '2026-10-06T09:00:00.000Z';
const observation = (remaining = 70) => ({ status: 'available', checked_at: at, source: 'usage_api', resources: [
  { id: 'week', kind: 'quota', scope: 'account', label: '周套餐', unit: '%', used_percent: 100 - remaining, remaining,
    total: 100, window_seconds: 604800, reset_at: '2026-10-06T11:00:00.000Z' },
] });
const source = (id, extra = {}) => ({ id, label: `账号 ${id}`, provider: 'openai-codex', endpoint: 'https://chatgpt.com/backend-api/codex',
  auth_type: 'oauth', enabled: true, models: ['gpt-6.1-sol', 'org/model'], default_model: 'gpt-6.1-sol', default_thinking: 'high',
  notify_reset: false, credential: { status: 'configured' }, observation: observation(), last_success: null, consumers: [], ...extra });
const fixture = () => ({ version: 1, sampling: { enabled: false, interval_minutes: 5, retention_days: 90 }, connections: [
  source('a', { consumers: [{ task_id: 42, model: 'openai-codex/gpt-6.1-sol' }] }), source('b'),
  source('c', { provider: 'deepseek', auth_type: 'api_key', endpoint: 'https://api.deepseek.com', models: ['deepseek-chat'], default_model: 'deepseek-chat' }),
  source('d', { provider: 'openai-compatible', auth_type: 'api_key', endpoint: 'https://proxy.example/v1', models: ['vendor/model'], default_model: 'vendor/model', observation: { status: 'unsupported', resources: [] } }),
  source('e', { enabled: false, credential: { status: 'unconfigured' }, observation: { status: 'unconfigured', resources: [] } }),
] });
const json = value => ({ ok: true, json: async () => value });
const failed = () => ({ ok: false, status: 400, json: async () => ({ error: 'RAW-SECRET-ERROR' }) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
let data, intercept, current;
const requests = [], panels = [];
const dom = installDom({ fetch: async (url, options) => {
  url = String(url); const action = url === '/api/action' ? JSON.parse(options.body) : null;
  requests.push({ url, action });
  const result = intercept?.(url, action); if (result) return result;
  if (url === '/api/agent/connections') return json(structuredClone(data));
  if (action?.method === 'agent.connections.save') {
    const index = data.connections.findIndex(row => row.id === action.params.connection.id);
    const saved = source(action.params.connection.id || 'new', action.params.connection);
    if (index >= 0) data.connections[index] = saved; else data.connections.push(saved);
    return json(saved);
  }
  if (action?.method === 'agent.connections.query') return json(structuredClone(data));
  if (action?.method === 'agent.connections.login.start') return json({ id: action.params.id, login_id: 'login-safe', url: 'https://auth.openai.com/oauth/authorize?state=safe',
    redirect_uri: 'http://localhost:1455/auth/callback', expires_at: '2099-01-01T00:00:00Z' });
  if (action?.method === 'agent.connections.login.finish') return json(data.connections.find(row => row.id === action.params.id));
  throw new Error(`unexpected mock request ${url}`);
} });
const { createAgentConnections, renderConnectionResources, relativeTime, resetRemaining } = await import('../../src/ui/web/assets/render-agent-connections.js');
const { setPref } = await import('../../src/ui/web/assets/prefs.js');
const { openModelSources } = await import('../../src/ui/web/assets/render-model-sources.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const field = (root, key) => root.querySelector(`[data-connection-field="${key}"]`);
const row = (root, id) => root.querySelector(`[data-source-id="${id}"]`);
const change = (input, value) => { input.value = value; input.oninput?.(); };
const actions = method => requests.filter(entry => entry.action?.method === `agent.connections.${method}`).map(entry => entry.action);
function clock() {
  let now = Date.parse(at), next = 0; const timers = new Map();
  return { timers, now: () => now, resetSetTimeout: (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, resetClearTimeout: id => timers.delete(id),
    advance: ms => { now += ms; }, tick: async () => { const [id, timer] = timers.entries().next().value; timers.delete(id); now += timer.ms; await timer.fn(); } };
}
async function panel(options = {}) {
  const p = createAgentConnections({ ownsPage: () => current, ...options }); panels.push(p); dom.document.body.append(p.node); await p.load(); return p;
}
const selected = p => { button(p.node, '选择当前筛选结果').onclick(); };
afterAll(() => dom.restore());
afterEach(() => { for (const p of panels.splice(0)) p.dispose(); ui.modelSourcesPage?.connections.dispose(); ui.modelSourcesPage = null; dom.document.hidden = false; });
beforeEach(() => { data = fixture(); current = true; intercept = null; requests.length = 0; ui.view = null; });

test('overview compares all public settings/resources/consumers; search and auth/observation filters stay local', async () => {
  const p = await panel();
  expect(p.node.querySelector('.model-source-detail').hidden).toBe(true);
  expect(p.node.querySelectorAll('.model-source-row')).toHaveLength(5);
  const first = deepText(row(p.node, 'a'));
  for (const text of ['gpt-6.1-sol', 'high', 'org/model', '已配置（不代表已联网验证）', '周套餐', '7 天', '70', 'Worker #42']) expect(first).toContain(text);
  expect(deepText(p.node.querySelector('.model-source-statistics'))).not.toContain('USD');
  expect(p.node.querySelector('.model-source-statistics').textContent).toContain('总数 5 · 启用 4 · 需处理 1 · 使用中 1');
  change(field(p.node, 'source-search'), 'org/model'); expect(p.node.querySelectorAll('.model-source-row')).toHaveLength(3);
  change(field(p.node, 'source-search'), '');
  field(p.node, 'source-state').value = 'attention'; field(p.node, 'source-state').onchange();
  expect(p.node.querySelectorAll('.model-source-row').map(node => node.dataset.sourceId)).toEqual(['e']);
  expect(requests.map(entry => entry.url)).toEqual(['/api/agent/connections']);
});

test('non-modal side editor is focused and Escape returns to trigger; secrets clear while public drafts survive switches', async () => {
  const p = await panel(), trigger = button(p.node, '添加连接'); trigger.focus(); await trigger.onclick();
  const name = field(p.node, 'label'), key = field(p.node, 'api_key'), pane = p.node.querySelector('.model-source-detail');
  expect(dom.document.activeElement).toBe(name); expect(pane.hidden).toBe(false); expect(pane.getAttribute('aria-modal')).toBeNull();
  change(name, '公开草稿'); change(key, 'SECRET-DO-NOT-RETAIN');
  const edit = button(row(p.node, 'b'), '编辑'); edit.focus(); await edit.onclick(); expect(key.value).toBe('');
  change(field(p.node, 'default_model'), 'org/model');
  await trigger.onclick(); expect(field(p.node, 'label').value).toBe('公开草稿'); expect(field(p.node, 'api_key').value).toBe('');
  pane.onkeydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  expect(pane.hidden).toBe(true); expect(dom.document.activeElement).toBe(trigger);
  await edit.onclick(); expect(field(p.node, 'default_model').value).toBe('org/model');
  await button(p.node, '取消编辑').onclick();
  await edit.onclick(); expect(field(p.node, 'default_model').value).toBe('gpt-6.1-sol');
  expect(globalThis.localStorage.getItem('api_key')).toBeNull();
});

test('saving returns focus to the original overview edit entry even after automatic query re-renders rows', async () => {
  const p = await panel(), trigger = button(row(p.node, 'a'), '编辑'); trigger.focus(); await trigger.onclick();
  change(field(p.node, 'default_model'), 'org/model'); await button(p.node, '保存连接').onclick();
  expect(p.node.querySelector('.model-source-detail').hidden).toBe(true);
  expect(dom.document.activeElement).toBe(button(row(p.node, 'a'), '编辑'));
  expect(actions('query').map(action => action.params.id)).toEqual(['a']);
});

test('provider/model preview preserves arbitrary slash IDs and prefix correction is explicit and targeted', async () => {
  const p = await panel(); await button(row(p.node, 'a'), '编辑').onclick();
  change(field(p.node, 'models'), 'org/model, openai-codex/gpt-6.1-sol');
  change(field(p.node, 'default_model'), 'org/model');
  expect(p.node.querySelector('.model-source-call-preview').textContent).toContain('openai-codex/org/model');
  expect(field(p.node, 'models').value).toContain('openai-codex/gpt-6.1-sol');
  await button(p.node, '修正当前服务商前缀').onclick();
  expect(field(p.node, 'models').value).toBe('org/model, gpt-6.1-sol');
  await button(p.node, '保存连接').onclick();
  expect(actions('save')[0].params.connection).toMatchObject({ models: ['org/model', 'gpt-6.1-sol'], default_model: 'org/model' });
});

test('real service defaults projection survives overview editing, automatic query and bulk full-config toggles', async () => {
  const f = projectFixture(); let networkCalls = 0;
  const service = new AgentConnectionsService(f.project, { managerOptions: { fetch: async () => {
    networkCalls++; return Response.json({ balance_infos: [{ currency: 'USD', total_balance: 42 }] });
  } } });
  f.project.agentConnections = service;
  try {
    const saved = await service.save({ label: '真实投影测试', provider: 'deepseek', auth_type: 'api_key', enabled: true,
      models: ['deepseek-chat', 'deepseek-reasoner'], default_model: 'deepseek-chat', default_thinking: 'xhigh' }, { api_key: 'MOCK-PRIVATE-DOM-KEY' });
    intercept = (url, action) => {
      if (url === '/api/agent/connections') return json(service.list());
      if (action?.method === 'agent.connections.save') return service.save(action.params.connection, action.params.credential).then(json);
      if (action?.method === 'agent.connections.query') return service.query(action.params.id).then(json);
    };
    const p = await panel(); expect(networkCalls).toBe(0);
    expect(deepText(row(p.node, saved.id))).toContain('deepseek-chat · 思考：xhigh');
    await button(row(p.node, saved.id), '编辑').onclick();
    expect(field(p.node, 'default_model').value).toBe('deepseek-chat'); expect(field(p.node, 'default_thinking').value).toBe('xhigh');
    change(field(p.node, 'default_model'), 'deepseek-reasoner'); await button(p.node, '保存连接').onclick();
    expect(networkCalls).toBe(1); expect(deepText(row(p.node, saved.id))).toContain('剩余 42 USD');
    selected(p); let work = button(p.node, '批量停用').onclick(); await answerDialog(dom, '确认执行'); await work;
    expect(service.list().connections[0]).toMatchObject({ enabled: false, default_model: 'deepseek-reasoner', default_thinking: 'xhigh' });
    work = button(p.node, '批量启用').onclick(); await answerDialog(dom, '确认执行'); await work;
    expect(service.list().connections[0]).toMatchObject({ enabled: true, default_model: 'deepseek-reasoner', default_thinking: 'xhigh' });
    expect(networkCalls).toBe(2);
    expect(service.getManager().config().connections[0]).toMatchObject({ default_model: 'deepseek-reasoner', default_thinking: 'xhigh' });
    for (const action of actions('save')) expect(action.params).not.toHaveProperty('credential');
    expect(deepText(p.node)).not.toContain('MOCK-PRIVATE-DOM-KEY'); expect(JSON.stringify(service.list())).not.toContain('MOCK-PRIVATE-DOM-KEY');
  } finally { await f.close(); }
});

test('bulk scope confirmation, bounded writes, complete public settings, partial results and local authority re-read', async () => {
  const p = await panel(); selected(p);
  expect(deepText(p.node)).toContain('已选 5 个连接');
  let work = button(p.node, '批量停用').onclick();
  expect(deepText(dom.node('modal'))).toContain('账号 a'); expect(deepText(dom.node('modal'))).toContain('proxy.example');
  await answerDialog(dom, '取消'); await work; expect(actions('save')).toHaveLength(0);
  const pending = [], before = structuredClone(data.connections);
  intercept = (_url, action) => {
    if (action?.method !== 'agent.connections.save') return;
    const wait = deferred(); pending.push({ wait, action }); return wait.promise;
  };
  work = button(p.node, '批量停用').onclick(); await answerDialog(dom, '确认执行');
  expect(pending).toHaveLength(3); // never five simultaneous writes
  for (const entry of pending.splice(0)) {
    const id = entry.action.params.connection.id;
    if (id === 'b') entry.wait.resolve(failed());
    else { data.connections.find(row => row.id === id).enabled = false; entry.wait.resolve(json(source(id, { enabled: false }))); }
  }
  await new Promise(done => setImmediate(done));
  expect(pending).toHaveLength(2);
  for (const entry of pending) { data.connections.find(row => row.id === entry.action.params.connection.id).enabled = false; entry.wait.resolve(json(source(entry.action.params.connection.id, { enabled: false }))); }
  await work;
  expect(actions('save')).toHaveLength(5);
  for (const action of actions('save')) {
    expect(action.params).not.toHaveProperty('credential');
    const old = before.find(row => row.id === action.params.connection.id);
    expect(action.params.connection).toEqual({ id: old.id, label: old.label, provider: old.provider, endpoint: old.endpoint,
      auth_type: old.auth_type, models: old.models, default_model: old.default_model, default_thinking: old.default_thinking, notify_reset: old.notify_reset, enabled: false });
  }
  expect(deepText(row(p.node, 'b'))).toContain('配置保存失败'); expect(deepText(row(p.node, 'a'))).toContain('停用成功');
  expect(requests.at(-1).url).toBe('/api/agent/connections'); expect(data.connections.find(row => row.id === 'b').enabled).toBe(true);
  await button(p.node, '清空选择').onclick(); expect(button(p.node, '批量启用').disabled).toBe(true);
  expect(deepText(p.node)).not.toContain('RAW-SECRET-ERROR');
});

test('bulk selection is frozen to explicit scope; edits started later are never overwritten by completion', async () => {
  const p = await panel(); change(field(p.node, 'source-search'), '账号 a'); selected(p);
  const wait = deferred(); intercept = (_url, action) => action?.method === 'agent.connections.save' ? wait.promise : null;
  const work = button(p.node, '批量停用').onclick(); await answerDialog(dom, '确认执行');
  await button(row(p.node, 'a'), '编辑').onclick(); const model = field(p.node, 'default_model'); change(model, 'org/model');
  await button(p.node, '保存连接').onclick(); expect(actions('save')).toHaveLength(1); expect(deepText(p.node)).toContain('正在批量配置');
  change(field(p.node, 'source-search'), ''); await button(p.node, '选择当前筛选结果').onclick();
  wait.resolve(json(source('a', { enabled: false }))); await work;
  expect(actions('save').map(action => action.params.connection.id)).toEqual(['a']);
  expect(field(p.node, 'default_model')).toBe(model); expect(model.value).toBe('org/model');
});

test('bulk enabling discloses automatic networking and separates successful config from failed query', async () => {
  data.connections[0].enabled = false;
  const p = await panel(); change(field(p.node, 'source-search'), '账号 a'); selected(p);
  intercept = (_url, action) => action?.method === 'agent.connections.query' ? failed() : null;
  const work = button(p.node, '批量启用').onclick();
  expect(deepText(dom.node('modal'))).toContain('会自动联网刷新资源'); await answerDialog(dom, '确认执行'); await work;
  expect(actions('save').map(action => action.params.connection.id)).toEqual(['a']);
  expect(actions('query').map(action => action.params.id)).toEqual(['a']);
  expect(deepText(row(p.node, 'a'))).toContain('启用成功；自动查询失败');
  expect(data.connections[0].enabled).toBe(true);
});

test('failed final local read does not falsely claim authoritative state is refreshed', async () => {
  const p = await panel(); change(field(p.node, 'source-search'), '账号 a'); selected(p);
  intercept = (url, action) => {
    if (action?.method === 'agent.connections.save') { data.connections[0].enabled = false; return json(data.connections[0]); }
    if (url === '/api/agent/connections') return failed();
  };
  const work = button(p.node, '批量停用').onclick(); await answerDialog(dom, '确认执行'); await work;
  expect(deepText(p.node)).toContain('本地重读失败'); expect(deepText(p.node)).not.toContain('本地状态已重新读取');
  expect(deepText(row(p.node, 'a'))).toContain('停用成功');
});

test('concurrent query whole-list snapshots cannot swallow sibling results; final local re-read wins', async () => {
  const p = await panel(), pending = new Map(), old = structuredClone(data);
  intercept = (_url, action) => {
    if (action?.method !== 'agent.connections.query') return;
    const wait = deferred(); pending.set(action.params.id, wait); return wait.promise;
  };
  const work = button(p.node, '刷新全部资源').onclick(); expect([...pending.keys()]).toEqual(['a', 'b', 'c']);
  expect(button(row(p.node, 'a'), '刷新中…').disabled).toBe(true);
  // Server snapshots intentionally contain other accounts' old values.
  data.connections[1].observation = observation(52); const b = structuredClone(old); b.connections[1].observation = observation(52); pending.get('b').resolve(json(b));
  await new Promise(done => setImmediate(done));
  data.connections[0].observation = observation(91); const a = structuredClone(old); a.connections[0].observation = observation(91); pending.get('a').resolve(json(a));
  data.connections[2].observation = observation(33); const c = structuredClone(old); c.connections[2].observation = observation(33); pending.get('c').resolve(json(c));
  await work;
  expect(actions('query')).toHaveLength(3); expect(requests.at(-1).url).toBe('/api/agent/connections');
  expect(deepText(row(p.node, 'a'))).toContain('剩余 91'); expect(deepText(row(p.node, 'b'))).toContain('剩余 52'); expect(deepText(row(p.node, 'c'))).toContain('剩余 33');
  expect(deepText(row(p.node, 'd'))).not.toContain('刷新中');
});

test('save success and auto-query failure are separate; old credential observation is not attached to new account', async () => {
  const p = await panel(); await button(row(p.node, 'c'), '编辑').onclick();
  expect(deepText(p.node)).toContain('会自动联网刷新');
  change(field(p.node, 'api_key'), 'NEW-PRIVATE-KEY');
  const wait = deferred();
  intercept = (_url, action) => {
    if (action?.method === 'agent.connections.save') {
      const saved = source('c', { ...action.params.connection, observation: { status: 'unknown', resources: [] }, last_success: null });
      data.connections[2] = saved; return json(saved);
    }
    if (action?.method === 'agent.connections.query') return wait.promise;
  };
  const saving = button(p.node, '保存连接').onclick(); await new Promise(done => setImmediate(done));
  expect(actions('query')).toHaveLength(1); expect(button(row(p.node, 'c'), '刷新中…').disabled).toBe(true);
  expect(deepText(row(p.node, 'c'))).not.toContain('剩余 70');
  await button(row(p.node, 'b'), '编辑').onclick(); change(field(p.node, 'label'), '更晚的新草稿');
  wait.resolve(failed()); await saving;
  expect(deepText(p.node)).toContain('连接已保存；自动查询失败'); expect(field(p.node, 'label').value).toBe('更晚的新草稿');
  expect(deepText(p.node)).not.toContain('NEW-PRIVATE-KEY'); expect(deepText(p.node)).not.toContain('RAW-SECRET-ERROR');
});

test('unsupported and disabled saves do not query; fallback login success auto-refreshes only its connection', async () => {
  const p = await panel();
  await button(row(p.node, 'd'), '编辑').onclick(); await button(p.node, '保存连接').onclick(); expect(actions('query')).toHaveLength(0);
  await button(row(p.node, 'e'), '编辑').onclick(); await button(p.node, '保存连接').onclick(); expect(actions('query')).toHaveLength(0);
  p.selectConnection('a');
  const card = p.node.querySelector('[data-connection-id="a"]');
  await button(card, '备用：回调 URL 登录').onclick();
  field(p.node, 'redirect_url').value = 'http://localhost:1455/auth/callback?code=private&state=safe';
  await button(p.node, '完成登录').onclick();
  expect(actions('query').map(action => action.params.id)).toEqual(['a']); expect(deepText(p.node)).toContain('本项目登录已保存');
  expect(deepText(p.node)).not.toContain('code=private');
});

test('reset countdown only ticks locally, pauses hidden, expires honestly and clears timers on dispose', async () => {
  const timer = clock(), visibility = new Map();
  dom.document.addEventListener = (name, fn) => visibility.set(name, fn);
  dom.document.removeEventListener = name => visibility.delete(name);
  const p = await panel(timer), reset = row(p.node, 'a').querySelector('.agent-reset-remaining');
  expect(reset.textContent).toBe('约 2 小时后重置'); expect(timer.timers.size).toBe(1);
  await timer.tick(); expect(reset.textContent).toBe('约 1 小时 59 分钟后重置');
  dom.document.hidden = true; visibility.get('visibilitychange')(); expect(timer.timers.size).toBe(0);
  timer.advance(2 * 3600000); dom.document.hidden = false; visibility.get('visibilitychange')();
  expect(reset.textContent).toBe('已到重置时间，待刷新'); expect(timer.timers.size).toBe(0); expect(actions('query')).toHaveLength(0);
  expect(row(p.node, 'a').querySelector('.agent-connection-resource-details').querySelectorAll('p').some(node => node.textContent.includes(new Date('2026-10-06T11:00:00.000Z').toLocaleString()))).toBe(true);
  p.dispose(); expect(visibility.has('visibilitychange')).toBe(false); expect(timer.timers.size).toBe(0);
  expect(resetRemaining('invalid', timer.now())).toBe('重置时间未知'); expect(resetRemaining('2026-10-09T11:00:00Z', Date.parse(at))).toContain('3 天');
  delete dom.document.addEventListener; delete dom.document.removeEventListener;
});

test('上次刷新时间以相对时长呈现，绝对时间与来源收进折叠详情', () => {
  const root = renderConnectionResources({ status: 'available', checked_at: '2026-10-06T08:57:00.000Z', source: 'usage_api', resources: [
    { id: 'week', kind: 'quota', scope: 'account', label: '周套餐', unit: '%', remaining: 70, total: 100, used_percent: 30, window_seconds: 604800, reset_at: '2026-10-06T11:00:00.000Z' },
  ] }, { now: () => Date.parse(at), reminder: true });
  expect(deepText(root)).toContain('上次刷新：3 分钟前');
  const details = root.querySelector('.agent-connection-observation-details');
  expect(deepText(details)).toContain(new Date('2026-10-06T08:57:00.000Z').toLocaleString());
  expect(details.querySelectorAll('p').some(node => node.textContent.includes('专用余额'))).toBe(true);
  expect(root.querySelector('.agent-reset-remaining').dataset.reminder).toBe('1');
  expect(relativeTime('2026-10-05T08:00:00.000Z', Date.parse(at))).toContain('天前');
  expect(relativeTime('invalid', Date.parse(at))).toBe('时间未知');
});

test('勾选额度刷新提醒后，reset_at 到达时提醒一次；reset_at 变化后按新时间重新计时', async () => {
  const timer = clock(), sent = [];
  const saved = { Notification: globalThis.Notification, secure: globalThis.isSecureContext };
  globalThis.Notification = class { static permission = 'granted'; constructor(title, options) { sent.push({ title, options }); this.close = () => {}; } };
  globalThis.isSecureContext = true; setPref('noticeNotifications', true);
  try {
    const quota = reset => ({ status: 'available', checked_at: at, source: 'usage_api', resources: [
      { id: 'week', kind: 'quota', scope: 'account', label: '周套餐', unit: '%', remaining: 70, total: 100, used_percent: 30, window_seconds: 604800, reset_at: reset }] });
    data.connections = [source('r', { notify_reset: true, observation: quota('2026-10-06T11:00:00.000Z') })];
    const p = await panel(timer), reset = row(p.node, 'r').querySelector('.agent-reset-remaining');
    expect(reset.dataset.reminder).toBe('1'); expect(sent).toHaveLength(0); // 首次载入只标记，不补发
    timer.advance(2 * 3600000); await timer.tick();
    expect(sent).toHaveLength(1); expect(sent[0].title).toContain('额度刷新'); expect(sent[0].options.body).toContain('已到重置时间');
    expect(sent[0].options.body).toContain('不代表额度已恢复'); expect(reset.classList.contains('is-due')).toBe(true);
    await p.load(true); expect(sent).toHaveLength(1); // 同一 reset_at 不重复提醒
    data.connections[0].observation = quota('2026-10-06T13:00:00.000Z'); await p.load(true);
    timer.advance(2 * 3600000); await timer.tick(); expect(sent).toHaveLength(2); // 新 reset_at 重新计时
  } finally {
    setPref('noticeNotifications', false);
    if (saved.Notification === undefined) delete globalThis.Notification; else globalThis.Notification = saved.Notification;
    if (saved.secure === undefined) delete globalThis.isSecureContext; else globalThis.isSecureContext = saved.secure;
  }
});

test('未勾选提醒或系统通知关闭时只保留页面内到期标记，不发送系统提醒', async () => {
  const sent = [];
  const saved = { Notification: globalThis.Notification, secure: globalThis.isSecureContext };
  globalThis.Notification = class { static permission = 'granted'; constructor() { sent.push(1); this.close = () => {}; } };
  globalThis.isSecureContext = true; setPref('noticeNotifications', false);
  try {
    const quota = { status: 'available', checked_at: at, source: 'usage_api', resources: [
      { id: 'week', kind: 'quota', scope: 'account', label: '周套餐', unit: '%', remaining: 70, reset_at: '2026-10-06T11:00:00.000Z' }] };
    const timer = clock(); data.connections = [source('n', { notify_reset: true, observation: quota })];
    const p = await panel(timer); timer.advance(2 * 3600000); await timer.tick();
    expect(sent).toHaveLength(0); expect(row(p.node, 'n').querySelector('.agent-reset-remaining').classList.contains('is-due')).toBe(true);
    const timer2 = clock(); data.connections = [source('x', { observation: quota })];
    const q = await panel(timer2); expect(row(q.node, 'x').querySelector('.agent-reset-remaining').dataset.reminder).toBeUndefined();
    timer2.advance(2 * 3600000); await timer2.tick(); expect(sent).toHaveLength(0);
  } finally {
    setPref('noticeNotifications', false);
    if (saved.Notification === undefined) delete globalThis.Notification; else globalThis.Notification = saved.Notification;
    if (saved.secure === undefined) delete globalThis.isSecureContext; else globalThis.isSecureContext = saved.secure;
  }
});

test('late query after returning to the page releases busy controls without applying its old snapshot or losing edits', async () => {
  const p = await panel(), wait = deferred();
  intercept = (_url, action) => action?.method === 'agent.connections.query' ? wait.promise : null;
  const querying = button(row(p.node, 'a'), '刷新').onclick(); expect(actions('query').map(action => action.params.id)).toEqual(['a']);
  current = false; p.dispose(); current = true; p.resume();
  data.connections[0].label = '返回后新状态'; await p.load(true);
  await button(row(p.node, 'a'), '编辑').onclick(); change(field(p.node, 'default_model'), 'org/model');
  const old = fixture(); old.connections[0].label = 'OLD-QUERY-SNAPSHOT'; wait.resolve(json(old)); await querying;
  expect(deepText(p.node)).not.toContain('OLD-QUERY-SNAPSHOT'); expect(deepText(row(p.node, 'a'))).toContain('返回后新状态');
  expect(button(row(p.node, 'a'), '刷新').disabled).toBe(false); expect(field(p.node, 'default_model').value).toBe('org/model');
});

test('page teardown clears password immediately, retains public drafts on return and rejects old page reads', async () => {
  ui.modelSourcesPage = null; await openModelSources(); const p = ui.modelSourcesPage.connections;
  await button(p.node, '添加连接').onclick(); change(field(p.node, 'label'), '离页公开草稿'); const key = field(p.node, 'api_key'); change(key, 'SECRET-LEAVING');
  const wait = deferred(); intercept = url => url === '/api/agent/connections' ? wait.promise : null;
  const reading = p.load(true); activateDetailView({ view: 'settings' }); p.dispose();
  expect(key.value).toBe(''); intercept = null;
  await openModelSources(); expect(ui.modelSourcesPage.connections).toBe(p);
  await button(p.node, '添加连接').onclick(); expect(field(p.node, 'label').value).toBe('离页公开草稿'); expect(field(p.node, 'api_key').value).toBe('');
  const obsolete = fixture(); obsolete.connections[0].label = 'OBSOLETE-PAGE'; wait.resolve(json(obsolete)); await reading;
  expect(deepText(p.node)).not.toContain('OBSOLETE-PAGE');
});
