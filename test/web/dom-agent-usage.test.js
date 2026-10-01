import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld(), requests = [];
let interceptor = null, current = true;
const json = value => ({ ok: true, status: 200, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const dom = installDom({ fetch(url, options) { requests.push({ url: String(url), options }); return interceptor?.(String(url), options) ?? world.fetchImpl(url, options); } });
// SVG tests use the same minimal elements; the production browser provides real SVG namespaces.
dom.document.createElementNS = (_ns, tag) => dom.document.createElement(tag);
const { createAgentUsage, renderUsageSeries } = await import('../../src/ui/web/assets/render-agent-usage.js');
const { defaultUsageConfig, usageConfigForm } = await import('../../src/ui/web/assets/agent-usage-form.js');
afterAll(() => dom.restore());
const field = (root, key) => root.querySelector(`[data-field="${key}"]`);
const btn = (root, name) => root.querySelectorAll('button').find(button => button.textContent === name);
const change = (input, value) => { input.value = value; input.oninput?.(); };
const point = (at, remaining, extra = {}) => ({ at: `2026-10-01T${at}:00.000Z`, remaining, total: 100, used: remaining === null ? null : 100 - remaining, status: 'available', reset_at: null, error_code: null, ...extra });
const history = () => ({ version: 1, from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z', retention_days: 90, truncated: false,
  series: [{ id: 'codex:account-a:week', provider: 'openai-codex', account_key: 'account-a', kind: 'quota', label: '周额度', unit: '%', window_seconds: 604800,
    sample_count: 4, points: [point('09:00', 80), point('09:05', 60), point('09:10', null, { status: 'error', error_code: 'network' }), point('09:15', 0)] },
  { id: 'deepseek:account-b:balance', provider: 'deepseek', account_key: 'account-b', kind: 'balance', label: '现金余额', unit: 'USD', window_seconds: null,
    sample_count: 2, points: [point('09:00', 12), point('09:05', 10)] }] });
async function panel(config = defaultUsageConfig(), data = history()) {
  interceptor = null; current = true; requests.length = 0;
  world.state.agentUsageHistory = data; world.state.actions = [];
  const panel = createAgentUsage({ ownsPage: () => current });
  await panel.update({ usage_config: config, accounts: [{ provider: 'openai-codex' }, { provider: 'deepseek' }] });
  return panel;
}

test('用量配置表单可见，默认按需、空选择仅当前服务商，并明确安全及清理边界', async () => {
  const p = await panel(); const text = deepText(p.node);
  expect(field(p.node, 'enabled').checked).toBe(false);
  expect(field(p.node, 'interval_minutes').value).toBe(5);
  expect(field(p.node, 'retention_days').value).toBe(90);
  expect(field(p.node, 'providers').value).toBe('');
  expect(text).toContain('留空仅当前 Agent 服务商'); expect(text).toContain('关闭页面仍会查询');
  expect(text).toContain('永久删除旧历史'); expect(text).toContain('不会调用 Agent 或模型');
  expect(requests.map(request => request.url)).toEqual(['/api/agent/usage/history?days=7']);
  expect(p.node.querySelectorAll('.agent-call')).toHaveLength(0);
  const refresh = btn(p.node, '刷新历史缓存'); expect(refresh.getAttribute('data-help')).toContain('不访问服务商');
  expect(refresh.parentNode.classList.contains('help-host')).toBe(true);
});

test('真实表单构建 HTTP POST 与字段映射，保存完整配置但不调用服务商', async () => {
  const p = await panel();
  field(p.node, 'enabled').checked = true; field(p.node, 'enabled').onchange();
  change(field(p.node, 'interval_minutes'), '10'); change(field(p.node, 'retention_days'), '30');
  change(field(p.node, 'providers'), 'my-provider, openai-codex');
  await btn(p.node, '添加自定义查询').onclick();
  const source = p.node.querySelector('.agent-usage-source');
  for (const [key, value] of Object.entries({ provider: 'my-provider', label: '自定义订阅', url: 'https://example.com/usage', method: 'POST', kind: 'quota', body: '{"account":"${ACCOUNT_ID}"}' })) change(field(source, key), value);
  await btn(source, '添加请求头').onclick();
  change(field(source, 'header-name'), 'Authorization'); change(field(source, 'header-value'), 'Bearer ${MY_API_KEY}');
  const metric = source.querySelector('.agent-usage-metric');
  for (const [key, value] of Object.entries({ id: 'week', label: '周剩余额度', unit: '%', remaining: 'quota.remaining', total: 'quota.limit', used: 'quota.used', reset_at: 'quota.reset_at', window_seconds: '604800' })) change(field(metric, key), value);
  await btn(p.node, '保存查询设置').onclick();
  expect(world.state.actions).toHaveLength(1);
  const { method, params } = world.state.actions[0]; expect(method).toBe('agent.usage.configure');
  expect(params.config).toEqual({ version: 1, enabled: true, interval_minutes: 10, retention_days: 30, providers: ['my-provider', 'openai-codex'], custom: [{
    provider: 'my-provider', label: '自定义订阅', url: 'https://example.com/usage', method: 'POST', kind: 'quota', body: '{"account":"${ACCOUNT_ID}"}', headers: { Authorization: 'Bearer ${MY_API_KEY}' },
    items: [{ id: 'week', label: '周剩余额度', unit: '%', remaining: 'quota.remaining', total: 'quota.limit', used: 'quota.used', reset_at: 'quota.reset_at', window_seconds: 604800 }],
  }] });
  expect(deepText(p.node)).toContain('查询设置已保存'); expect(deepText(p.node)).toContain('关闭页面仍运行');
  expect(requests.every(request => request.url.startsWith('/api/'))).toBe(true);
  expect(requests.some(request => request.url === '/api/agent/status')).toBe(false);
});

test('表单校验无效地址、GET 请求体、缺少指标及重复项；控件支持移除', async () => {
  const source = { provider: 'custom', label: 'Custom', url: 'https://example.com/usage', method: 'GET', headers: {}, body: null, kind: 'balance',
    items: [{ id: 'cash', label: '余额', unit: 'USD', remaining: 'data.remaining', total: null, used: null, reset_at: null, window_seconds: null }] };
  const form = usageConfigForm({ ...defaultUsageConfig(), custom: [source] }, [], { changed() {}, save() {} });
  expect(form.read().custom[0]).toEqual(source);
  change(field(form.node, 'url'), 'http://example.com/usage'); expect(() => form.read()).toThrow('HTTPS');
  change(field(form.node, 'url'), 'https://user:secret@example.com/usage'); expect(() => form.read()).toThrow('HTTPS');
  change(field(form.node, 'url'), source.url); change(field(form.node, 'body'), '{}'); expect(() => form.read()).toThrow('GET');
  change(field(form.node, 'body'), ''); change(field(form.node, 'remaining'), ''); expect(() => form.read()).toThrow('数值字段');
  change(field(form.node, 'remaining'), 'data.remaining'); change(field(form.node, 'interval_minutes'), '0'); expect(() => form.read()).toThrow('采样间隔');
  change(field(form.node, 'interval_minutes'), '5'); change(field(form.node, 'retention_days'), '3.5'); expect(() => form.read()).toThrow('保留期限');
  change(field(form.node, 'retention_days'), '90');
  await btn(form.node, '添加请求头').onclick(); change(field(form.node, 'header-name'), 'Authorization');
  await btn(form.node, '添加请求头').onclick(); change(form.node.querySelectorAll('[data-field="header-name"]')[1], 'authorization');
  expect(() => form.read()).toThrow('请求头名称不能重复');
  await btn(form.node, '移除请求头').onclick(); expect(form.read().custom[0].headers).toEqual({ authorization: '' });
  await btn(form.node, '移除指标').onclick(); expect(() => form.read()).toThrow('至少需要一个指标');
  await btn(form.node, '移除此查询').onclick(); expect(form.read().custom).toEqual([]);
});

test('历史按账号和指标分开绘图，切换范围只读缓存、不触发状态查询', async () => {
  const p = await panel();
  expect(p.node.querySelectorAll('svg')).toHaveLength(1);
  expect(p.node.querySelector('svg').getAttribute('aria-label')).toContain('单位 %');
  const metric = p.node.querySelector('.agent-usage-metric-filter');
  metric.value = 'deepseek:account-b:balance'; metric.onchange();
  expect(p.node.querySelector('svg').getAttribute('aria-label')).toContain('单位 USD');
  expect(p.node.querySelector('.agent-usage-history-content').querySelectorAll('svg')).toHaveLength(1);
  const account = p.node.querySelector('.agent-usage-account-filter'); account.value = 'openai-codex\naccount-a'; await account.onchange();
  expect(metric.children).toHaveLength(1); expect(metric.value).toBe('codex:account-a:week');
  const range = p.node.querySelector('.agent-usage-days');
  expect(range.children.map(option => option.value)).toEqual(['1', '7', '30', '90']);
  range.value = '30'; await range.onchange();
  expect(requests.map(request => request.url)).toEqual(['/api/agent/usage/history?days=7', '/api/agent/usage/history?days=7&provider=openai-codex&account_key=account-a', '/api/agent/usage/history?days=30&provider=openai-codex&account_key=account-a']);
});

test('剩余量零、未知及错误分开，失败断线且最后成功值带旧时间', () => {
  const data = history(), series = data.series[0];
  const root = renderUsageSeries(series, data);
  expect(root.querySelectorAll('.agent-usage-dot')).toHaveLength(3);
  expect(root.querySelectorAll('.agent-usage-connection')).toHaveLength(1);
  expect(deepText(root)).toContain('未知不等于零'); expect(deepText(root)).toContain('网络查询失败');
  expect(root.querySelectorAll('td').some(td => td.textContent === '0')).toBe(true);
  const failed = renderUsageSeries({ ...series, points: [...series.points, point('09:20', 999, { status: 'error', error_code: 'expired' })] }, data);
  expect(deepText(failed)).toContain('最后成功剩余量 0 %'); expect(deepText(failed)).toContain('并非最新状态');
  expect(deepText(failed)).toContain('09:15:00.000Z'); expect(deepText(failed)).not.toContain('999');
});

test('重置/补充与后台停机间隔断开，截断历史只画观测点', () => {
  const data = history(), series = { ...data.series[0], points: [point('09:00', 70), point('09:05', 60), point('09:10', 95), point('10:00', 90)] };
  const root = renderUsageSeries(series, data, { enabled: true, interval_minutes: 5 });
  expect(root.querySelectorAll('.agent-usage-connection')).toHaveLength(1);
  expect(root.querySelectorAll('.agent-usage-reset')).toHaveLength(1); expect(deepText(root)).toContain('重置 / 补充');
  const truncated = renderUsageSeries(series, { ...data, truncated: true });
  expect(truncated.querySelectorAll('.agent-usage-connection')).toHaveLength(0); expect(deepText(truncated)).toContain('不跨缺失记录连线');
  const reset = renderUsageSeries({ ...series, points: [point('09:00', 70, { reset_at: '2026-10-01T10:00:00Z' }), point('09:05', 60, { reset_at: '2026-10-01T11:00:00Z' })] }, data);
  expect(reset.querySelectorAll('.agent-usage-connection')).toHaveLength(0); expect(reset.querySelectorAll('.agent-usage-reset')).toHaveLength(1);
});

test('数据表覆盖所有记录，图上观测点可键盘聚焦或触摸查看', () => {
  const data = history(), root = renderUsageSeries(data.series[0], data);
  expect(root.querySelector('tbody').children).toHaveLength(4);
  const dot = root.querySelector('.agent-usage-dot'), detail = root.querySelector('.agent-usage-point-detail');
  expect(dot.getAttribute('tabindex')).toBe('0'); expect(dot.getAttribute('aria-label')).toContain('剩余 80 %');
  expect(detail.hidden).toBe(true); dot.onfocus(); expect(detail.hidden).toBe(false); dot.onblur(); expect(detail.hidden).toBe(true);
  dot.onclick(); expect(detail.hidden).toBe(false);
});

test('空历史、全失败以及截断提示不伪造曲线', async () => {
  const p = await panel(defaultUsageConfig(), { ...history(), series: [] });
  expect(deepText(p.node)).toContain('暂无缓存样本'); expect(p.node.querySelectorAll('svg')).toHaveLength(0);
  const failed = { ...history(), truncated: true, series: [{ ...history().series[0], points: [point('09:00', null, { status: 'error' })] }] };
  world.state.agentUsageHistory = failed; await p.loadHistory();
  expect(deepText(p.node)).toContain('结果已截断'); expect(deepText(p.node)).toContain('没有可绘制');
  expect(p.node.querySelectorAll('svg')).toHaveLength(0);
});

test('刷新状态与历史均保留未保存表单，不丢自定义查询', async () => {
  const p = await panel(); change(field(p.node, 'retention_days'), '365');
  await btn(p.node, '添加自定义查询').onclick();
  change(field(p.node, 'provider'), 'not-yet-saved'); const form = p.node.querySelector('.agent-usage-form');
  await p.loadHistory(); await p.update({ usage_config: { ...defaultUsageConfig(), retention_days: 1 }, accounts: [] });
  expect(p.node.querySelector('.agent-usage-form')).toBe(form);
  expect(field(p.node, 'retention_days').value).toBe('365'); expect(field(p.node, 'provider').value).toBe('not-yet-saved');
  expect(deepText(p.node)).toContain('未保存');
});

test('保存完成后，较早启动的状态刷新不能用旧配置覆盖已保存值', async () => {
  const p = await panel(); change(field(p.node, 'retention_days'), '365');
  const oldRevision = p.configRevision();
  await btn(p.node, '保存查询设置').onclick();
  await p.update({ usage_config: { ...defaultUsageConfig(), retention_days: 1 } }, oldRevision);
  expect(field(p.node, 'retention_days').value).toBe('365'); expect(deepText(p.node)).toContain('查询设置已保存');
});

test('账号筛选可请求初始截断结果之外的当前账号', async () => {
  const p = await panel();
  await p.update({ usage_config: defaultUsageConfig(), accounts: [{ provider: 'another', account_key: 'not-in-first-page' }] });
  const account = p.node.querySelector('.agent-usage-account-filter');
  expect(account.children.some(option => option.value === 'another\nnot-in-first-page')).toBe(true);
  account.value = 'another\nnot-in-first-page'; await account.onchange();
  expect(requests.at(-1).url).toBe('/api/agent/usage/history?days=7&provider=another&account_key=not-in-first-page');
});

test('历史同范围刷新单飞，旧范围响应不能覆盖新范围', async () => {
  const p = await panel(), old = deferred();
  interceptor = url => url.endsWith('days=7') ? old.promise : json({ ...history(), retention_days: 42 });
  const before = requests.length, pending = p.loadHistory(), duplicate = p.loadHistory();
  expect(requests.length).toBe(before + 1);
  const days = p.node.querySelector('.agent-usage-days'); days.value = '1'; await days.onchange();
  expect(deepText(p.node)).toContain('历史保留 42 天');
  old.resolve(json({ ...history(), retention_days: 3 })); await Promise.all([pending, duplicate]);
  expect(deepText(p.node)).toContain('历史保留 42 天'); expect(deepText(p.node)).not.toContain('历史保留 3 天'); interceptor = null;
});

test('历史加载失败保留旧值并说明范围，重新读取可以恢复', async () => {
  const p = await panel(); interceptor = () => Promise.reject(new Error('模拟历史失败'));
  await p.loadHistory(); expect(deepText(p.node)).toContain('保留上次范围的历史，并非本次结果'); expect(p.node.querySelectorAll('svg')).toHaveLength(1);
  expect(p.node.querySelector('.agent-usage-history-feedback').getAttribute('role')).toBe('alert');
  interceptor = null; await p.loadHistory(); expect(p.node.querySelector('.agent-usage-history-feedback').getAttribute('role')).toBe('status');
});

test('老状态响应按需读取配置，读取失败不以默认值覆盖；支持重试', async () => {
  interceptor = url => url === '/api/agent/usage/config' ? Promise.reject(new Error('模拟损坏配置')) : null; current = true;
  const p = createAgentUsage({ ownsPage: () => current }); await p.update({ accounts: [] });
  expect(deepText(p.node)).toContain('未使用默认值覆盖'); expect(p.node.querySelectorAll('form')).toHaveLength(0);
  interceptor = null; await btn(p.node, '重试读取查询配置').onclick(); expect(p.node.querySelectorAll('form')).toHaveLength(1);
});

test('保存失败保留编辑、允许重试，保存期间不会重复提交', async () => {
  const p = await panel(); change(field(p.node, 'retention_days'), '365');
  interceptor = url => url === '/api/action' ? Promise.reject(new Error('模拟保存失败')) : null;
  await btn(p.node, '保存查询设置').onclick(); expect(deepText(p.node)).toContain('保存失败'); expect(field(p.node, 'retention_days').value).toBe('365');
  const wait = deferred(); interceptor = url => url === '/api/action' ? wait.promise : null;
  const before = requests.filter(request => request.url === '/api/action').length;
  const pending = btn(p.node, '保存查询设置').onclick(), duplicate = btn(p.node, '保存查询设置').onclick();
  expect(requests.filter(request => request.url === '/api/action').length).toBe(before + 1);
  wait.resolve(json({ ...defaultUsageConfig(), retention_days: 365 })); await Promise.all([pending, duplicate]);
  expect(deepText(p.node)).toContain('已保存'); interceptor = null;
});

test('离页后的历史与配置保存响应不更新旧画布', async () => {
  const p = await panel(), wait = deferred(); interceptor = url => url.includes('/history?') ? wait.promise : null;
  const pending = p.loadHistory(), old = deepText(p.node); current = false;
  wait.resolve(json({ ...history(), retention_days: 777 })); await pending; expect(deepText(p.node)).toBe(old);
  current = true; interceptor = null;
  const saved = deferred(); interceptor = url => url === '/api/action' ? saved.promise : null;
  const save = btn(p.node, '保存查询设置').onclick(), during = deepText(p.node); current = false;
  saved.resolve(json({ ...defaultUsageConfig(), retention_days: 888 })); await save; expect(deepText(p.node)).toBe(during);
  interceptor = null; current = true;
});

test('接口文字作为安全文本；样式独立加载且无内联样式或 HTML 拼接', () => {
  const payload = '<img src=x onerror=alert(1)>', data = history(); data.series[0].label = payload;
  const root = renderUsageSeries(data.series[0], data);
  expect(deepText(root)).toContain(payload); expect(root.querySelectorAll('img')).toHaveLength(0);
  for (const file of ['render-agent-usage.js', 'agent-usage-form.js']) {
    const source = fs.readFileSync(new URL(`../../src/ui/web/assets/${file}`, import.meta.url), 'utf8'); expect(source).not.toContain('innerHTML'); expect(source).not.toContain('.style');
  }
  const html = fs.readFileSync(new URL('../../src/ui/web/assets/index.html', import.meta.url), 'utf8'); expect(html).toContain('/styles-agent-usage.css');
  const css = fs.readFileSync(new URL('../../src/ui/web/assets/styles-agent-usage.css', import.meta.url), 'utf8'); expect(css).toContain('var(--bg)'); expect(css).toContain('@media(max-width:600px)');
});
