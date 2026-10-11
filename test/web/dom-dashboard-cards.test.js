import { afterAll, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installDom, deepText } from '../dom-stub.js';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const at = '2026-10-01T09:00:00.000Z';
const metric = (extra = {}) => ({ id: 'cash', kind: 'balance', scope: 'account', label: '账户现金', unit: 'USD', remaining: 12.5,
  total: null, used: null, used_percent: null, reset_at: null, window_seconds: null, models: [], ...extra });
const observation = (extra = {}) => ({ status: 'available', source: 'usage_api', checked_at: at, resources: [metric()], ...extra });
const connection = (extra = {}) => ({ id: ids[0], label: '个人账户', provider: 'deepseek', endpoint: 'https://api.deepseek.com', enabled: true,
  observation: observation(), last_success: null, consumers: [{ task_id: 999 }], ...extra });
const json = value => ({ ok: true, status: 200, json: async () => structuredClone(value) });
const fail = error => ({ ok: false, status: 409, json: async () => ({ error }) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let config, connections, current, intercept;
const requests = [];
const dom = installDom({ fetch: async (url, options) => {
  requests.push({ url, options });
  const custom = intercept?.(url, options); if (custom !== undefined) return custom;
  if (url === '/api/host/dashboard') {
    if (options?.method === 'POST') {
      const body = JSON.parse(options.body);
      if (body.expected_revision !== config.revision) return fail('dashboard revision conflict');
      config = { ...config, revision: `${config.revision}-next`, cards: body.cards }; return json(config);
    }
    return json(config);
  }
  if (url === '/api/host/settings/agent/connections?scope=device') return json({ connections,
    configuration_scope: { selected: 'device', source: 'device', project_override: false } });
  throw new Error(`unexpected fetch ${url}`);
} });
const { readDashboardConfig, loadDashboardConnections, loadAccountCards, renderAccountCard, refreshAccountCards, createDashboardCardSettings } = await import('../../src/ui/web/assets/dashboard-cards.js');
const { resetUiState } = await import('../../src/ui/web/assets/state.js');
afterAll(() => dom.restore());
beforeEach(() => {
  resetUiState();
  config = { version: 1, revision: 'r1', cards: ids.slice(0, 2).map(connection_id => ({ type: 'account', connection_id })) };
  connections = [connection(), connection({ id: ids[1], label: '工作账户' })]; current = true; intercept = null; requests.length = 0;
  dom.location.pathname = '/';
});
const row = (entry = connection()) => ({ id: `account:${entry.id}`, type: 'account', connection_id: entry.id, connection: entry });
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const checkbox = (root, id = ids[0]) => root.querySelector(`input[data-connection-id="${id}"]`);
const select = (root, id, value) => { const input = checkbox(root, id); input.checked = value; input.onchange(); };
const writes = () => requests.filter(entry => entry.options?.method === 'POST');
async function settings() { const panel = createDashboardCardSettings({ ownsPage: () => current }); await panel.ready; return panel; }

test('多账户各有稳定ID，不按服务商合并，只读Host设备缓存且项目路由不改请求', async () => {
  dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/';
  const rows = await loadAccountCards();
  expect(rows.map(entry => entry.id)).toEqual(ids.slice(0, 2).map(id => `account:${id}`));
  expect(rows.map(entry => entry.connection.label)).toEqual(['个人账户', '工作账户']);
  expect(requests.map(entry => entry.url)).toEqual(['/api/host/dashboard', '/api/host/settings/agent/connections?scope=device']);
  expect(writes()).toHaveLength(0);
  const root = renderAccountCard(rows[0]); expect(root.tagName).toBe('LI');
  expect(root.classList.contains('project-item')).toBe(true); expect(root.dataset.cardId).toBe(rows[0].id);
  const content = deepText(root); expect(content).toContain('个人账户'); expect(content).not.toContain('DeepSeek');
  expect(content).toContain('现金余额'); expect(content).toContain('12.5 USD'); expect(content).not.toContain('999');
});

test('全部结构化指标独立展示，不限两项、不混币种、分类单位窗口模型与原始读数完整', () => {
  const root = renderAccountCard(row(connection({ observation: observation({ status: 'partial', resources: [
    metric(), metric({ id: 'cny', label: '人民币余额', unit: 'CNY', remaining: 80 }),
    metric({ id: 'key', kind: 'quota', scope: 'key', label: 'Key消费', unit: 'USD', remaining: 7, total: 10, used: 3, used_percent: 30, window_seconds: 3600, reset_at: at, models: ['vendor/a'] }),
    metric({ id: 'plan', kind: 'quota', scope: 'account', label: '套餐窗口', unit: '%', remaining: 60, used_percent: 40, window_seconds: 604800, reset_at: at }),
    metric({ id: 'model', kind: 'quota', scope: 'model', label: '模型token', unit: 'tokens', remaining: 150, total: 200, used: 50 }),
  ] }) })), { sections: ['quota', 'balance', 'reset', 'observed', 'details', 'provenance'] });
  expect(root.querySelectorAll('.dashboard-account-metric')).toHaveLength(5);
  expect(root.querySelectorAll('progress')).toHaveLength(3);
  const content = deepText(root);
  for (const expected of ['部分指标可用', '12.5 USD', '80 CNY', 'Key 预算', '套餐额度', '模型额度',
    '总量 10 USD', '已用 3 USD', '原始已用比例：30 %', '1 小时窗口', '7 天（周）窗口', 'vendor/a', '重置：', '到期待刷新', '百分比不是实际 token']) expect(content).toContain(expected);
  expect(root.querySelectorAll('progress').map(node => node.value)).toEqual([30, 40, 25]);
});

test('未知数值不填零、不画伪进度，不按窗口顺序推断期限', () => {
  const root = renderAccountCard(row(connection({ observation: observation({ resources: [metric({ kind: 'quota', remaining: null })] }) })));
  const content = deepText(root); expect(content).toContain('剩余 未知 USD'); expect(content).not.toContain('剩余 0');
  expect(content).toContain('已用比例未知'); expect(content).toContain('窗口时长未知'); expect(content).toContain('重置时间未知');
  expect(root.querySelectorAll('progress')).toHaveLength(0);
});

test('比例推导仅用结构化数值，0为真实零，超范围原值不被展示截断', () => {
  const root = renderAccountCard(row(connection({ observation: observation({ resources: [
    metric({ kind: 'quota', remaining: 0, total: 10 }), metric({ id: 'odd', kind: 'quota', used_percent: 120 }),
    metric({ id: 'bad', kind: 'quota', remaining: NaN, total: Infinity, used: '0' }),
  ] }) })));
  const content = deepText(root); expect(content).toContain('剩余 0 USD'); expect(content).toContain('已用 100%'); expect(content).toContain('已用 120%');
  expect(root.querySelectorAll('progress').map(node => node.value)).toEqual([100, 100]);
});

test('失败不展示当前值，不拿历史成功冒充现状；历史折叠且有时间口径', () => {
  const root = renderAccountCard(row(connection({ observation: observation({ status: 'error', error_code: 'rate_limited', resources: [metric({ remaining: 999 })] }),
    last_success: { checked_at: at, observation: observation() } })), { sections: ['quota', 'balance', 'observed', 'history', 'provenance'] });
  expect(deepText(root)).toContain('查询失败'); expect(deepText(root)).toContain('HTTP 429');
  expect(deepText(root)).not.toContain('999 USD');
  const old = root.querySelector('.dashboard-account-old'); expect(old).not.toBeNull(); expect(old.open).not.toBe(true);
  expect(deepText(old)).toContain('历史成功观测（非当前值）'); expect(deepText(old)).toContain('12.5 USD');
  expect(root.querySelector('.dashboard-account-observation').querySelectorAll('.dashboard-account-metric')).toHaveLength(0);
});

test('source:none的列表读取时间不冒充观测时间，未知状态也不把旧成功显示为当前', () => {
  const root = renderAccountCard(row(connection({ observation: observation({ status: 'unknown', source: 'none', checked_at: at }),
    last_success: { checked_at: at, observation: observation() } })), { sections: ['observed', 'history'] });
  const current = root.querySelector('.dashboard-account-observation');
  expect(deepText(current)).toContain('时间未知（尚无观测）'); expect(deepText(current)).toContain('未知不等于零');
  expect(current.querySelectorAll('.dashboard-account-metric')).toHaveLength(0);
  expect(deepText(root.querySelector('.dashboard-account-old'))).toContain('历史成功观测（非当前值）');
});

test('未观测、无指标、禁用来源与安全文本准确显示', () => {
  let root = renderAccountCard(row(connection({ label: '<script>evil</script>', enabled: false, observation: null })));
  expect(deepText(root)).toContain('<script>evil</script>'); expect(root.querySelector('script')).toBeNull();
  expect(deepText(root)).toContain('来源已停用'); expect(deepText(root)).toContain('未知不等于零'); expect(deepText(root)).toContain('时间未知');
  root = renderAccountCard(row(connection({ observation: observation({ resources: [] }) })));
  expect(deepText(root)).toContain('暂无可展示指标');
});

test('配置无卡片且设备无账户是真空态；已删除选中来源仍有占位', async () => {
  connections = []; const rows = await loadAccountCards(); expect(rows).toHaveLength(2); expect(rows[0].connection).toBeNull();
  expect(deepText(renderAccountCard(rows[0]))).toContain('账户来源已删除或不可用');
  config.cards = []; expect(await loadAccountCards()).toEqual([]);
  const panel = await settings(); expect(deepText(panel.root)).toContain('尚无设备托管账户'); expect(writes()).toHaveLength(0);
});

test('配置或缓存读取失败必须拒绝，绝不冒称无卡片', async () => {
  intercept = url => url === '/api/host/dashboard' ? fail('unsafe config') : undefined;
  await expect(loadAccountCards()).rejects.toThrow('卡片配置读取失败');
  intercept = url => url.includes('/agent/connections') ? fail('unsafe cache') : undefined;
  await expect(loadAccountCards()).rejects.toThrow('设备账户 / 余额缓存读取失败');
});

test('无效配置响应与错误设备作用域拒绝，不初始化写回', async () => {
  config.cards.push(config.cards[0]); await expect(loadAccountCards()).rejects.toThrow('未将其视为无卡片');
  config.cards = [];
  intercept = url => url.includes('/agent/connections') ? json({ connections, configuration_scope: { selected: 'project', source: 'project' } }) : undefined;
  await expect(loadAccountCards()).rejects.toThrow('Host 未确认设备设置来源');
  const panel = await settings(); expect(button(panel.root, '保存卡片选择').disabled).toBe(true); expect(writes()).toHaveLength(0);
});

test('设置初次读取所有账户复选，已删除来源可取消并显式保存；仅提交ID和revision', async () => {
  connections = [connection(), connection({ id: ids[2], label: '另一账户', enabled: false })];
  const panel = await settings(); expect(panel.root.querySelectorAll('input')).toHaveLength(3);
  expect(checkbox(panel.root, ids[1]).checked).toBe(true); expect(checkbox(panel.root, ids[2]).checked).toBe(false);
  select(panel.root, ids[1], false); select(panel.root, ids[2], true);
  await button(panel.root, '保存卡片选择').click();
  expect(JSON.parse(writes()[0].options.body)).toEqual({ expected_revision: 'r1', cards: [
    { type: 'account', connection_id: ids[0] }, { type: 'account', connection_id: ids[2] },
  ] });
  expect(deepText(panel.root)).toContain('已保存到设备'); expect(checkbox(panel.root, ids[1])).toBeNull();
  expect(panel.root.querySelectorAll('.agent-call')).toHaveLength(0);
  expect(localStorage.getItem('lush.dashboard')).toBeNull();
});

test('双独立页面共享后端选择；重新读取前草稿不互相覆盖', async () => {
  const first = await settings(), second = await settings(); select(first.root, ids[1], false);
  await button(first.root, '保存卡片选择').click();
  expect(checkbox(second.root, ids[1]).checked).toBe(true);
  expect(button(second.root, '重新读取').dataset.help).toContain('替换此页未保存的选择');
  await button(second.root, '重新读取').click(); expect(checkbox(second.root, ids[1]).checked).toBe(false);
  expect(writes()).toHaveLength(1);
});

test('跨浏览器revision冲突保留编辑，禁重试，显式重新读取后才能保存', async () => {
  const first = await settings(), second = await settings(); select(first.root, ids[1], false); await button(first.root, '保存卡片选择').click();
  select(second.root, ids[0], false); await button(second.root, '保存卡片选择').click();
  expect(checkbox(second.root, ids[0]).checked).toBe(false); expect(checkbox(second.root, ids[1]).checked).toBe(true);
  expect(deepText(second.root)).toContain('本页选择已保留'); const save = button(second.root, '保存卡片选择'); expect(save.disabled).toBe(true);
  expect(save.parentNode.dataset.help).toContain('先重新读取'); expect(save.parentNode.getAttribute('tabindex')).toBe('0');
  await save.click(); expect(writes()).toHaveLength(2);
  await button(second.root, '重新读取').click(); expect(checkbox(second.root, ids[0]).checked).toBe(true); expect(checkbox(second.root, ids[1]).checked).toBe(false);
  expect(save.disabled).toBe(false); expect(save.parentNode.getAttribute('tabindex')).toBeNull();
});

test('保存ACK与后续账户缓存失败分开报告，不重发成功写入，后续保存使用ACK revision', async () => {
  const panel = await settings(); select(panel.root, ids[1], false);
  intercept = url => url.includes('/agent/connections') ? fail('cache damaged') : undefined;
  await button(panel.root, '保存卡片选择').click(); expect(writes()).toHaveLength(1);
  expect(deepText(panel.root)).toContain('已保存到设备；后续'); expect(deepText(panel.root)).toContain('不必再次保存');
  intercept = null; select(panel.root, ids[0], false); await button(panel.root, '保存卡片选择').click();
  expect(JSON.parse(writes()[1].options.body).expected_revision).toBe('r1-next');
});

test('保存网络失败保留草稿且明确未知写入，不自动重试；重读失败仍保留', async () => {
  const panel = await settings(); select(panel.root, ids[1], false);
  intercept = (_url, options) => options?.method === 'POST' ? Promise.reject(new Error('network lost')) : undefined;
  await button(panel.root, '保存卡片选择').click(); expect(writes()).toHaveLength(1);
  expect(deepText(panel.root)).toContain('保存未获确认'); expect(checkbox(panel.root, ids[1]).checked).toBe(false);
  intercept = url => url === '/api/host/dashboard' ? fail('broken') : undefined;
  await panel.reload(); expect(checkbox(panel.root, ids[1]).checked).toBe(false); expect(deepText(panel.root)).toContain('保留已有选择');
});

test('读取和写入单飞，迟到离页读取不绘制或初始化配置', async () => {
  const delayed = deferred(); intercept = url => url === '/api/host/dashboard' ? delayed.promise : undefined;
  const panel = createDashboardCardSettings({ ownsPage: () => current });
  await panel.reload(); await button(panel.root, '保存卡片选择').click(); expect(requests).toHaveLength(2);
  current = false; delayed.resolve(json(config)); await panel.ready;
  expect(panel.root.querySelectorAll('input')).toHaveLength(0); expect(writes()).toHaveLength(0);
});

test('在途保存禁止编辑和重复写入，离页ACK不更新旧DOM也不启动后读', async () => {
  const panel = await settings(), delayed = deferred(); select(panel.root, ids[1], false);
  intercept = (_url, options) => options?.method === 'POST' ? delayed.promise : undefined;
  const save = button(panel.root, '保存卡片选择'), saving = save.click();
  expect(save.disabled).toBe(true); expect(checkbox(panel.root).disabled).toBe(true);
  await save.click(); await panel.reload(); expect(writes()).toHaveLength(1);
  const before = deepText(panel.root), count = requests.length; current = false;
  delayed.resolve(json({ ...config, revision: 'r2', cards: [] })); await saving;
  expect(deepText(panel.root)).toBe(before); expect(requests).toHaveLength(count);
});

test('离页总览读取不返回旧结果，未拥有页面不请求；dispose阻止设置迟到渲染', async () => {
  current = false; await expect(loadAccountCards({ ownsPage: () => current })).rejects.toMatchObject({ name: 'AbortError' }); expect(requests).toHaveLength(0);
  current = true; const delayed = deferred(); intercept = url => url === '/api/host/dashboard' ? delayed.promise : undefined;
  const pending = loadAccountCards({ ownsPage: () => current }); current = false; delayed.resolve(json(config));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  current = true; const read = deferred(); intercept = url => url === '/api/host/dashboard' ? read.promise : undefined;
  const panel = createDashboardCardSettings(); panel.dispose(); read.resolve(json(config)); await panel.ready;
  expect(panel.root.querySelectorAll('input')).toHaveLength(0);
});

test('默认账户卡精简，仅关键读数时间与刷新，不带成功状态端点和长解释', () => {
  const root = renderAccountCard(row(connection({ observation: observation({ resources: [metric(), metric({ id: 'plan', kind: 'quota', used_percent: 40,
    window_seconds: 18000, reset_at: '2099-01-01T00:00:00Z' })] }) })), { refresh: async () => {} });
  const content = deepText(root);
  for (const expected of ['个人账户', '12.5 USD', '已用 40%', '5 小时窗口', '重置：', '上次观测：', '刷新']) expect(content).toContain(expected);
  for (const absent of ['观测成功', '模型端点', '仅展示设备缓存', '指标详情', '观测来源', '原始已用比例', '不代表额度已恢复']) expect(content).not.toContain(absent);
  expect(root.querySelectorAll('progress')).toHaveLength(1); expect(root.querySelectorAll('details')).toHaveLength(0);
  expect(button(root, '刷新').disabled).toBe(false); expect(root.querySelectorAll('.agent-call')).toHaveLength(0);
});

test('sections空数组隐藏可选内容但保留名称异常历史标识和刷新', () => {
  let root = renderAccountCard(row(), { sections: [], refresh: async () => {} });
  expect(deepText(root).replace(/\s/g, '')).toBe('个人账户刷新'); expect(root.querySelectorAll('.dashboard-account-metric')).toHaveLength(0);
  root = renderAccountCard(row(connection({ observation: observation({ status: 'error', resources: [metric({ remaining: 999 })] }),
    last_success: { checked_at: at, observation: observation() } })), { sections: [], refresh: async () => {} });
  expect(deepText(root)).toContain('查询失败'); expect(deepText(root)).toContain('历史成功观测（非当前值）');
  expect(deepText(root)).not.toContain('12.5'); expect(deepText(root)).not.toContain('999'); expect(deepText(root)).not.toContain('上次观测');
});

test('账户内容开关独立控制余额额度重置详细来源与旧值', () => {
  const entry = row(connection({ observation: observation({ resources: [metric(), metric({ id: 'plan', kind: 'quota', scope: 'key', used_percent: 20,
    window_seconds: 3600, reset_at: at })] }) }));
  let root = renderAccountCard(entry, { sections: ['balance'] });
  expect(deepText(root)).toContain('现金余额'); expect(deepText(root)).not.toContain('Key 预算'); expect(root.querySelectorAll('progress')).toHaveLength(0);
  root = renderAccountCard(entry, { sections: ['quota'] });
  expect(deepText(root)).not.toContain('现金余额'); expect(deepText(root)).toContain('Key 预算'); expect(deepText(root)).not.toContain('重置：');
  expect(root.querySelectorAll('progress')).toHaveLength(1);
  root = renderAccountCard(entry, { sections: ['reset'] });
  expect(deepText(root)).toContain('到期待刷新'); expect(deepText(root)).not.toContain('已用 20%'); expect(deepText(root)).not.toContain('剩余');
  root = renderAccountCard(entry, { sections: ['details', 'provenance'] });
  expect(deepText(root)).toContain('模型端点：https://api.deepseek.com'); expect(deepText(root)).toContain('原始已用比例：20 %');
  expect(deepText(root)).toContain('观测来源'); expect(deepText(root)).toContain('范围：API Key 预算');
  expect(root.querySelectorAll('.dashboard-account-metric-details')).toHaveLength(2);
});

test('v2配置保留全部字段，父传双快照无GET，单快照只读缺失资源；v1缺省数组兼容', async () => {
  config = { ...config, version: 2, hidden_projects: ['abcdef0123456789'], layout: [{ id: `account:${ids[0]}`, x: 0, y: 2, w: 4, h: 6 }],
    content: [{ id: `account:${ids[0]}`, sections: [] }] };
  expect(await readDashboardConfig()).toEqual({ ...config, account_view: 'list' }); expect(await loadDashboardConnections()).toEqual(connections);
  requests.length = 0;
  expect(await loadAccountCards({ config, connections })).toHaveLength(2); expect(requests).toHaveLength(0);
  await loadAccountCards({ config }); expect(requests.map(entry => entry.url)).toEqual(['/api/host/settings/agent/connections?scope=device']);
  requests.length = 0; await loadAccountCards({ connections }); expect(requests.map(entry => entry.url)).toEqual(['/api/host/dashboard']);
  config = { version: 1, revision: 'old', cards: [] };
  expect(await readDashboardConfig()).toEqual({ ...config, hidden_projects: [], layout: [], content: [], account_view: 'list' });
});

test('保存ACK传value仅本地校验，保留v2字段且不修改原应答；v1缺省数组仍兼容', async () => {
  const ack = { ...config, version: 2, hidden_projects: ['abcdef0123456789'],
    layout: [{ id: `account:${ids[0]}`, x: 1, y: 2, w: 4, h: 6 }], content: [{ id: `account:${ids[0]}`, sections: [] }] };
  const validated = await readDashboardConfig({ value: ack }); expect(validated).toEqual({ ...ack, account_view: 'list' });
  validated.cards.length = 0; validated.hidden_projects.length = 0; validated.layout[0].x = 9; validated.content[0].sections.push('balance');
  expect(ack.cards).toHaveLength(2); expect(ack.hidden_projects).toHaveLength(1); expect(ack.layout[0].x).toBe(1); expect(ack.content[0].sections).toEqual([]);
  expect(await readDashboardConfig({ value: config })).toEqual({ ...config, hidden_projects: [], layout: [], content: [], account_view: 'list' });
  expect(requests).toHaveLength(0);
});

test('无效保存ACK不偷偷GET或当空配置，v2缺失字段与错误结构拒绝', async () => {
  const valid = { ...config, version: 2, hidden_projects: [], layout: [], content: [] };
  for (const value of [undefined, null, {}, { ...valid, cards: [config.cards[0], config.cards[0]] },
    { ...config, version: 2 }, { ...valid, hidden_projects: ['wrong-id'] },
    { ...valid, layout: [{ id: `account:${ids[0]}`, x: 0, y: 0, w: 0, h: 1 }] },
    { ...valid, content: [{ id: `account:${ids[0]}`, sections: 'quota' }] }]) {
    await expect(readDashboardConfig({ value })).rejects.toThrow('卡片配置响应无效');
  }
  expect(requests).toHaveLength(0);
});

test('父真实v3存储GET与partial保存ACK可由账户接口本地消费，无HTTP二次读取', async () => {
  const { readDashboardSettings, saveDashboardSettings } = await import('../../src/core/dashboard-settings.js');
  const home = fs.mkdtempSync(join(tmpdir(), 'lush-account-v2-ack-'));
  try {
    fs.chmodSync(home, 0o700);
    const device = { home }, initial = readDashboardSettings(device);
    expect(await readDashboardConfig({ value: initial })).toEqual(initial);
    const ack = await saveDashboardSettings(device, { cards: [{ type: 'account', connection_id: ids[0] }],
      hidden_projects: ['abcdef0123456789'], layout: [{ id: `account:${ids[0]}`, x: 0, y: 1, w: 4, h: 8 }],
      content: [{ id: `account:${ids[0]}`, sections: [] }, { id: 'abcdef0123456789', sections: ['messages'] }] }, initial.revision);
    const next = await saveDashboardSettings(device, { cards: config.cards }, ack.revision);
    expect(await readDashboardConfig({ value: next })).toEqual(next);
    expect(next.layout).toEqual(ack.layout); expect(next.content).toEqual(ack.content); expect(next.hidden_projects).toEqual(ack.hidden_projects);
    const rows = await loadAccountCards({ config: next, connections }); expect(rows.map(row => row.connection_id)).toEqual(ids.slice(0, 2));
    expect(requests).toHaveLength(0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('固定父v2契约严格校验12列布局和分类型内容键，拒绝旧project前缀及越界应答', async () => {
  const valid = { ...config, version: 2, hidden_projects: [],
    layout: [{ id: 'abcdef0123456789', x: 11, y: 4095, w: 1, h: 80 }],
    content: [{ id: 'abcdef0123456789', sections: ['metrics', 'messages'] }, { id: `account:${ids[0]}`, sections: ['quota', 'history'] }] };
  expect(await readDashboardConfig({ value: valid })).toEqual({ ...valid, account_view: 'list' });
  const layout = valid.layout[0];
  for (const item of [{ ...layout, id: 'project:abcdef0123456789' }, { ...layout, x: 12 }, { ...layout, y: 4096 },
    { ...layout, x: 0, w: 13 }, { ...layout, w: 2 }, { ...layout, h: 5 }, { ...layout, h: 81 }, { ...layout, extra: true }]) {
    await expect(readDashboardConfig({ value: { ...valid, layout: [item] } })).rejects.toThrow('卡片配置响应无效');
  }
  for (const content of [[{ id: 'abcdef0123456789', sections: ['quota'] }], [{ id: `account:${ids[0]}`, sections: ['messages'] }],
    [{ id: 'invalid', sections: [] }], [valid.content[0], valid.content[0]]]) {
    await expect(readDashboardConfig({ value: { ...valid, content } })).rejects.toThrow('卡片配置响应无效');
  }
  await expect(readDashboardConfig({ value: { ...valid, layout: [layout, layout] } })).rejects.toThrow('卡片配置响应无效');
  expect(requests).toHaveLength(0);
});

test('旧账户选择组件只patch cards与revision，不提交或覆盖v2布局内容项目字段', async () => {
  config = { ...config, version: 2, hidden_projects: ['abcdef0123456789'], layout: [{ id: 'abcdef0123456789', x: 0, y: 0, w: 4, h: 6 }],
    content: [{ id: `account:${ids[0]}`, sections: ['balance'] }] };
  const original = structuredClone(config), panel = await settings(); select(panel.root, ids[1], false);
  await button(panel.root, '保存卡片选择').click();
  expect(Object.keys(JSON.parse(writes()[0].options.body)).sort()).toEqual(['cards', 'expected_revision']);
  for (const key of ['hidden_projects', 'layout', 'content']) expect(config[key]).toEqual(original[key]);
});

test('单卡刷新只回调指定来源、单飞，无页面权限不调用，迟到失败不写旧DOM', async () => {
  const delayed = deferred(), called = [];
  const root = renderAccountCard(row(), { ownsPage: () => current, refresh: async id => { called.push(id); await delayed.promise; throw new Error('late error'); } });
  const refresh = button(root, '刷新'), pending = refresh.click();
  expect(called).toEqual([ids[0]]); expect(refresh.disabled).toBe(true); expect(refresh.parentNode.dataset.help).toContain('尚未完成');
  await refresh.click(); expect(called).toHaveLength(1);
  const before = deepText(root); current = false; delayed.resolve(); await pending;
  expect(deepText(root)).toBe(before); await refresh.click(); expect(called).toHaveLength(1); expect(requests).toHaveLength(0);
});

test('刷新缺失回调、已停用和已删除按钮有可聚焦禁用help-host', async () => {
  for (const entry of [row(), row(connection({ enabled: false })), { id: `account:${ids[0]}`, connection_id: ids[0], connection: null }]) {
    const called = []; const root = renderAccountCard(entry, entry.connection?.enabled === true ? {} : { refresh: async id => called.push(id) });
    const refresh = button(root, '刷新'); expect(refresh.disabled).toBe(true); expect(refresh.parentNode.classList.contains('help-host')).toBe(true);
    expect(refresh.parentNode.dataset.help).toBeTruthy(); expect(refresh.parentNode.getAttribute('tabindex')).toBe('0');
    await refresh.click(); expect(called).toHaveLength(0);
  }
});

test('显式账户刷新仅查去重指定ID，最多3并发；最终独立重读不采用action整份list', async () => {
  const selected = [...ids, ...[4, 5, 6].map(n => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${String(n).repeat(12)}`)];
  connections = selected.map((id, index) => connection({ id, observation: observation({ resources: [metric({ remaining: index + 10 })] }) }));
  const waiting = new Map(), started = []; let active = 0, maxActive = 0;
  intercept = (url, options) => {
    if (url !== '/api/host/settings/action') return;
    const body = JSON.parse(options.body); expect(body.method).toBe('agent.connections.query'); expect(body.params.scope).toBe('device');
    const id = body.params.id; started.push(id); active++; maxActive = Math.max(maxActive, active);
    const pending = deferred(); waiting.set(id, pending);
    return pending.promise.then(() => { active--; return json({ connections: selected.map(id => connection({ id, observation: observation({ resources: [metric({ remaining: 999 })] }) })) }); });
  };
  const pending = refreshAccountCards([selected[0], ...selected]); await new Promise(setImmediate);
  expect(started).toEqual(selected.slice(0, 3));
  waiting.get(selected[2]).resolve(); await new Promise(setImmediate); expect(started).toEqual(selected.slice(0, 4));
  waiting.get(selected[0]).resolve(); waiting.get(selected[1]).resolve(); await new Promise(setImmediate);
  expect(started).toEqual(selected);
  for (const id of selected.slice(3)) waiting.get(id).resolve();
  const result = await pending; expect(maxActive).toBe(3); expect(result.errors).toEqual([]);
  expect(result.connections).toEqual(connections); expect(result.connections[0].observation.resources[0].remaining).toBe(10);
  expect(requests.filter(entry => entry.url.includes('/agent/connections?'))).toHaveLength(1);
  expect(writes()).toHaveLength(6); expect(writes().every(entry => JSON.parse(entry.options.body).params.id)).toBe(true);
});

test('单项拒绝不阻其他刷新，异常/不支持/未配置/部分/未知观测独立报告', async () => {
  for (const status of ['error', 'unsupported', 'unconfigured', 'partial', 'unknown']) {
    requests.length = 0;
    connections = [connection(), connection({ id: ids[1], observation: observation({ status }) }), connection({ id: ids[2] })];
    intercept = (url, options) => {
      if (url !== '/api/host/settings/action') return;
      if (JSON.parse(options.body).params.id === ids[0]) return Promise.reject(new Error('query rejected'));
      return json({ connections });
    };
    const result = await refreshAccountCards(ids); expect(writes()).toHaveLength(3);
    expect(result.connections).toEqual(connections); expect(result.errors.map(entry => entry.id)).toEqual(ids.slice(0, 2));
    expect(result.errors[0].error).toContain('query rejected'); expect(result.errors[1].error).toBeTruthy();
  }
});

test('异常抛出值不泄漏原对象，刷新errors.error始终是安全字符串', async () => {
  intercept = url => url === '/api/host/settings/action' ? Promise.reject({ message: { raw_response: 'private' } }) : undefined;
  const result = await refreshAccountCards([ids[0]]);
  expect(result.errors).toEqual([{ id: ids[0], error: '账户查询失败' }]); expect(writes()).toHaveLength(1);
});

test('刷新查询结果不冒充缓存，独立重读失败明确拒绝、不自动重试', async () => {
  intercept = url => url === '/api/host/settings/action' ? json({ connections }) : url.includes('/agent/connections?') ? fail('cache unavailable') : undefined;
  await expect(refreshAccountCards([ids[0]])).rejects.toThrow('设备账户 / 余额缓存读取失败');
  expect(writes()).toHaveLength(1); expect(requests).toHaveLength(2);
});

test('页面失效不开始排队查询或后读，迟到后读拒绝，不返回旧连接', async () => {
  const selected = [...ids, '44444444-4444-4444-8444-444444444444'], waiting = deferred();
  intercept = url => url === '/api/host/settings/action' ? waiting.promise : undefined;
  const pending = refreshAccountCards(selected, { ownsPage: () => current });
  expect(writes()).toHaveLength(3); current = false; waiting.resolve(json({ connections }));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(requests).toHaveLength(3);
  current = true; requests.length = 0; const delayedRead = deferred();
  intercept = url => url === '/api/host/settings/action' ? json({ connections }) : url.includes('/agent/connections?') ? delayedRead.promise : undefined;
  const reading = refreshAccountCards([ids[0]], { ownsPage: () => current }); await new Promise(setImmediate);
  expect(requests).toHaveLength(2); current = false; delayedRead.resolve(json({ connections,
    configuration_scope: { selected: 'device', source: 'device', project_override: false } }));
  await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
});

test('刷新未拥有页面或错误IDs不请求，无id绝不查询；空列表只读缓存', async () => {
  current = false; await expect(refreshAccountCards(ids, { ownsPage: () => current })).rejects.toMatchObject({ name: 'AbortError' });
  current = true;
  for (const bad of [undefined, null, [''], [ids[0], 'invalid']]) await expect(refreshAccountCards(bad)).rejects.toThrow('必须指定有效来源');
  expect(requests).toHaveLength(0); expect((await refreshAccountCards([])).errors).toEqual([]); expect(writes()).toHaveLength(0);
});

test('独立项目管理不挂载或读取总览设置，设置只属于总览面板', async () => {
  intercept = url => url === '/api/host/projects' ? json({ projects: [] })
    : url === '/api/host' ? json({ mode: 'bound', projects: [], restart_supported: false }) : undefined;
  const { openProjectManager } = await import('../../src/ui/web/assets/project-picker.js');
  await openProjectManager({ push: false }); await new Promise(setImmediate);
  expect(dom.node('detail').dataset.view).toBe('project-management');
  expect(dom.node('detail').querySelector('.dashboard-card-settings')).toBeNull();
  expect(dom.node('detail').querySelector('.dashboard-settings-panel')).toBeNull();
  expect(requests.some(entry => entry.url === '/api/host/dashboard')).toBe(false);
  expect(writes()).toHaveLength(0);
});

test('总览身份变更保护迟到账户配置读取，不将旧来源挂回新页面', async () => {
  const delayed = deferred(); let started;
  const reading = new Promise(resolve => { started = resolve; });
  intercept = url => {
    if (url === '/api/host/projects') return json({ projects: [] });
    if (url === '/api/host/dashboard') { started(); return delayed.promise; }
  };
  const { openProjectOverview } = await import('../../src/ui/web/assets/project-picker.js');
  const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
  const pending = openProjectOverview({ push: false }); await reading;
  const root = dom.node('detail').querySelector('.project-overview'); expect(root).not.toBeNull();
  expect(dom.node('detail').querySelector('.dashboard-settings-panel')).toBeNull();
  const before = deepText(root); activateDetailView({ view: 'settings', push: false });
  dom.node('detail').replaceChildren(); delayed.resolve(json(config)); await pending;
  expect(deepText(root)).toBe(before); expect(root.querySelectorAll('input')).toHaveLength(0);
  expect(dom.node('detail').querySelector('.dashboard-settings-panel')).toBeNull(); expect(writes()).toHaveLength(0);
});

test('全局总览混排项目与账户，提供设置及显式刷新，配色只读且无后台管理/新指令操作', async () => {
  const projectId = 'abcdef0123456789';
  intercept = url => url === '/api/host/projects' ? json({ projects: [{ id: projectId, name: '彩色项目', project: '/tmp/demo', running: false }] })
    : url === `/api/host/projects/${projectId}/appearance` ? json({ id: projectId, appearance: { version: 1, color: 'rose' } })
      : url === '/api/host' ? json({ mode: 'host', projects: [] }) : undefined;
  const { openProjectOverview } = await import('../../src/ui/web/assets/project-picker.js');
  await openProjectOverview({ push: false });
  const panel = dom.node('detail'), board = panel.querySelector('.project-board');
  expect(panel.dataset.view).toBe('projects'); expect(board.children).toHaveLength(2);
  expect(board.querySelector('[data-project-id="abcdef0123456789"]').getAttribute('data-board-color')).toBe('rose');
  expect(board.querySelectorAll('.dashboard-account-card')).toHaveLength(2);
  expect(panel.querySelector('.project-manager-form')).toBeNull(); expect(panel.querySelector('.project-order')).toBeNull();
  expect(panel.querySelector('.workbench-service-restart')).toBeNull(); expect(panel.querySelector('section.dashboard-card-settings')).toBeNull();
  expect(panel.querySelector('.dashboard-settings-open')).not.toBeNull();
  expect(panel.querySelectorAll('.dashboard-card-settings')).toHaveLength(2);
  expect(panel.querySelectorAll('button').some(node => node.textContent === '刷新全部')).toBe(true);
  expect(panel.querySelectorAll('.project-board-handle').every(node => node.hidden && node.disabled)).toBe(true);
  expect(board.querySelector('.project-open').target).toBe('_blank'); expect(writes()).toHaveLength(0);
  expect(requests.filter(entry => entry.url.endsWith('/appearance')).map(entry => entry.url)).toEqual([`/api/host/projects/${projectId}/appearance`]);
});

test('项目列表不可达仍显示已配置账户，不把失败默认为无卡片', async () => {
  intercept = url => url === '/api/host/projects' ? fail('offline') : undefined;
  const { openProjectOverview } = await import('../../src/ui/web/assets/project-picker.js');
  await openProjectOverview({ push: false });
  const panel = dom.node('detail');
  expect(panel.querySelectorAll('.dashboard-account-card')).toHaveLength(2);
  expect(deepText(panel)).toContain('项目状态读取失败'); expect(panel.querySelector('.workbench-empty').hidden).toBe(true);
  expect(writes()).toHaveLength(0);
});

test('总览读取迟到不能替换刚打开的管理页，账户请求不自动重试', async () => {
  const delayed = deferred(); let first = true;
  intercept = url => {
    if (url === '/api/host/projects') return json({ projects: [] });
    if (url === '/api/host/dashboard' && first) { first = false; return delayed.promise; }
  };
  const { openProjectOverview, openProjectManager } = await import('../../src/ui/web/assets/project-picker.js');
  const pending = openProjectOverview({ push: false }); await new Promise(setImmediate);
  await openProjectManager({ push: false });
  delayed.resolve(json(config)); await pending;
  expect(dom.node('detail').dataset.view).toBe('project-management'); expect(dom.node('detail').querySelector('.project-board')).toBeNull();
  expect(writes()).toHaveLength(0);
});

test('源码不引入管理台或浏览器持久化，CSS沿用双主题token并包含320px适用窄屏规则', () => {
  const source = fs.readFileSync(new URL('../../src/ui/web/assets/dashboard-cards.js', import.meta.url), 'utf8');
  expect(source).not.toContain('render-agent-connections'); expect(source).not.toContain('localStorage'); expect(source).not.toContain('.query(');
  const css = fs.readFileSync(new URL('../../src/ui/web/assets/styles-dashboard-cards.css', import.meta.url), 'utf8');
  expect(css).toContain('var(--panel)'); expect(css).toContain('var(--text)'); expect(css).toContain('@media(max-width:640px)');
  expect(css).toContain('min-width:0'); expect(css).toContain('overflow-wrap:anywhere'); expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
});
