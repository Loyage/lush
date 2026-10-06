import { afterAll, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText } from '../dom-stub.js';

const source = (id, extra = {}) => ({ id, label: `来源 ${id}`, provider: 'deepseek', auth_type: 'api_key',
  endpoint: 'https://api.deepseek.com', enabled: true, models: ['deepseek-chat'], credential: { status: 'configured' },
  observation: { status: 'unknown', source: 'none', checked_at: null, resources: [] }, consumers: [], ...extra });
const initial = () => ({ version: 1, sampling: { enabled: false, interval_minutes: 5, retention_days: 90 }, connections: [
  source('source-a'), source('source-b', { label: '工作中转', provider: 'openai-compatible', endpoint: 'https://models.example/v1', enabled: false, models: ['model-b'] }),
] });
let data = initial(), current = true, intercept = null;
const requests = [], json = value => ({ ok: true, json: async () => value });
const dom = installDom({ fetch: async (url, options) => {
  requests.push({ url: String(url), options });
  const result = intercept?.(String(url), options); if (result) return result;
  if (String(url) === '/api/agent/connections') return json(structuredClone(data));
  if (String(url).includes('/history?')) return json({ version: 1, series: [], from: '2026-01-01', to: '2026-01-02' });
  if (String(url) === '/api/action' && JSON.parse(options.body).method === 'agent.connections.device.cancel') return json({ status: 'cancelled' });
  throw new Error(`unexpected request ${url}`);
} });
const { createAgentConnections } = await import('../../src/ui/web/assets/render-agent-connections.js');
const { openModelSources } = await import('../../src/ui/web/assets/render-model-sources.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
afterAll(() => dom.restore());
beforeEach(() => { data = initial(); requests.length = 0; current = true; intercept = null; ui.modelSourcesPage = null; ui.view = null; });
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const field = (root, key) => root.querySelector(`[data-connection-field="${key}"]`);
const visibleCards = root => root.querySelectorAll('.agent-connection-card').filter(node => !node.hidden);
async function panel(options = {}) { const p = createAgentConnections({ ownsPage: () => current, ...options }); await p.load(); return p; }
const row = (root, id) => root.querySelector(`[data-source-id="${id}"]`);

test('全宽总览包含所有来源身份、端点与凭证；详情、表单、历史、采样按需展开', async () => {
  const p = await panel();
  expect(requests.map(entry => entry.url)).toEqual(['/api/agent/connections']);
  expect(p.node.querySelectorAll('.model-source-row')).toHaveLength(2);
  expect(deepText(row(p.node, 'source-a'))).toContain('api.deepseek.com');
  expect(deepText(row(p.node, 'source-a'))).toContain('不代表已联网验证');
  expect(visibleCards(p.node)).toHaveLength(1); expect(p.selectedConnection()).toBe('source-a');
  expect(p.node.dataset.sourceView).toBe('list');
  expect(field(p.node, 'label').parentNode.parentNode.parentNode.parentNode.hidden).toBe(true);
  expect(p.node.querySelector('.agent-connection-history-controls').parentNode.hidden).toBe(true);
  expect(field(p.node, 'sampling-enabled').parentNode.parentNode.parentNode.hidden).toBe(true);
  await button(p.node, '添加连接').onclick(); expect(p.node.dataset.sourceView).toBe('detail');
  expect(field(p.node, 'label').parentNode.parentNode.parentNode.parentNode.hidden).toBe(false);
  await button(p.node, '取消编辑').onclick();
  await button(p.node, '后台采样设置').onclick();
  expect(field(p.node, 'sampling-enabled').parentNode.parentNode.parentNode.hidden).toBe(false);
  expect(requests).toHaveLength(1);
});

test('名称/端点搜索与服务商、启用状态筛选只过滤本地列表，不切默认来源', async () => {
  const p = await panel(), search = field(p.node, 'source-search'), provider = field(p.node, 'source-provider'), enabled = field(p.node, 'source-enabled');
  search.value = 'models.example'; search.oninput(); expect(p.node.querySelectorAll('.model-source-row')).toHaveLength(1);
  expect(p.selectedConnection()).toBe('source-a');
  provider.value = 'deepseek'; provider.onchange(); expect(p.node.querySelectorAll('.model-source-row')).toHaveLength(0);
  search.value = ''; search.oninput(); expect(p.node.querySelectorAll('.model-source-row')).toHaveLength(1);
  provider.value = ''; enabled.value = 'disabled'; enabled.onchange();
  expect(p.node.querySelectorAll('.model-source-row')).toHaveLength(1); expect(deepText(p.node.querySelector('.model-source-rows'))).toContain('工作中转');
  expect(requests).toHaveLength(1);
});

test('选择来源更新独立详情与窄屏前后导航，不产生配置或联网查询', async () => {
  const p = await panel(); await button(row(p.node, 'source-b'), '详情').onclick();
  expect(p.selectedConnection()).toBe('source-b'); expect(p.node.dataset.sourceView).toBe('detail');
  expect(visibleCards(p.node).map(card => card.dataset.connectionId)).toEqual(['source-b']);
  expect(row(p.node, 'source-b').getAttribute('aria-current')).toBe('true');
  const text = deepText(visibleCards(p.node)[0]);
  expect(text).toContain('连接与模型'); expect(text).toContain('余额与额度'); expect(text).toContain('使用情况');
  expect(text).toContain('model-b'); expect(text).not.toContain('Worker #');
  await button(p.node, '返回来源列表').onclick(); expect(p.node.dataset.sourceView).toBe('list');
  expect(dom.document.activeElement).toBe(field(p.node, 'source-search')); expect(requests).toHaveLength(1);
});

test('刷新列表保留筛选和未保存表单，选择其他来源不悄悄丢失编辑', async () => {
  const p = await panel(); await button(p.node, '添加连接').onclick();
  const label = field(p.node, 'label'); label.value = '未保存草稿'; label.oninput();
  const search = field(p.node, 'source-search'); search.value = '中转'; search.oninput();
  await p.load(true); expect(field(p.node, 'label')).toBe(label); expect(label.value).toBe('未保存草稿');
  expect(search.value).toBe('中转'); await button(row(p.node, 'source-b'), '详情').onclick();
  expect(label.value).toBe('未保存草稿'); expect(p.selectedConnection()).toBe('source-b');
});

test('来源详情历史按需读取，离开详情作废迟到结果', async () => {
  const p = await panel();
  await button(visibleCards(p.node)[0], '查看历史').onclick();
  expect(p.node.querySelector('.agent-connection-history-controls').parentNode.hidden).toBe(false);
  expect(requests.at(-1).url).toContain('id=source-a');
  let resolve; const pending = new Promise(done => { resolve = done; }); intercept = url => url.includes('/history?') ? pending : null;
  const reading = p.loadHistory(); p.selectConnection('source-b');
  resolve(json({ version: 1, series: [], truncated: true })); await reading;
  expect(p.node.querySelector('.agent-connection-history-controls').parentNode.hidden).toBe(true);
  expect(deepText(p.node.querySelector('.agent-connection-history-content'))).toBe('');
});

test('独立页面支持给定来源深链接；未知来源不冒充其他来源', async () => {
  await openModelSources({ connectionId: 'source-b' });
  expect(ui.view.id).toBe('model-sources'); expect(dom.location.hash).toBe('#model-source-source-b');
  expect(dom.node('view-title').textContent).toBe('模型来源');
  expect(visibleCards(dom.node('detail')).map(card => card.dataset.connectionId)).toEqual(['source-b']);
  await openModelSources({ connectionId: 'deleted-source' });
  expect(visibleCards(dom.node('detail'))).toHaveLength(0); expect(deepText(dom.node('detail'))).toContain('所选来源不存在或已删除');
  expect(requests).toHaveLength(1);
});

test('来源页面重复打开单飞，离页迟到响应不能覆盖其他画布', async () => {
  let resolve; const pending = new Promise(done => { resolve = done; }); intercept = () => pending;
  const first = openModelSources(), second = openModelSources(); expect(requests).toHaveLength(1);
  activateDetailView({ view: 'settings' }); dom.node('detail').replaceChildren(dom.document.createElement('h1'));
  resolve(json(data)); await Promise.all([first, second]);
  expect(ui.view.id).toBe('settings'); expect(dom.node('detail').querySelector('.model-source-layout')).toBeNull();
});

test('切换来源立即取消设备码登录，清除短码与定时器，不后台继续检查', async () => {
  data.connections[0] = source('source-a', { provider: 'openai-codex', auth_type: 'oauth' });
  const timers = new Map(); let next = 0;
  intercept = (url, options) => url === '/api/action' && JSON.parse(options.body).method === 'agent.connections.device.start'
    ? json({ id: 'source-a', login_id: 'login-test', user_code: 'SAFE-CODE', verification_uri: 'https://auth.openai.com/codex/device',
      interval_seconds: 5, expires_at: new Date(Date.now() + 60000).toISOString() }) : null;
  const p = await panel({ setTimeout: (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, clearTimeout: id => timers.delete(id) });
  await button(visibleCards(p.node)[0], '登录 / 重新登录').onclick();
  const code = field(p.node, 'user_code'); expect(code.value).toBe('SAFE-CODE'); expect(timers.size).toBe(1);
  await button(row(p.node, 'source-b'), '详情').onclick();
  expect(code.value).toBe(''); expect(timers.size).toBe(0);
  const actions = requests.filter(entry => entry.url === '/api/action').map(entry => JSON.parse(entry.options.body));
  expect(actions.map(entry => entry.method)).toEqual(['agent.connections.device.start', 'agent.connections.device.cancel']);
  expect(actions.at(-1).params).toEqual({ id: 'source-a', login_id: 'login-test' });
});

test('取消来源编辑清除password，不保留密钥草稿', async () => {
  const p = await panel(); await button(p.node, '添加连接').onclick();
  const key = field(p.node, 'api_key'); key.value = 'PRIVATE-CANCELLED-KEY';
  await button(p.node, '取消编辑').onclick(); expect(key.value).toBe('');
  expect(field(p.node, 'api_key').value).toBe(''); expect(requests).toHaveLength(1);
});

test('来源 CSS 有全宽总览、侧面板和窄屏卡片、隐藏语义与主题 token', () => {
  const css = fs.readFileSync(new URL('../../src/ui/web/assets/styles-agent-connections.css', import.meta.url), 'utf8');
  expect(css).toContain('.model-source-layout{display:grid;grid-template-columns:minmax(0,1fr)');
  expect(css).toContain('.model-source-detail{position:fixed'); expect(css).toContain('data-source-view="detail"');
  expect(css).toContain('[hidden]{display:none!important}'); expect(css).toContain('var(--bg)'); expect(css).toContain(':focus-visible');
});
