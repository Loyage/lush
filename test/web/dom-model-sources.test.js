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
const requests = [], json = value => ({ ok: true, json: async () => value?.connections ? { ...value, configuration_scope: { selected: 'device', source: 'device', project_override: false } } : value });
const dom = installDom({ fetch: async (url, options) => {
  requests.push({ url: String(url), options });
  const result = intercept?.(String(url).replace(/\?scope=device$/, ''), options); if (result) return result;
  if (String(url) === '/api/host') return json({ mode: 'bound' });
  if (String(url).split('?')[0] === '/api/agent/connections') return json(structuredClone(data));
  if (String(url).includes('/history?')) return json({ version: 1, series: [], retention_days: 90, from: '2026-01-01', to: '2026-01-02' });
  if (String(url) === '/api/action' && JSON.parse(options.body).method === 'agent.connections.device.cancel') return json({ status: 'cancelled' });
  throw new Error(`unexpected request ${url}`);
} });
const { createAgentConnections } = await import('../../src/ui/web/assets/render-agent-connections.js');
const { openModelSources } = await import('../../src/ui/web/assets/render-model-sources.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { ensureProject } = await import('../../src/ui/web/assets/project-picker.js');
afterAll(() => dom.restore());
beforeEach(async () => { data = initial(); current = true; intercept = null; ui.modelSourcesPage = null; ui.view = null; await ensureProject(); requests.length = 0; });
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const field = (root, key) => root.querySelector(`[data-connection-field="${key}"]`);
const visibleCards = root => root.querySelectorAll('.agent-connection-card').filter(node => !node.hidden);
async function panel(options = {}) { const p = createAgentConnections({ ownsPage: () => current, ...options }); await p.load(); return p; }
const row = (root, id) => root.querySelector(`[data-source-id="${id}"]`);

test('总览默认只含来源摘要；完整详情、表单、历史、采样按需展开', async () => {
  const p = await panel();
  expect(requests.map(entry => entry.url)).toEqual(['/api/agent/connections']);
  expect(p.node.querySelectorAll('.model-source-row')).toHaveLength(2);
  expect(p.node.querySelector('.model-source-list').children[0]).toBe(p.node.querySelector('.model-source-rows'));
  expect(p.node.children[0]).toBe(p.node.querySelector('.model-source-layout'));
  expect(deepText(row(p.node, 'source-a'))).not.toContain('api.deepseek.com');
  expect(deepText(row(p.node, 'source-a'))).toContain('默认模型：未设置');
  expect(deepText(p.node.querySelector('.model-source-intro'))).not.toContain('私有文件');
  expect(deepText(p.node)).not.toContain('详情模式');
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

test('摘要最多两项指标，完整模型、端点、读数和消费者仅在来源详情查看', async () => {
  data.connections[0] = source('source-a', { default_model: 'main-model', default_thinking: 'xhigh',
    models: ['main-model', 'secondary-model'], consumers: [{ task_id: 47, model: 'main-model' }],
    observation: { status: 'partial', source: 'usage_api', checked_at: '2026-10-07T05:00:00Z', resources: [
      { kind: 'balance', label: '余额', remaining: 12.5, unit: 'USD', scope: 'account' },
      { kind: 'quota', label: '短窗口', used_percent: 25, remaining: 75, total: 100, unit: '%', scope: 'account', window_seconds: 18000 },
      { kind: 'quota', label: '第三指标', remaining: 8, unit: 'USD', scope: 'key' },
    ] } });
  const p = await panel({ now: () => Date.parse('2026-10-07T05:30:00Z') });
  const summary = deepText(row(p.node, 'source-a'));
  for (const value of ['main-model', '部分指标可用', '现金', '12.5 USD', '已用 25%', '5h', '重置时间未知', '另 1 项见详情', '30 分钟前']) expect(summary).toContain(value);
  for (const value of ['secondary-model', 'api.deepseek.com', 'xhigh', '第三指标', 'Worker #47', '原始读数', '来源：']) expect(summary).not.toContain(value);
  const sourceRow = row(p.node, 'source-a'), resources = sourceRow.querySelector('.model-source-resource-summary');
  expect(resources.querySelectorAll('p')).toHaveLength(4);
  expect(resources.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
  expect(resources.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('25');
  expect(deepText(resources)).not.toContain('缓存');
  expect(resources.querySelectorAll('strong').map(node => node.textContent)).toContain('剩余 12.5 USD');
  expect(resources.querySelectorAll('strong').map(node => node.textContent)).toContain(' · 剩余 75 %');
  const refreshRow = sourceRow.querySelector('.model-source-refresh-row');
  expect(button(refreshRow, '刷新')).toBeTruthy();
  expect(deepText(refreshRow)).toContain('上次刷新：30 分钟前');
  expect(refreshRow.children[0].classList.contains('model-source-cache-time')).toBe(true);
  expect(refreshRow.children[0].getAttribute('data-help')).toContain('非实时');
  expect(sourceRow.querySelectorAll('button').map(node => node.textContent)).toEqual(['刷新', '详情']);
  await button(row(p.node, 'source-a'), '详情').onclick();
  const detail = deepText(visibleCards(p.node)[0]);
  for (const value of ['secondary-model', 'api.deepseek.com', 'xhigh', '第三指标', 'Worker #47', '原始读数', '来源：', '私有文件']) expect(detail).toContain(value);
  expect(requests).toHaveLength(1);
});

test('订阅窗口简写并显示重置倒计时，编辑只在详情内；窗口时长缺失不按顺序猜测', async () => {
  const now = Date.parse('2026-10-07T05:30:00Z'), resetAt = '2026-10-07T06:00:00Z';
  data.connections[0].observation = { status: 'available', checked_at: '2026-10-07T05:00:00Z', resources: [
    { kind: 'quota', label: '主要套餐窗口', scope: 'account', used_percent: 25, window_seconds: 18000, reset_at: resetAt },
    { kind: 'quota', label: '次要套餐窗口', scope: 'account', used_percent: 50, window_seconds: 604800, reset_at: '2026-10-07T04:00:00Z' },
  ] };
  const p = await panel({ now: () => now });
  const summary = deepText(row(p.node, 'source-a'));
  expect(summary).toContain('5h：'); expect(summary).toContain('7d：');
  expect(summary).not.toContain('主要套餐窗口'); expect(summary).not.toContain('次要套餐窗口');
  const resets = row(p.node, 'source-a').querySelectorAll('.model-source-reset-time');
  expect(resets[0].textContent).toBe('约 30 分钟后重置');
  expect(summary).not.toContain('重置：');
  expect(resets[1].textContent).toContain('待刷新'); expect(resets[1].classList.contains('is-due')).toBe(true);
  expect(button(row(p.node, 'source-a'), '编辑')).toBeUndefined();
  await button(row(p.node, 'source-a'), '详情').onclick();
  const detail = visibleCards(p.node)[0];
  expect(detail.querySelectorAll('h4').map(node => node.textContent)).toEqual(['5h', '7d']);
  expect(deepText(detail.querySelector('.agent-connection-resource-details'))).toContain('主要套餐窗口');
  expect(deepText(detail.querySelector('.agent-connection-resource-details'))).toContain(`重置时间：${new Date(resetAt).toLocaleString()}`);
  await button(detail, '编辑').onclick(); expect(p.node.dataset.sourcePanel).toBe('editor');
  await button(p.node, '取消编辑').onclick();
  data.connections[0].observation.resources[0].window_seconds = null;
  await p.load(true); expect(deepText(row(p.node, 'source-a'))).toContain('窗口未知：');
  p.dispose();
});

test('失败与旧值不冒充当前额度，未知指标不填零；不同资源保持口径', async () => {
  data.connections[0].observation.status = 'error';
  data.connections[0].last_success = { status: 'available', resources: [{ kind: 'balance', remaining: 999, unit: 'USD' }] };
  const p = await panel();
  const summary = deepText(row(p.node, 'source-a'));
  expect(summary).toContain('查询失败（不代表资源耗尽）'); expect(summary).not.toContain('999'); expect(summary).not.toContain('剩余 0');
  await button(row(p.node, 'source-a'), '详情').onclick();
  expect(deepText(visibleCards(p.node)[0])).toContain('999 USD');
  data.connections[0].observation = { status: 'available', resources: [
    { kind: 'quota', label: 'Key 限额', remaining: null, total: null, scope: 'key', unit: 'USD' },
    { kind: 'quota', label: '套餐', used: 0, total: 100, scope: 'account' },
  ] };
  await p.load(true);
  const updated = deepText(row(p.node, 'source-a'));
  expect(updated).toContain('Key 预算'); expect(updated).toContain('剩余 未知 USD'); expect(updated).toContain('已用 0%');
  expect(updated).not.toContain('观测成功');
  const bars = row(p.node, 'source-a').querySelectorAll('[role="progressbar"]');
  expect(bars).toHaveLength(1); expect(bars[0].getAttribute('aria-valuenow')).toBe('0');
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
  const pane = p.node.querySelector('.model-source-detail'), rows = p.node.querySelector('.model-source-rows');
  expect(pane.parentNode).toBe(rows);
  expect([...rows.children].indexOf(pane)).toBe([...rows.children].indexOf(row(p.node, 'source-b')) + 1);
  expect(row(p.node, 'source-b').querySelector('.model-source-details-toggle').getAttribute('aria-expanded')).toBe('true');
  const text = deepText(visibleCards(p.node)[0]);
  expect(text).toContain('连接与模型'); expect(text).toContain('余额与额度'); expect(text).toContain('使用情况');
  expect(text).toContain('model-b'); expect(text).not.toContain('Worker #');
  await button(p.node, '返回来源列表').onclick(); expect(p.node.dataset.sourceView).toBe('list');
  expect(dom.document.activeElement).toBe(field(p.node, 'source-search')); expect(requests).toHaveLength(1);
});

test('来源详情在行下方展开，重复点击收起；刷新和过滤后保持正确挂载', async () => {
  const p = await panel();
  await button(row(p.node, 'source-a'), '详情').onclick();
  const pane = p.node.querySelector('.model-source-detail'), rows = p.node.querySelector('.model-source-rows');
  expect([...rows.children].indexOf(pane)).toBe(1);
  await p.load(true); expect([...rows.children].indexOf(pane)).toBe(1);
  await button(row(p.node, 'source-a'), '详情').onclick(); expect(pane.hidden).toBe(true);
  expect(row(p.node, 'source-a').querySelector('.model-source-details-toggle').getAttribute('aria-expanded')).toBe('false');
  await button(row(p.node, 'source-b'), '详情').onclick();
  const search = field(p.node, 'source-search'); search.value = 'source-a'; search.oninput();
  expect(pane.parentNode).toBe(rows); expect([...rows.children].at(-1)).toBe(pane);
  expect(p.selectedConnection()).toBe('source-b');
  await button(p.node, '返回来源列表').onclick(); expect(pane.hidden).toBe(true);
  expect(requests.map(entry => entry.url)).toEqual(['/api/agent/connections', '/api/agent/connections']);
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

test('模型来源首次与重复打开不读取旧历史/config/status，显式存档按需只读展开', async () => {
  await openModelSources(); await openModelSources();
  expect(requests.map(entry => entry.url)).toEqual(['/api/agent/connections?scope=device']);
  const root = dom.node('detail'), toggle = button(root, '查看旧余额历史存档');
  expect(toggle.classList.contains('agent-call')).toBe(false); expect(toggle.getAttribute('data-help')).toContain('不联网');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  const host = root.querySelector('.legacy-usage-history'); expect(host.hidden).toBe(true);
  await toggle.onclick(); expect(host.hidden).toBe(false); expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(requests.at(-1).url).toBe('/api/agent/usage/history?days=7');
  expect(deepText(host)).toContain('不归到任何正式连接'); expect(host.querySelectorAll('form')).toHaveLength(0);
  await toggle.onclick(); expect(host.hidden).toBe(true);
  expect(requests.map(entry => entry.url)).toEqual(['/api/agent/connections?scope=device', '/api/agent/usage/history?days=7']);
});

test('存档收起、离页与返回作废旧历史响应，不污染正式连接或新存档', async () => {
  await openModelSources();
  let resolve; const pending = new Promise(done => { resolve = done; });
  intercept = url => url.startsWith('/api/agent/usage/history?') ? pending : null;
  const oldToggle = button(dom.node('detail'), '查看旧余额历史存档'), oldHost = dom.node('detail').querySelector('.legacy-usage-history');
  const loading = oldToggle.onclick(); await oldToggle.onclick();
  const oldText = deepText(oldHost);
  resolve(json({ version: 1, series: [], retention_days: 777 })); await loading; expect(deepText(oldHost)).toBe(oldText);
  intercept = null; await oldToggle.onclick(); expect(deepText(oldHost)).toContain('已读取本地缓存');
  const late = new Promise(done => { resolve = done; }); intercept = url => url.startsWith('/api/agent/usage/history?') ? late : null;
  const stale = button(oldHost, '刷新历史缓存').onclick();
  activateDetailView({ view: 'settings' }); intercept = null; await openModelSources();
  const newHost = dom.node('detail').querySelector('.legacy-usage-history'); expect(newHost.hidden).toBe(true);
  expect(requests.filter(entry => entry.url.startsWith('/api/agent/usage/history?'))).toHaveLength(3);
  await button(dom.node('detail'), '查看旧余额历史存档').onclick(); const content = deepText(newHost);
  resolve(json({ version: 1, series: [], retention_days: 888 })); await stale;
  expect(deepText(newHost)).toBe(content); expect(deepText(newHost)).not.toContain('888');
  expect(requests.some(entry => entry.url.includes('/usage/config') || entry.url === '/api/agent/status')).toBe(false);
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
  expect(css).toContain('height:144px'); expect(css).toContain('height:168px'); expect(css).toContain('height:268px');
  expect(css).not.toContain('height:192px'); expect(css).not.toContain('height:320px');
  expect(css).toContain('minmax(0,1.5fr) 104px');
  expect(css).toContain('.model-source-refresh-row{display:flex;flex-direction:column');
  expect(css).toContain('.model-source-row-actions{grid-column:3;grid-row:1/3}');
  expect(css).toContain('.model-source-row-actions{grid-column:2;grid-row:1/4}');
  expect(css).toContain('text-overflow:ellipsis');
  expect(css).toContain('[data-source-panel="detail"] .model-source-detail{position:static');
  expect(css).toContain('.model-source-key-amount{font-weight:700');
});
