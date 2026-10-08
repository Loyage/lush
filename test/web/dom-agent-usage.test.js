import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';

const world = makeWorld(), requests = [];
let interceptor = null, current = true;
const json = value => ({ ok: true, status: 200, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const dom = installDom({ fetch(url, options) { requests.push({ url: String(url), options }); return interceptor?.(String(url), options) ?? world.fetchImpl(url, options); } });
dom.document.createElementNS = (_ns, tag) => dom.document.createElement(tag);
const { createLegacyUsageHistory, renderUsageSeries } = await import('../../src/ui/web/assets/render-agent-usage.js');
afterAll(() => dom.restore());
const btn = (root, name) => root.querySelectorAll('button').find(button => button.textContent === name);
const point = (at, remaining, extra = {}) => ({ at: `2026-10-01T${at}:00.000Z`, remaining, total: 100, used: remaining === null ? null : 100 - remaining, status: 'available', reset_at: null, error_code: null, ...extra });
const history = () => ({ version: 1, from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z', retention_days: 90, truncated: false,
  series: [{ id: 'codex:account-a:week', provider: 'openai-codex', account_key: 'account-a', kind: 'quota', label: '周额度', unit: '%', window_seconds: 604800,
    sample_count: 4, points: [point('09:00', 80), point('09:05', 60), point('09:10', null, { status: 'error', error_code: 'network' }), point('09:15', 0)] },
  { id: 'deepseek:account-b:balance', provider: 'deepseek', account_key: 'account-b', kind: 'balance', label: '现金余额', unit: 'USD', window_seconds: null,
    sample_count: 2, points: [point('09:00', 12), point('09:05', 10)] }] });
async function panel(data = history()) {
  interceptor = null; current = true; requests.length = 0;
  world.state.agentUsageHistory = data; world.state.actions = [];
  const panel = createLegacyUsageHistory({ ownsPage: () => current });
  expect(requests).toHaveLength(0); await panel.loadHistory(); return panel;
}

test('旧余额存档只读，创建不请求数据，加载不请求配置/状态或提交设置', async () => {
  const p = await panel(), text = deepText(p.node);
  expect(text).toContain('历史保留 90 天'); expect(text).toContain('不归到任何正式连接'); expect(text).toContain('不查询账号或旧凭证');
  expect(text).toContain('不提供旧采样或 HTTP 查询设置');
  expect(text).toContain('旧配置元数据'); expect(text).toContain('存档不执行清理');
  expect(p.node.querySelectorAll('form')).toHaveLength(0); expect(p.node.querySelector('[data-field="enabled"]')).toBeNull();
  expect(requests.map(request => request.url)).toEqual(['/api/agent/usage/history?days=7']); expect(world.state.actions).toHaveLength(0);
  expect(p.node.querySelectorAll('.agent-call')).toHaveLength(0);
  const refresh = btn(p.node, '刷新历史缓存'); expect(refresh.getAttribute('data-help')).toContain('不访问服务商');
  expect(refresh.parentNode.classList.contains('help-host')).toBe(true);
});

test('缺少历史保留期限时明确未知，不额外请求旧查询配置', async () => {
  const data = history(); delete data.retention_days; const p = await panel(data);
  expect(deepText(p.node)).toContain('历史保留期限未知'); expect(deepText(p.node)).not.toContain('undefined');
  expect(deepText(p.node)).toContain('存档不执行清理');
  expect(requests.map(request => request.url)).toEqual(['/api/agent/usage/history?days=7']);
});

test('历史账号/指标/单位分别绘图，所有范围与账号筛选只读缓存', async () => {
  const p = await panel(); expect(p.node.querySelectorAll('svg')).toHaveLength(1);
  expect(p.node.querySelector('svg').getAttribute('aria-label')).toContain('单位 %');
  const metric = p.node.querySelector('.agent-usage-metric-filter'); metric.value = 'deepseek:account-b:balance'; metric.onchange();
  expect(p.node.querySelector('svg').getAttribute('aria-label')).toContain('单位 USD');
  expect(p.node.querySelector('.agent-usage-history-content').querySelectorAll('svg')).toHaveLength(1);
  const account = p.node.querySelector('.agent-usage-account-filter'); account.value = 'openai-codex\naccount-a'; await account.onchange();
  expect(metric.children).toHaveLength(1); expect(metric.value).toBe('codex:account-a:week');
  const range = p.node.querySelector('.agent-usage-days'); expect(range.children.map(option => option.value)).toEqual(['1', '7', '30', '90']);
  for (const days of ['1', '30', '90']) { range.value = days; await range.onchange(); expect(requests.at(-1).url).toBe(`/api/agent/usage/history?days=${days}&provider=openai-codex&account_key=account-a`); }
  expect(requests.every(request => request.url.startsWith('/api/agent/usage/history?'))).toBe(true);
});

test('剩余零、未知及错误分开，失败断线且最后成功值带旧时间', () => {
  const data = history(), series = data.series[0], root = renderUsageSeries(series, data);
  expect(root.querySelectorAll('.agent-usage-dot')).toHaveLength(3); expect(root.querySelectorAll('.agent-usage-connection')).toHaveLength(1);
  expect(deepText(root)).toContain('未知不等于零'); expect(deepText(root)).toContain('网络查询失败');
  expect(root.querySelectorAll('td').some(td => td.textContent === '0')).toBe(true);
  const failed = renderUsageSeries({ ...series, points: [...series.points, point('09:20', 999, { status: 'error', error_code: 'expired' })] }, data);
  expect(deepText(failed)).toContain('最后成功剩余量 0 %'); expect(deepText(failed)).toContain('并非最新状态');
  expect(deepText(failed)).toContain('09:15:00.000Z'); expect(deepText(failed)).not.toContain('999');
});

test('保留正式连接复用的重置/补充与采样间隔断线，截断历史只画观测点', () => {
  const data = history(), series = { ...data.series[0], points: [point('09:00', 70), point('09:05', 60), point('09:10', 95), point('10:00', 90)] };
  const root = renderUsageSeries(series, data, { enabled: true, interval_minutes: 5 });
  expect(root.querySelectorAll('.agent-usage-connection')).toHaveLength(1);
  expect(root.querySelectorAll('.agent-usage-reset')).toHaveLength(1); expect(deepText(root)).toContain('重置 / 补充');
  const truncated = renderUsageSeries(series, { ...data, truncated: true });
  expect(truncated.querySelectorAll('.agent-usage-connection')).toHaveLength(0); expect(deepText(truncated)).toContain('不跨缺失记录连线');
  const reset = renderUsageSeries({ ...series, points: [point('09:00', 70, { reset_at: '2026-10-01T10:00:00Z' }), point('09:05', 60, { reset_at: '2026-10-01T11:00:00Z' })] }, data);
  expect(reset.querySelectorAll('.agent-usage-connection')).toHaveLength(0); expect(reset.querySelectorAll('.agent-usage-reset')).toHaveLength(1);
});

test('历史窗口与百分比单独呈现，限流和凭证冲突不是零额度', () => {
  const data = history(), series = { ...data.series[0], window_seconds: 18000,
    points: [point('09:00', 99.5, { used_percent: 0.5 }), point('09:05', null, { status: 'error', error_code: 'rate_limited' })] };
  const root = renderUsageSeries(series, data);
  expect(deepText(root)).toContain('5 小时窗口'); expect(deepText(root)).toContain('HTTP 429'); expect(deepText(root)).toContain('已用百分比 (%)');
  expect(root.querySelector('tbody').children[0].children[4].textContent).toBe('0.5'); expect(root.querySelector('tbody').children[1].children[4].textContent).toBe('未知');
  expect(root.querySelectorAll('.agent-usage-dot')).toHaveLength(1);
  const unknown = renderUsageSeries({ ...series, window_seconds: null, points: [point('09:00', null, { status: 'error', error_code: 'auth_changed' })] }, data);
  expect(deepText(unknown)).toContain('窗口时长未知'); expect(deepText(unknown)).toContain('登录凭证已变化');
});

test('数据表覆盖全部记录，观测点可键盘聚焦和触摸查看', () => {
  const data = history(), root = renderUsageSeries(data.series[0], data); expect(root.querySelector('tbody').children).toHaveLength(4);
  const dot = root.querySelector('.agent-usage-dot'), detail = root.querySelector('.agent-usage-point-detail');
  expect(dot.getAttribute('tabindex')).toBe('0'); expect(dot.getAttribute('aria-label')).toContain('剩余 80 %');
  expect(detail.hidden).toBe(true); dot.onfocus(); expect(detail.hidden).toBe(false); dot.onblur(); expect(detail.hidden).toBe(true); dot.onclick(); expect(detail.hidden).toBe(false);
});

test('空历史、全失败以及截断提示不伪造曲线', async () => {
  const p = await panel({ ...history(), series: [] }); expect(deepText(p.node)).toContain('暂无缓存样本'); expect(p.node.querySelectorAll('svg')).toHaveLength(0);
  world.state.agentUsageHistory = { ...history(), truncated: true, series: [{ ...history().series[0], points: [point('09:00', null, { status: 'error' })] }] };
  await p.loadHistory(); expect(deepText(p.node)).toContain('结果已截断'); expect(deepText(p.node)).toContain('没有可绘制'); expect(p.node.querySelectorAll('svg')).toHaveLength(0);
});

test('曾在其他范围出现的账号保留可选项，不查旧凭证或诊断', async () => {
  const p = await panel(); world.state.agentUsageHistory = { ...history(), series: [] }; await p.loadHistory();
  const account = p.node.querySelector('.agent-usage-account-filter'); expect(account.children.some(option => option.value === 'deepseek\naccount-b')).toBe(true);
  account.value = 'deepseek\naccount-b'; await account.onchange(); expect(requests.at(-1).url).toBe('/api/agent/usage/history?days=7&provider=deepseek&account_key=account-b');
});

test('历史刷新单飞，旧范围响应不能覆盖新范围', async () => {
  const p = await panel(), old = deferred();
  interceptor = url => url.endsWith('days=7') ? old.promise : json({ ...history(), retention_days: 42 });
  const before = requests.length, pending = btn(p.node, '刷新历史缓存').onclick(), duplicate = btn(p.node, '刷新历史缓存').onclick();
  expect(requests.length).toBe(before + 1);
  const days = p.node.querySelector('.agent-usage-days'); days.value = '1'; await days.onchange(); expect(deepText(p.node)).toContain('历史保留 42 天');
  old.resolve(json({ ...history(), retention_days: 3 })); await Promise.all([pending, duplicate]);
  expect(deepText(p.node)).toContain('历史保留 42 天'); expect(deepText(p.node)).not.toContain('历史保留 3 天'); interceptor = null;
});

test('账号切换与迟到响应不会显示另一账号曲线，包括读取失败', async () => {
  const p = await panel(), old = deferred(), account = p.node.querySelector('.agent-usage-account-filter');
  interceptor = url => url.includes('account_key=account-b') ? old.promise : Promise.reject(new Error('账号A读取失败'));
  account.value = 'deepseek\naccount-b'; const pending = account.onchange(); account.value = 'openai-codex\naccount-a'; await account.onchange();
  old.resolve(json({ ...history(), series: [history().series[1]] })); await pending;
  const content = deepText(p.node.querySelector('.agent-usage-history-content'));
  expect(content).toContain('账号 account-a'); expect(content).not.toContain('账号 account-b'); interceptor = null;
});

test('读取失败保留旧结果且说明范围，重试恢复；格式不兼容不覆盖已有数据', async () => {
  const p = await panel(); interceptor = () => Promise.reject(new Error('模拟历史失败'));
  await p.loadHistory(); expect(deepText(p.node)).toContain('保留上次范围的历史，并非本次结果'); expect(p.node.querySelectorAll('svg')).toHaveLength(1);
  expect(p.node.querySelector('.agent-usage-history-feedback').getAttribute('role')).toBe('alert');
  interceptor = () => json({ version: 2, series: [] }); await p.loadHistory(); expect(deepText(p.node)).toContain('历史数据格式不兼容');
  interceptor = null; await p.loadHistory(); expect(p.node.querySelector('.agent-usage-history-feedback').getAttribute('role')).toBe('status');
});

test('首次历史失败可重试，保留只读空态且不回退查询旧配置', async () => {
  current = true; requests.length = 0; interceptor = () => Promise.reject(new Error('缓存不可用'));
  const p = createLegacyUsageHistory({ ownsPage: () => current }); await p.loadHistory(); expect(deepText(p.node)).toContain('可重新读取缓存');
  expect(p.node.querySelectorAll('form')).toHaveLength(0); interceptor = null; await btn(p.node, '刷新历史缓存').onclick();
  expect(requests.every(request => request.url.includes('/usage/history?'))).toBe(true);
});

test('离页和收起作废旧响应，重新展开的读取不能被旧响应覆盖', async () => {
  const p = await panel(), wait = deferred(); interceptor = () => wait.promise;
  const pending = p.loadHistory(), old = deepText(p.node); current = false;
  wait.resolve(json({ ...history(), retention_days: 777 })); await pending; expect(deepText(p.node)).toBe(old);
  current = true; const earlier = deferred(); interceptor = () => earlier.promise; const stale = p.loadHistory(); p.invalidate();
  interceptor = () => json({ ...history(), retention_days: 42 }); await p.loadHistory();
  earlier.resolve(json({ ...history(), retention_days: 888 })); await stale;
  expect(deepText(p.node)).toContain('历史保留 42 天'); expect(deepText(p.node)).not.toContain('历史保留 888 天'); interceptor = null;
});

test('正式趋势可切换结构化读数，百分比独立单位，多次切换不失效或联网', () => {
  const data = history(), root = renderUsageSeries(data.series[1], data, { selectMetric: true });
  const count = requests.length;
  let metric = root.querySelector('.agent-usage-reading');
  expect(metric.children.map(option => option.value)).toEqual(['remaining', 'used', 'total']);
  // Percentages are not inferred from totals.
  metric.value = 'used'; metric.onchange(); expect(root.querySelector('svg').getAttribute('aria-label')).toContain('已用量曲线，单位 USD');
  metric.value = 'total'; metric.onchange(); expect(root.querySelectorAll('.agent-usage-dot')).toHaveLength(2);
  expect(root.querySelector('svg').getAttribute('aria-label')).toContain('总量曲线');
  metric.value = 'remaining'; metric.onchange(); expect(root.querySelector('svg').getAttribute('aria-label')).toContain('剩余曲线');
  expect(requests.length).toBe(count);
  const percent = renderUsageSeries({ ...data.series[1], points: [point('09:00', 12, { used_percent: 25 })] }, data, { selectMetric: true });
  metric = percent.querySelector('.agent-usage-reading'); metric.value = 'used_percent'; metric.onchange();
  expect(percent.querySelector('svg').getAttribute('aria-label')).toContain('已用比例曲线，单位 %');
  expect(percent.querySelector('.agent-usage-dot').getAttribute('aria-label')).toContain('已用比例 25 %');
});

test('只有已用比例仍能绘图，缺失与失败留空，比例下降不连成负消耗', () => {
  const data = history(), series = { ...data.series[0], points: [
    point('09:00', null, { used: null, total: null, used_percent: 20 }),
    point('09:05', null, { used: null, total: null, used_percent: 30 }),
    point('09:10', null, { used: null, total: null, used_percent: 5 }),
    point('09:15', null, { used: null, total: null, used_percent: null }),
    point('09:20', null, { status: 'error', used_percent: 99 }),
    point('09:25', null, { used: null, total: null, used_percent: 10 }),
  ] };
  const root = renderUsageSeries(series, data, { selectMetric: true });
  expect(root.querySelector('.agent-usage-reading').value).toBe('used_percent');
  expect(root.querySelectorAll('.agent-usage-dot')).toHaveLength(4);
  expect(root.querySelectorAll('.agent-usage-connection')).toHaveLength(1);
  expect(root.querySelectorAll('.agent-usage-reset')).toHaveLength(1);
  expect(root.querySelector('tbody').children).toHaveLength(6);
  expect(root.querySelector('tbody').children[4].children[4].textContent).toBe('未知');
  const empty = renderUsageSeries({ ...series, points: [] }, data, { selectMetric: true });
  expect(empty.querySelectorAll('svg')).toHaveLength(0); expect(deepText(empty)).toContain('暂无采样');
});

test('接口文字仅为安全文本，历史组件不含旧配置读取/写入口，无内联样式或HTML拼接', () => {
  const payload = '<img src=x onerror=alert(1)>', data = history(); data.series[0].label = payload;
  const root = renderUsageSeries(data.series[0], data); expect(deepText(root)).toContain(payload); expect(root.querySelectorAll('img')).toHaveLength(0);
  const source = fs.readFileSync(new URL('../../src/ui/web/assets/render-agent-usage.js', import.meta.url), 'utf8');
  for (const value of ['innerHTML', '.style', 'usageConfigForm', '/api/agent/usage/config', 'agent.usage.configure', 'createAgentUsage']) expect(source).not.toContain(value);
  const html = fs.readFileSync(new URL('../../src/ui/web/assets/index.html', import.meta.url), 'utf8'); expect(html).toContain('/styles-agent-usage.css');
  const css = fs.readFileSync(new URL('../../src/ui/web/assets/styles-agent-usage.css', import.meta.url), 'utf8'); expect(css).toContain('var(--bg)'); expect(css).toContain('@media(max-width:600px)');
});
