import { afterAll, beforeEach, expect, test } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';

let requests, active, response;
const dom = installDom({ fetch: async url => { requests.push(url); if (response !== undefined) return Response.json(response); throw new Error('renderer must not request'); } });
const { readDashboardConfig, loadAccountCards } = await import('../../src/ui/web/assets/dashboard-cards.js');
const { ACCOUNT_GROUP_ID, renderAccountGroup } = await import('../../src/ui/web/assets/dashboard-accounts-group.js');
afterAll(() => dom.restore());
beforeEach(() => { requests = []; active = true; response = undefined; });
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const observation = (extra = {}) => ({ status: 'available', source: 'usage_api', checked_at: '2026-10-01T00:00:00Z', resources: [
  { id: 'short', kind: 'quota', scope: 'account', label: '短窗口', unit: '%', used_percent: 25, remaining: 75, window_seconds: 18000, reset_at: '2020-01-01T00:00:00Z' },
  { id: 'week', kind: 'quota', scope: 'account', label: '周窗口', unit: '%', used_percent: 40, remaining: 60, window_seconds: 604800 },
  { id: 'cash', kind: 'balance', scope: 'account', label: '现金', unit: 'USD', remaining: 10 },
  { id: 'key', kind: 'quota', scope: 'key', label: 'Key消费', unit: 'USD', remaining: 3, total: 10, used: 7 },
  { id: 'unknown', kind: 'quota', scope: 'model', label: '模型额度', unit: 'tokens', remaining: null, used_percent: null },
], ...extra });
const account = (n, extra = {}) => ({ id: `account:${id(n)}`, type: 'account', connection_id: id(n),
  connection: { id: id(n), label: '同名来源', provider: 'openrouter', enabled: true, endpoint: 'https://example.invalid/v1', observation: observation(), ...extra } });
const group = accounts => ({ id: ACCOUNT_GROUP_ID, type: 'accounts', name: '额度与余额', accounts });
const button = (root, className) => root.querySelector(`.${className}`);
const v3 = () => ({ version: 3, revision: 'r3', account_view: 'list', cards: [{ type: 'account', connection_id: id(1) }],
  hidden_projects: ['abcdef0123456789'], layout: [{ id: 'accounts', x: 0, y: 0, w: 8, h: 12 }, { id: `account:${id(1)}`, x: 8, y: 0, w: 4, h: 6 }],
  content: [{ id: 'accounts', sections: ['quota', 'history'] }, { id: `account:${id(1)}`, sections: [] }, { id: 'abcdef0123456789', sections: ['messages'] }] });

test('v3完整规范保留统一窗口及旧逐来源布局内容，list/tiles仅本地校验不写回', async () => {
  for (const mode of ['list', 'tiles']) {
    const value = { ...v3(), account_view: mode }, copy = structuredClone(value);
    expect(await readDashboardConfig({ value })).toEqual({ ...value, diagnostics: true }); expect(value).toEqual(copy);
    const rows = await loadAccountCards({ config: value, connections: [account(1).connection] });
    expect(rows.map(row => row.id)).toEqual([`account:${id(1)}`]); expect(rows[0].connection.label).toBe('同名来源');
  }
  expect(requests).toHaveLength(0);
});

test('父真实v3存储及partial ACK保留tiles群组与逐来源设置，可直接供账户接口消费', async () => {
  const { mkdtempSync, chmodSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readDashboardSettings, saveDashboardSettings } = await import('../../src/core/dashboard-settings.js');
  const home = mkdtempSync(join(tmpdir(), 'lush-account-group-v3-'));
  try {
    chmodSync(home, 0o700);
    const device = { home }, initial = readDashboardSettings(device);
    expect(await readDashboardConfig({ value: initial })).toEqual(initial);
    const { version, revision, ...patch } = { ...v3(), account_view: 'tiles' };
    const ack = await saveDashboardSettings(device, patch, initial.revision);
    expect(await readDashboardConfig({ value: ack })).toEqual(ack);
    const next = await saveDashboardSettings(device, { cards: patch.cards }, ack.revision);
    expect(await readDashboardConfig({ value: next })).toEqual(next);
    for (const key of ['account_view', 'content', 'layout', 'hidden_projects']) expect(next[key]).toEqual(ack[key]);
    expect(await loadAccountCards({ config: next, connections: [account(1).connection] })).toHaveLength(1);
    expect(requests).toHaveLength(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('真实v4完整ACK兼容widgets/null/空面板及来源规范化，重复导航不被前端误拒绝', async () => {
  const { mkdtempSync, chmodSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { readDashboardSettings, saveDashboardSettings } = await import('../../src/core/dashboard-settings.js');
  const { newWidget } = await import('../../src/ui/web/assets/dashboard-widget-model.js');
  const home = mkdtempSync(join(tmpdir(), 'lush-widget-v4-reader-'));
  try {
    chmodSync(home, 0o700); const device = { home }, initial = readDashboardSettings(device);
    expect(initial.version).toBe(5); expect((await readDashboardConfig({ value: initial })).widgets).toBeNull();
    const accountWidget = newWidget('accounts', 'widget:account'); accountWidget.connection_ids = [id(1).toUpperCase()];
    const links = newWidget('shortcuts', 'widget:links'); links.links = Array.from({ length: 2 }, () => ({ scope: 'global', target: 'settings', project_id: null }));
    const ack = await saveDashboardSettings(device, { widgets: [accountWidget, links], layout: [{ id: accountWidget.id, x: 0, y: 0, w: 6, h: 14 }] }, initial.revision);
    expect(await readDashboardConfig({ value: ack })).toEqual(ack); expect(ack.widgets[1].links).toHaveLength(2);
    const empty = await saveDashboardSettings(device, { widgets: [] }, ack.revision); expect((await readDashboardConfig({ value: empty })).widgets).toEqual([]);
    await expect(readDashboardConfig({ value: { ...ack, content: [{ id: accountWidget.id, sections: [] }] } })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('真实网格接收accounts群组，内层不套网格控件且不读项目配色，编辑只作用于外窗', async () => {
  const { createProjectBoard } = await import('../../src/ui/web/assets/project-board.js');
  const board = createProjectBoard({ renderCard: row => renderAccountGroup(row), request: async () => { throw new Error('unexpected appearance'); } });
  await board.update([group([account(1), account(2)])], { layout: v3().layout });
  expect(board.root.children).toHaveLength(1);
  const window = board.root.children[0];
  expect(window.dataset.projectId).toBe('accounts');
  expect(board.getLayout()).toEqual([v3().layout[0]]);
  expect(window.querySelector('.project-board-content').querySelectorAll('.dashboard-account-card')).toHaveLength(2);
  expect(window.querySelectorAll('.project-board-handle')).toHaveLength(1);
  expect(window.querySelectorAll('.project-board-resize')).toHaveLength(2);
  for (const row of window.querySelectorAll('.dashboard-account-card')) expect(row.querySelectorAll('.project-board-handle,.project-board-resize')).toHaveLength(0);
  board.setEditing(true); expect(window.querySelector('.project-board-handle').disabled).toBe(false);
  board.setEditing(false); expect(window.querySelector('.project-board-handle').disabled).toBe(true);
  expect(requests).toHaveLength(0);
});

test('真实GET通道读取v3模式及旧v1/v2默认，仅读取配置而不写回', async () => {
  const current = v3();
  for (const version of [1, 2, 3]) {
    response = version === 1 ? { version, revision: 'legacy', cards: current.cards }
      : { ...current, version, account_view: version === 3 ? 'tiles' : undefined };
    const config = await readDashboardConfig(); expect(config.account_view).toBe(version === 3 ? 'tiles' : 'list');
    expect(config.cards).toEqual(current.cards);
  }
  expect(requests).toEqual(['/api/host/dashboard', '/api/host/dashboard', '/api/host/dashboard']);
});

test('v1/v2兼容返回默认list，旧内容与布局不丢失且不初始化设置', async () => {
  const value = v3(), { account_view, ...old } = value;
  expect(await readDashboardConfig({ value: { ...old, version: 2 } })).toEqual({ ...old, version: 2, account_view: 'list', diagnostics: true });
  const v1 = { version: 1, revision: 'old', cards: value.cards };
  expect(await readDashboardConfig({ value: v1 })).toEqual({ ...v1, account_view: 'list', layout: [], content: [], hidden_projects: [], diagnostics: true });
  expect(requests).toHaveLength(0);
});

test('v3拒绝缺失字段、错误模式和accounts项目内容键；失败不GET', async () => {
  const good = v3();
  for (const mode of [undefined, null, '', 'tabs', 'LIST', 1, {}]) await expect(readDashboardConfig({ value: { ...good, account_view: mode } })).rejects.toThrow('卡片配置响应无效');
  for (const key of ['cards', 'hidden_projects', 'layout', 'content', 'revision']) {
    const value = { ...good }; delete value[key]; await expect(readDashboardConfig({ value })).rejects.toThrow('卡片配置响应无效');
  }
  await expect(readDashboardConfig({ value: { ...good, content: [{ id: 'accounts', sections: ['messages'] }] } })).rejects.toThrow('卡片配置响应无效');
  await expect(readDashboardConfig({ value: { ...good, layout: [{ id: 'accounts', x: 11, y: 0, w: 2, h: 6 }] } })).rejects.toThrow('卡片配置响应无效');
  expect(requests).toHaveLength(0);
});

for (const mode of ['list', 'tiles']) test(`${mode}同名来源仍独立，多窗口现金Key预算及未知比例完整，不混合或添加内层控件`, () => {
  const root = renderAccountGroup(group([account(1), account(2)]), { mode, refresh: async () => {}, refreshAll: async () => {} });
  expect(root.tagName).toBe('LI'); expect(root.classList.contains('project-item')).toBe(true);
  expect(root.dataset.cardId).toBe('accounts'); expect(root.dataset.accountView).toBe(mode);
  expect(root.querySelectorAll('.dashboard-account-card').map(row => row.dataset.connectionId)).toEqual([id(1), id(2)]);
  expect(root.querySelectorAll('.dashboard-account-metric')).toHaveLength(10); expect(root.querySelectorAll('progress')).toHaveLength(6);
  const text = deepText(root);
  for (const phrase of ['5h', '25%', '7d', '40%', '现金余额', '10 USD', 'Key 预算', '3 USD', '模型额度', '未知 tokens', '比例未知', '到期待刷新']) expect(text).toContain(phrase);
  for (const phrase of ['观测成功', '模型端点', '合计', '总余额', '短窗口', '周窗口', '上次观测', '小时窗口', '剩余 未知 %']) expect(text).not.toContain(phrase);
  expect(root.querySelectorAll('.dashboard-account-identity').map(node => node.querySelector('.dashboard-account-age')).filter(Boolean)).toHaveLength(2);
  expect(root.querySelectorAll('.dashboard-account-metric')[0].getAttribute('aria-label')).toContain('短窗口');
  for (const selector of ['.project-board-handle', '.project-board-resize', '.dashboard-card-settings', '.agent-call']) expect(root.querySelectorAll(selector)).toHaveLength(0);
  expect(root.querySelectorAll('.dashboard-account-content')).toHaveLength(2); expect(requests).toHaveLength(0);
});

for (const mode of ['list', 'tiles']) test(`${mode}未知失败部分停用删除及历史保持原账户口径，不用旧值冒充当前`, () => {
  const accounts = [account(1, { observation: observation({ status: 'unknown', source: 'none' }) }),
    account(2, { observation: observation({ status: 'error' }), last_success: { checked_at: '2026-01-01T00:00:00Z', observation: observation() } }),
    account(3, { observation: observation({ status: 'partial' }) }), account(4, { enabled: false }), { ...account(5), connection: null }];
  const root = renderAccountGroup(group(accounts), { mode, sections: ['quota', 'balance', 'observed', 'history'], refresh: async () => {}, refreshAll: async () => {} });
  const rows = root.querySelectorAll('.dashboard-account-card');
  expect(deepText(rows[0])).toContain('未知不等于零'); expect(deepText(rows[0])).toContain('尚无观测'); expect(rows[0].querySelectorAll('.dashboard-account-metric')).toHaveLength(0);
  expect(deepText(rows[1])).toContain('查询失败'); expect(deepText(rows[1])).toContain('历史成功观测（非当前值）');
  const current = rows[1].querySelector('.dashboard-account-observation'); expect(current.querySelectorAll('.dashboard-account-metric')).toHaveLength(0);
  expect(rows[1].querySelector('.dashboard-account-old').open).not.toBe(true);
  expect(deepText(rows[2])).toContain('部分指标可用'); expect(deepText(rows[3])).toContain('来源已停用'); expect(deepText(rows[4])).toContain('已删除或不可用');
  for (const row of rows.slice(3)) { const refresh = button(row, 'dashboard-account-refresh'); expect(refresh.disabled).toBe(true); expect(refresh.parentNode.dataset.help).toBeTruthy(); }
  expect(requests).toHaveLength(0);
});

test('逐来源sections优先，undefined回退群组设置；空数组仅留名称异常刷新，旧来源差异仍独立', () => {
  const root = renderAccountGroup(group([account(1), account(2), account(3)]), { sections: ['balance'],
    sectionsForAccount: row => row.connection_id === id(1) ? [] : row.connection_id === id(2) ? ['quota'] : undefined });
  const rows = root.querySelectorAll('.dashboard-account-card');
  expect(rows[0].querySelectorAll('.dashboard-account-metric')).toHaveLength(0);
  expect(rows[1].querySelectorAll('.dashboard-account-metric')).toHaveLength(4); expect(deepText(rows[1])).not.toContain('现金余额');
  expect(rows[2].querySelectorAll('.dashboard-account-metric')).toHaveLength(1); expect(deepText(rows[2])).toContain('现金余额');
  const defaults = renderAccountGroup(group([account(1)])); expect(defaults.querySelectorAll('.dashboard-account-metric')).toHaveLength(5);
});

test('100来源边界不丢条目及指标；超过100配置拒绝而非截断', async () => {
  const accounts = Array.from({ length: 100 }, (_, i) => account(i + 1));
  const value = { ...v3(), cards: accounts.map(row => ({ type: 'account', connection_id: row.connection_id })) };
  const rows = await loadAccountCards({ config: value, connections: accounts.map(row => row.connection) });
  for (const mode of ['list', 'tiles']) {
    const root = renderAccountGroup(group(rows), { mode }); expect(root.querySelectorAll('.dashboard-account-card')).toHaveLength(100);
    expect(root.querySelectorAll('.dashboard-account-metric')).toHaveLength(500);
    expect(root.querySelectorAll('.dashboard-account-card').at(-1).dataset.connectionId).toBe(id(100));
  }
  await expect(readDashboardConfig({ value: { ...value, cards: [...value.cards, { type: 'account', connection_id: id(101) }] } })).rejects.toThrow('卡片配置响应无效');
  expect(requests).toHaveLength(0);
});

test('单项仅回调指定来源，全组仅回调父refreshAll且不把未选择来源传入，不自行联网', async () => {
  const refreshed = [], all = [];
  const root = renderAccountGroup(group([account(1), account(3)]), { refresh: async id => refreshed.push(id), refreshAll: async (...args) => all.push(args) });
  await button(root.querySelectorAll('.dashboard-account-card')[1], 'dashboard-account-refresh').click();
  await button(root, 'dashboard-accounts-refresh').click();
  expect(button(root, 'dashboard-accounts-refresh').dataset.help).toContain('已选择');
  expect(refreshed).toEqual([id(3)]); expect(all).toEqual([[]]); expect(requests).toHaveLength(0);
});

test('无回调空组或全部停用删除时禁用全组刷新，help-host可聚焦；单项无回调也禁用', async () => {
  for (const [accounts, refreshAll] of [[[], async () => {}], [[account(1, { enabled: false }), { ...account(2), connection: null }], async () => {}], [[account(1)], undefined]]) {
    const root = renderAccountGroup(group(accounts), { refreshAll }); const refresh = button(root, 'dashboard-accounts-refresh');
    expect(refresh.disabled).toBe(true); expect(refresh.parentNode.classList.contains('help-host')).toBe(true);
    expect(refresh.parentNode.getAttribute('tabindex')).toBe('0'); expect(refresh.parentNode.dataset.help).toBeTruthy();
    await refresh.click();
    for (const account of root.querySelectorAll('.dashboard-account-card')) expect(button(account, 'dashboard-account-refresh').disabled).toBe(true);
  }
  expect(deepText(renderAccountGroup(group([])))).toContain('未选择账户来源'); expect(requests).toHaveLength(0);
});

test('全组刷新单飞，页面失效不启动或更新迟到错误与按钮；每来源同样保护', async () => {
  let resolve, calls = 0; const delayed = new Promise(done => { resolve = done; });
  const root = renderAccountGroup(group([account(1)]), { ownsPage: () => active, refreshAll: async () => { calls++; await delayed; throw new Error('late error'); } });
  const refresh = button(root, 'dashboard-accounts-refresh'), pending = refresh.click();
  expect(refresh.disabled).toBe(true); await refresh.click(); expect(calls).toBe(1);
  const before = deepText(root); active = false; resolve(); await pending;
  expect(deepText(root)).toBe(before); await refresh.click(); expect(calls).toBe(1);
  let single = 0;
  const stale = renderAccountGroup(group([account(1)]), { ownsPage: () => active, refresh: async () => single++, refreshAll: async () => single++ });
  await button(stale, 'dashboard-account-refresh').click(); await button(stale, 'dashboard-accounts-refresh').click(); expect(single).toBe(0); expect(requests).toHaveLength(0);
});

test('失败回调在当前组明确提示，账户错误对象不转成原始响应文本；模式兜底不创建tabs', async () => {
  const root = renderAccountGroup(group([account(1)]), { mode: 'invalid', refreshAll: async () => { throw new Error('safe failure'); }, refresh: async () => { throw { response: 'private' }; } });
  await button(root, 'dashboard-accounts-refresh').click(); expect(deepText(root)).toContain('safe failure');
  await button(root, 'dashboard-account-refresh').click(); expect(deepText(root)).toContain('账户刷新失败'); expect(deepText(root)).not.toContain('private');
  expect(root.dataset.accountView).toBe('list'); expect(root.querySelectorAll('[role="tab"]')).toHaveLength(0);
});
