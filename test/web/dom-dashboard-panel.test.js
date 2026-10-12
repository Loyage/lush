import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
const P = 'aaaaaaaaaaaaaaaa', Q = 'bbbbbbbbbbbbbbbb', A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
let config, projects, connections, requests, intercept, serial, current, panel;
const clone = value => structuredClone(value), scope = { selected: 'device', source: 'device', project_override: false };
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null; requests.push({ path, body, method: options.method || 'GET' });
  const blocked = intercept?.(path, options, body); if (blocked) return blocked;
  if (path === '/api/host/projects') return Response.json({ projects });
  if (/^\/api\/host\/projects\/[a-f0-9]{16}\/appearance$/.test(path)) return Response.json({ id: path.split('/')[4], appearance: { version: 1, color: 'rose' } });
  if (path === '/api/host/dashboard') {
    if (options.method === 'POST') { if (body.expected_revision !== config.revision) return Response.json({ error: 'revision changed' }, { status: 409 }); const { expected_revision, ...patch } = body; config = { account_view: 'list', hidden_projects: [], content: [], layout: [], ...config, widgets: config.widgets ?? null, ...clone(patch), version: 4, revision: `r${++serial}` }; }
    return Response.json(clone(config));
  }
  if (path === '/api/host/settings/agent/connections?scope=device') return Response.json({ connections, configuration_scope: scope });
  if (path === '/api/host/settings/action') return Response.json({ connections, configuration_scope: scope });
  if (path.includes('/api/notices?')) return Response.json({ notices: [], total: 0, has_more: false });
  if (path.includes('/api/workers?')) return Response.json({ tasks: [], has_more: false });
  return Response.json({ error: path }, { status: 404 });
} });
afterAll(() => dom.restore());
const { createDashboardPanel } = await import('../../src/ui/web/assets/dashboard-panel.js');
const { newWidget } = await import('../../src/ui/web/assets/dashboard-widget-model.js');
const { AGGREGATE_SIZES, aggregateAccountIds, aggregateLinks } = await import('../../src/ui/web/assets/dashboard-widget-aggregate-model.js');
const { closeDialog, formDialog } = await import('../../src/ui/web/assets/dialog.js');
const { el } = await import('../../src/ui/web/assets/dom.js');
// Parent W234-3 owns real shell CSS/defaults. This stub verifies the agreed 6x24/6x16 contract.
function createBoard({ renderCard, onLayoutChange, onGeometryChange }) {
  const root = el('ul', undefined, 'project-board'); let layout = [], currentRows = [];
  root.changeGeometry = (id, h) => {
    const geometry = layout.find(cell => cell.id === id); geometry.h = h;
    const row = currentRows.find(row => row.id === id), item = root.querySelector(`[data-card-id="${id}"]`);
    onGeometryChange?.(row, { ...geometry }, item);
  };
  return { root, getLayout: () => clone(layout), setEditing(value) { root.classList.toggle('project-board-editing', value); },
    async update(rows, { layout: saved } = {}) {
      currentRows = rows;
      layout = rows.map((row, i) => ({ id: row.id, x: 0, y: i * 24, ...AGGREGATE_SIZES[row.type], ...saved?.find(cell => cell.id === row.id) }));
      root.replaceChildren(...rows.map(row => {
        const geometry = layout.find(cell => cell.id === row.id), item = renderCard({ ...row, geometry }, { geometry }); item.classList.add('project-board-card'); item.dataset.boardId = row.id;
        if (row.project_id) item.dataset.projectId = row.project_id;
        const content = el('div', undefined, 'project-board-content');
        for (const child of [...item.childNodes]) { child.remove(); content.append(child); } item.append(content);
        const handle = el('button', 'move', 'project-board-handle'); handle.onkeydown = event => { if (event.key === 'ArrowDown') { geometry.y++; onLayoutChange(clone(layout)); } }; item.append(handle); return item;
      }));
    } };
}
const button = label => [...dom.node('modal').querySelectorAll('button'), ...dom.node('detail').querySelectorAll('button')].find(node => node.textContent === label);
const inputs = () => dom.node('modal').querySelectorAll('input');
const input = data => inputs().find(node => Object.entries(data).every(([key, value]) => node.dataset[key] === value));
const change = (node, checked) => { node.checked = checked; node.onchange(); };
const writes = () => requests.filter(row => row.method === 'POST');
const widgets = () => dom.node('detail').querySelectorAll('.dashboard-widget');
const card = id => widgets().find(node => node.dataset.cardId === id);
async function open(real = false) { panel = createDashboardPanel({ ownsPage: () => current, ...(real ? {} : { createBoard }) }); dom.node('detail').replaceChildren(panel.root); await panel.ready(); return panel; }
async function settings() { await dom.node('detail').querySelector('.dashboard-settings-open').onclick(); }
async function cardSettings(id = P) { await card(id).querySelector('.dashboard-card-settings').onclick(); }
const status = () => newWidget('status', 'widget:status', P);
const account = (id = A, name = 'widget:accounts') => ({ ...newWidget('accounts', name), connection_ids: [id] });
beforeEach(() => {
  closeDialog(); dom.node('detail').replaceChildren(); requests = []; intercept = null; serial = 0; current = true;
  config = { version: 4, revision: 'initial', widgets: null, account_view: 'list', cards: [{ type: 'account', connection_id: A }], hidden_projects: [], layout: [], content: [] };
  projects = [{ id: P, name: '项目A', project: '/fixture/a', running: true }, { id: Q, name: '项目B', running: false }];
  connections = [A, B].map(id => ({ id, label: id, enabled: true, observation: { status: 'available', resources: [] } }));
});
test('legacy read-only entry restores one project card per source and one quota window; [] is genuinely empty', async () => {
  const before = clone(config); await open();
  expect(widgets().map(node => node.dataset.cardId)).toEqual([P, Q, 'accounts']); expect(widgets().map(node => node.dataset.widgetType)).toEqual(['project', 'project', 'accounts']);
  expect(deepText(card(P))).not.toContain('· 项目状态'); expect(card(P).querySelector('.project-open').href).toBe(`/p/${P}/`);
  expect(config).toEqual(before); expect(writes()).toHaveLength(0); expect(dom.node('detail').querySelector('.project-order')).toBeNull();
  expect(requests.some(row => row.path.startsWith(`/p/${Q}/api/`))).toBe(false);
  await settings(); expect(dom.node('modal').querySelector('.dashboard-widget-type')).toBeNull(); expect(button('添加卡片')).toBeUndefined(); await button('取消').onclick();
  config.widgets = []; await open(); expect(widgets()).toHaveLength(0); expect(dom.node('detail').querySelector('.workbench-empty').hidden).toBe(false); expect(dom.node('detail').querySelector('.dashboard-navigation-open').hidden).toBe(true);
});
test('v1-v4 legacy source/content edits remain legacy, no implicit migration even on explicit layout save', async () => {
  for (const version of [1, 2, 3, 4]) {
    config = version === 1 ? { version, revision: 'legacy', cards: [] } : { ...config, version, widgets: null, hidden_projects: [], content: [], cards: [] };
    if (version < 4) delete config.widgets;
    await open(); await cardSettings(); change(input({ section: 'metrics' }), false); await button('保存').onclick();
    expect(config.widgets).toBeNull(); expect(config.content.find(row => row.id === P).sections).not.toContain('metrics');
    await settings(); change(input({ projectId: Q }), false); await button('保存').onclick(); expect(config.hidden_projects).toContain(Q);
    await button('编辑布局').onclick(); await button('保存布局').onclick(); expect(config.widgets).toBeNull(); expect(writes().at(-1).body).not.toHaveProperty('widgets');
  }
});
test('nonempty v4 projects/accounts aggregate, unchanged and toggle-back saves preserve every member/empty section/custom link', async () => {
  const s = status(), empty = { ...s, id: 'widget:empty', sections: [] }, a = account(), b = { ...account(B, 'widget:b'), sections: [] };
  const nav = newWidget('shortcuts', 'widget:navigation'); nav.links = [{ scope: 'project', target: 'notices', project_id: P }, { scope: 'global', target: 'docs', project_id: null }];
  config.widgets = [s, empty, a, b, nav]; const before = clone(config); await open(); await cardSettings();
  change(input({ section: 'metrics' }), false); change(input({ section: 'metrics' }), true);
  change(input({ linkTarget: 'notices' }), false); change(input({ linkTarget: 'notices' }), true); await button('保存').onclick();
  expect(config.widgets).toEqual(before.widgets); expect(writes().at(-1).body).not.toHaveProperty('widgets');
  await settings(); change(input({ projectId: P }), false); change(input({ projectId: P }), true); change(input({ connectionId: B }), false); change(input({ connectionId: B }), true); await button('保存').onclick();
  expect(config.widgets).toEqual(before.widgets); expect(widgets()).toHaveLength(2);
  for (const key of ['cards', 'content', 'layout', 'hidden_projects']) expect(config[key]).toEqual(before[key]);
});
test('project source selection edits only same-source members; content edits and account source selection preserve unrelated cards', async () => {
  const q = newWidget('workers', 'widget:q', Q), disabled = { ...status(), id: 'widget:disabled', sections: [] }; config.widgets = [status(), disabled, q, account()]; const before = clone(config);
  await open(); await cardSettings(); change(input({ section: 'metrics' }), false); await button('保存').onclick();
  expect(config.widgets[0].sections).not.toContain('metrics'); expect(config.widgets[1].sections).toEqual([]); expect(config.widgets.slice(2)).toEqual(before.widgets.slice(2));
  await cardSettings('accounts'); change(input({ connectionId: B }), true); await button('保存').onclick(); expect(aggregateAccountIds(config)).toEqual([A, B]);
  await settings(); change(input({ projectId: Q }), false); await button('保存').onclick(); expect(config.widgets.some(row => row.project_id === Q)).toBe(false);
  for (const key of ['cards', 'content', 'hidden_projects', 'layout']) expect(config[key]).toEqual(before[key]);
});
test('global/project navigation is optional and modal-only, while explicit changes preserve custom/unrelated links and revision', async () => {
  const nav = newWidget('shortcuts', 'widget:nav'); nav.links = [{ scope: 'project', target: 'versions', project_id: P }, { scope: 'global', target: 'docs', project_id: null }]; config.widgets = [status(), nav];
  await open(); const root = panel.root, count = widgets().length; await dom.node('detail').querySelector('.dashboard-navigation-open').onclick();
  expect(dom.node('modal').querySelector('a').href).toBe('/#docs'); expect(widgets()).toHaveLength(count); await button('关闭').onclick();
  await card(P).querySelector('.dashboard-project-details').onclick(); expect(dom.node('modal').querySelector('.dashboard-navigation-menu').querySelector('a').href).toBe(`/p/${P}/#versions`); await button('关闭').onclick();
  await cardSettings(); change(input({ linkTarget: 'workers' }), true); await button('保存').onclick(); expect(aggregateLinks(config, P).map(row => row.target)).toEqual(['versions', 'workers']); expect(aggregateLinks(config).map(row => row.target)).toEqual(['docs']);
  await settings(); change(input({ linkTarget: 'settings', linkScope: 'global' }), true); await button('保存').onclick(); expect(aggregateLinks(config).map(row => row.target)).toEqual(['docs', 'settings']);
  expect(root.querySelector('.agent-call')).toBeNull(); expect(writes().every(row => row.path === '/api/host/dashboard')).toBe(true);
});
test('enabling project navigation with one chosen target does not silently add other default targets', async () => {
  config.widgets = [{ ...status(), sections: [] }]; await open(); await cardSettings();
  change(input({ section: 'shortcuts' }), true); change(input({ linkTarget: 'workers' }), true); await button('保存').onclick();
  expect(aggregateLinks(config, P).map(item => item.target)).toEqual(['workers']);
});
test('legacy navigation materialization is explicit, does not cap project links at 24, and over-limit drafts remain editable', async () => {
  projects = Array.from({ length: 26 }, (_, i) => ({ id: i.toString(16).padStart(16, '0'), name: `P${i}`, running: false })); config.cards = [];
  await open(); await settings(); change(input({ linkTarget: 'settings', linkScope: 'global' }), true); await button('保存').onclick();
  expect(writes()).toHaveLength(0); expect(config.widgets).toBeNull(); expect(button('保存').disabled).toBe(false); expect(input({ linkTarget: 'settings' }).checked).toBe(true); expect(deepText(dom.node('modal'))).toContain('选择原样保留');
  for (const row of projects.slice(0, 3)) change(input({ projectId: row.id }), false); await button('保存').onclick();
  expect(config.widgets.length).toBeLessThanOrEqual(100); expect(config.widgets.filter(row => row.project_id)).toHaveLength(69);
  for (const row of projects.slice(3)) expect(aggregateLinks(config, row.id)).toHaveLength(3);
  expect(aggregateLinks(config).map(row => row.target)).toEqual(['notices', 'project-management', 'model-sources', 'settings']);
});
test('layout-only saves retain original widgets including []/null and independent geometry; cancellation and failures keep state', async () => {
  for (const original of [null, [], [status()]]) {
    config.widgets = clone(original); config.layout = [{ id: 'widget:status', x: 2, y: 8, w: 4, h: 10 }]; await open();
    const before = clone(config); await button('编辑布局').onclick(); if (widgets().length) dom.node('detail').querySelector('.project-board-handle').onkeydown({ key: 'ArrowDown' }); await button('取消布局').onclick();
    expect(config.widgets).toEqual(original); await button('编辑布局').onclick(); await button('保存布局').onclick();
    expect(config.widgets).toEqual(original); expect(writes().at(-1).body).not.toHaveProperty('widgets'); expect(config.layout).toContainEqual(before.layout[0]);
  }
  await button('编辑布局').onclick(); intercept = path => path === '/api/host/dashboard' ? Response.json({ error: 'revision conflict' }, { status: 409 }) : null;
  await button('保存布局').onclick(); expect(panel.state().editing).toBe(true); expect(panel.state().failedWrite).toBe(true); expect(button('保存布局').disabled).toBe(true);
});
test('modal single-flight/close protection and failed ACK/reread retain exact content and source draft', async () => {
  await open(); await cardSettings(); const control = input({ section: 'metrics' }); change(control, false);
  let release; intercept = (path, options) => path === '/api/host/dashboard' && options.method === 'POST' ? new Promise(resolve => { release = resolve; }) : null;
  const pending = button('保存').onclick(); await button('保存').onclick(); await button('取消').onclick(); dom.node('modal').onkeydown({ key: 'Escape', preventDefault() {} }); expect(dom.node('modal').hidden).toBe(false); expect(writes()).toHaveLength(1);
  release(Response.json({ error: 'revision changed' }, { status: 409 })); await pending; expect(control.checked).toBe(false); expect(dom.node('modal').hidden).toBe(false); expect(button('保存').disabled).toBe(true);
  intercept = path => path === '/api/host/dashboard' ? Response.json({ error: 'read failed' }, { status: 503 }) : null;
  await button('重新读取设置').onclick(); expect(control.checked).toBe(false); expect(deepText(dom.node('modal'))).toContain('原编辑已保留');
});
test('layout saves are single-flight even through asynchronous local validation', async () => {
  await open(); await button('编辑布局').onclick(); let release;
  intercept = (path, options) => path === '/api/host/dashboard' && options.method === 'POST' ? new Promise(resolve => { release = resolve; }) : null;
  const pending = button('保存布局').onclick(); await button('保存布局').onclick(); await Promise.resolve(); expect(writes()).toHaveLength(1);
  release(Response.json({ ...config, revision: 'saved' })); await pending;
});
test('a save requires complete v4 ACK; a legacy ACK is unconfirmed and never clears draft', async () => {
  await open(); await settings(); intercept = (path, options) => path === '/api/host/dashboard' && options.method === 'POST' ? Response.json({ ...config, version: 3, revision: 'wrong' }) : null;
  await button('保存').onclick(); expect(panel.state().failedWrite).toBe(true); expect(dom.node('modal').hidden).toBe(false); expect(panel.state().config.revision).toBe('initial');
});
test('refresh uses only grouped selected account sources, independent of old cards, entry never queries providers', async () => {
  config.widgets = [account(B)]; await open(); expect(writes()).toHaveLength(0); requests = [];
  await button('刷新全部').onclick(); expect(writes().map(row => row.body.params.id)).toEqual([B]); expect(writes()[0].body.method).toBe('agent.connections.query'); expect(requests.some(row => /start|select/.test(row.path))).toBe(false);
  requests = []; await panel.refresh([A]); expect(writes()).toHaveLength(0);
});
test('navigation before validation/late ACK cannot write or close replacement modal or take focus', async () => {
  await open(); await settings(); let release;
  intercept = (path, options) => path === '/api/host/dashboard' && options.method === 'POST' ? new Promise(resolve => { release = resolve; }) : null;
  const pending = button('保存').onclick(); await Promise.resolve(); expect(typeof release).toBe('function'); current = false; dom.node('detail').replaceChildren(); void formDialog({ title: '新弹窗', content: el('div', 'new') });
  release(Response.json({ ...config, widgets: [], revision: 'late' })); await pending; expect(deepText(dom.node('modal'))).toContain('新弹窗'); expect(panel.state().config.revision).toBe('initial');
});
test('geometry callbacks preserve project/account LI, worker source anchor and one footer; selected overflow is accessible via details', async () => {
  await open(); const p = card(P), accountCard = card('accounts'), projectFooter = p.querySelector('.dashboard-widget-pagination');
  expect(p.querySelectorAll('.dashboard-widget-slot')).toHaveLength(3); expect(p.querySelectorAll('.dashboard-widget-message')).toHaveLength(2);
  const grid = dom.node('detail').querySelector('.project-board'); grid.changeGeometry(P, 10); await p.dashboardReady();
  expect(card(P)).toBe(p); expect(p.querySelectorAll('.dashboard-widget-slot')).toHaveLength(0); expect(p.querySelectorAll('.dashboard-widget-message')).toHaveLength(2);
  expect(p.querySelector('.project-development-metrics')).toBeNull(); expect(p.querySelector('.dashboard-widget-pagination')).toBe(projectFooter);
  await p.querySelector('.dashboard-project-details').onclick(); expect(dom.node('modal').querySelector('.project-development')).not.toBeNull(); expect(dom.node('modal').querySelector('a[href]')).not.toBeNull(); await button('关闭').onclick();
  grid.changeGeometry('accounts', 10); expect(card('accounts')).toBe(accountCard); expect(accountCard.querySelectorAll('.dashboard-widget-slot')).toHaveLength(1);
  expect(accountCard.querySelectorAll('.dashboard-widget-pagination')).toHaveLength(1); expect(writes()).toHaveLength(0);
});
test('real board uses original project appearance/identity, modal focus restores grouped card and account resize retains shell', async () => {
  config.widgets = [status(), account(A), account(B, 'widget:second')]; config.layout = [{ id: P, x: 0, y: 0, w: 6, h: 24 }]; await open(true);
  const project = card(P); expect(project.dataset.boardId).toBe(P); expect(project.dataset.projectId).toBe(P); expect(project.dataset.boardColor).toBe('rose');
  expect(requests.filter(row => row.path.endsWith('/appearance')).every(row => row.path.includes(P) && !row.path.includes('widget:'))).toBe(true);
  await cardSettings(); await button('保存').onclick(); expect(dom.document.activeElement).toBe(card(P));
  const quota = card('accounts'); await button('编辑布局').onclick(); const resize = quota.querySelector('.project-board-resize');
  for (let i = 0; i < 6; i++) resize.onkeydown({ key: 'ArrowUp', preventDefault() {} });
  expect(card('accounts')).toBe(quota); expect(quota.querySelectorAll('.dashboard-widget-slot')).toHaveLength(1); expect(quota.querySelectorAll('.dashboard-widget-pagination')).toHaveLength(1);
});
test('one unified quota group refreshes all its selected members; empty quota cannot query other accounts', async () => {
  config.widgets = [{ ...account(), connection_ids: [] }, account(B, 'widget:selected')]; await open();
  const groups = dom.node('detail').querySelectorAll('.dashboard-accounts-refresh'); expect(groups).toHaveLength(1); expect(groups[0].disabled).toBe(false); requests = [];
  await groups[0].onclick(); expect(writes().map(row => row.body.params.id)).toEqual([B]);
  config.widgets = [{ ...account(), connection_ids: [] }]; await open(); expect(dom.node('detail').querySelector('.dashboard-accounts-refresh').disabled).toBe(true);
});
test('configuration read failure stays unconfirmed, never creates or writes a false empty panel', async () => {
  intercept = path => path === '/api/host/dashboard' ? Response.json({ error: 'missing config' }, { status: 503 }) : null;
  await open(); expect(panel.state().config).toBeNull(); expect(writes()).toHaveLength(0); expect(deepText(dom.node('detail'))).toContain('卡片配置读取失败'); expect(dom.node('detail').querySelector('.dashboard-settings-open').disabled).toBe(true);
});
test('refresh while modal open preserves original revision and choices; external changes conflict rather than overwrite', async () => {
  await open(); await settings(); const source = input({ projectId: Q }); change(source, false); config.revision = 'external'; await panel.refresh();
  expect(source.checked).toBe(false); await button('保存').onclick(); expect(writes().at(-1).body.expected_revision).toBe('initial'); expect(panel.state().failedWrite).toBe(true);
});
