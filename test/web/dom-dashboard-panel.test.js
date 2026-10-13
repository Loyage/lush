import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
const P = 'aaaaaaaaaaaaaaaa', Q = 'bbbbbbbbbbbbbbbb', A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
let config, projects, connections, requests, intercept, serial, current, panel, failPaint;
const clone = value => structuredClone(value), scope = { selected: 'device', source: 'device', project_override: false };
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null; requests.push({ path, body, method: options.method || 'GET' });
  const blocked = intercept?.(path, options, body); if (blocked) return blocked;
  if (path === '/api/host/projects') return Response.json({ projects });
  if (/^\/api\/host\/projects\/[a-f0-9]{16}\/appearance$/.test(path)) return Response.json({ id: path.split('/')[4], appearance: { version: 1, color: 'rose' } });
  if (path === '/api/host/dashboard') {
    if (options.method === 'POST') {
      if (body.expected_revision !== config.revision) return Response.json({ error: 'revision changed' }, { status: 409 });
      const { expected_revision, ...patch } = body;
      config = { account_view: 'list', hidden_projects: [], content: [], layout: [], ...config, widgets: config.widgets ?? null, diagnostics: config.diagnostics ?? true, ...clone(patch), version: 5, revision: `r${++serial}` };
    }
    return Response.json(clone(config));
  }
  if (path === '/api/host/settings/agent/connections?scope=device') return Response.json({ connections, configuration_scope: scope });
  if (path === '/api/host/settings/action') return Response.json({ connections, configuration_scope: scope });
  if (path.includes('/api/notices?')) return Response.json({ notices: [], total: 0, has_more: false });
  if (path.includes('/api/workers?')) return Response.json({ tasks: [], has_more: false });
  return Response.json({ error: path }, { status: 404 });
} });
afterAll(() => { panel?.dispose(); dom.restore(); });
const { createDashboardPanel } = await import('../../src/ui/web/assets/dashboard-panel.js');
const { newWidget } = await import('../../src/ui/web/assets/dashboard-widget-model.js');
const { AGGREGATE_SIZES, aggregateAccountIds, aggregateLinks } = await import('../../src/ui/web/assets/dashboard-widget-aggregate-model.js');
const { closeDialog, formDialog } = await import('../../src/ui/web/assets/dialog.js');
const { requestPageLeave } = await import('../../src/ui/web/assets/page-leave-guard.js');
const { workspaceLink } = await import('../../src/ui/web/assets/workspace-shell.js');
const { el } = await import('../../src/ui/web/assets/dom.js');
function createBoard({ renderCard, onLayoutChange, onGeometryChange }) {
  const root = el('ul', undefined, 'project-board'); let layout = [], currentRows = [];
  root.changeGeometry = (id, h) => {
    const geometry = layout.find(cell => cell.id === id); geometry.h = h;
    const row = currentRows.find(row => row.id === id), item = root.querySelector(`[data-card-id="${id}"]`);
    onGeometryChange?.(row, { ...geometry }, item);
  };
  return { root, getLayout: () => clone(layout), setEditing(value) { root.classList.toggle('project-board-editing', value); },
    async update(rows, { layout: saved } = {}) {
      if (failPaint) throw new Error('paint failed');
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
const input = data => dom.node('modal').querySelectorAll('input').find(node => Object.entries(data).every(([key, value]) => node.dataset[key] === value));
const change = (node, checked) => { node.checked = checked; node.onchange(); };
const writes = () => requests.filter(row => row.method === 'POST');
const settingsWrites = () => writes().filter(row => row.path === '/api/host/dashboard');
const widgets = () => dom.node('detail').querySelectorAll('.dashboard-widget');
const card = id => widgets().find(node => node.dataset.cardId === id);
const draft = () => panel.state().config;
const click = label => button(label).onclick();
const apply = () => click('应用到草稿');
const save = () => click('保存更改');
const move = () => dom.node('detail').querySelector('.project-board-handle').onkeydown({ key: 'ArrowDown' });
async function open(real = false) { panel?.dispose(); panel = createDashboardPanel({ ownsPage: () => current, ...(real ? {} : { createBoard }) }); dom.node('detail').replaceChildren(panel.root); await panel.ready(); return panel; }
async function settings() { await dom.node('detail').querySelector('.dashboard-settings-open').onclick(); }
async function cardSettings(id = P) { await card(id).querySelector('.dashboard-card-settings').onclick(); }
async function reread() { const pending = click('重新读取设置'); await click('丢弃并重新读取'); await pending; }
const status = () => newWidget('status', 'widget:status', P);
const account = (id = A, name = 'widget:accounts') => ({ ...newWidget('accounts', name), connection_ids: [id] });
beforeEach(() => {
  panel?.dispose(); closeDialog(); dom.node('detail').replaceChildren(); requests = []; intercept = null; serial = 0; current = true; failPaint = false;
  config = { version: 5, diagnostics: false, revision: 'initial', widgets: null, account_view: 'list', cards: [{ type: 'account', connection_id: A }], hidden_projects: [], layout: [], content: [] };
  projects = [{ id: P, name: '项目A', project: '/fixture/a', running: true }, { id: Q, name: '项目B', running: false }];
  connections = [A, B].map(id => ({ id, label: id, enabled: true, observation: { status: 'available', resources: [] } }));
});
const diagnosticsSnapshot = () => ({ version: 1, generated_at: '2026-10-12T12:00:00Z', currency: 'USD', estimated: true,
  windows: [60, 300].map(seconds => ({ seconds, input: 600, output: 60, cost: 0.1, requests: 1, input_per_second: 10, output_per_second: 1, cost_per_minute: 0.1, unknown_tokens: 0, unknown_cost: 0, complete: true })),
  buckets: Array.from({ length: 60 }, () => ({ at: '2026-10-12T12:00:00Z', input: 10, output: 1, cost: 0.01, unknown_tokens: 0, unknown_cost: 0 })),
  coverage: { projects_total: 1, projects_online: 1, projects_reporting: 1, complete: true }, projects: [{ id: P, name: '项目A', state: 'online', generated_at: '2026-10-12T12:00:00Z' }] });

test('view is compact/read-only; edit exposes every settings button with keyboard help, no provider/start/model calls', async () => {
  const before = clone(config); await open();
  expect(widgets().map(node => node.dataset.cardId)).toEqual([P, Q, 'accounts']);
  expect(card(P).querySelector('.project-open').href).toBe(`/p/${P}/`);
  expect(config).toEqual(before); expect(writes()).toHaveLength(0);
  expect(requests.some(row => row.path.startsWith(`/p/${Q}/api/`))).toBe(false);
  expect(button('添加卡片').hidden).toBe(true); expect(button('编辑模式').hidden).toBe(false);
  expect(card(P).querySelector('.dashboard-card-settings-host').hidden).toBe(true);
  await click('编辑模式');
  for (const row of widgets()) {
    expect(row.querySelector('.dashboard-card-settings-host').hidden).toBe(false);
    expect(row.querySelector('.dashboard-card-settings').dataset.help).toContain('草稿');
    expect(row.querySelector('.dashboard-card-settings').getAttribute('aria-haspopup')).toBe('dialog');
  }
  expect(button('添加卡片').hidden).toBe(false); expect(button('编辑模式').hidden).toBe(true);
  expect(deepText(panel.root)).toContain('尚无更改'); expect(panel.root.querySelector('.agent-call')).toBeNull();
});

test('full edit workflow applies all changes to one draft, saves one revision partial patch and exits', async () => {
  const before = clone(config); await open(); await click('编辑模式');
  await cardSettings(); change(input({ section: 'metrics' }), false); change(input({ linkTarget: 'notices' }), true); await apply();
  await cardSettings('accounts'); change(input({ connectionId: B }), true); await apply();
  await cardSettings(Q); change(input({ removeCard: Q }), true); await apply();
  await click('添加卡片'); change(input({ libraryId: 'widget:diagnostics' }), true); await apply();
  move();
  expect(settingsWrites()).toHaveLength(0); expect(config).toEqual(before); expect(panel.state().dirty).toBe(true);
  expect(card(Q)).toBeUndefined(); expect(card('widget:diagnostics')).toBeDefined();
  expect(aggregateAccountIds(draft())).toEqual([A, B]); expect(draft().revision).toBe('initial');
  const expected = clone(draft()); await save();
  expect(settingsWrites()).toHaveLength(1); expect(settingsWrites()[0].body.expected_revision).toBe('initial');
  expect(settingsWrites()[0].body).not.toHaveProperty('account_view');
  expect(config.widgets).toEqual(expected.widgets); expect(config.layout).toEqual(expected.layout);
  expect(config.content).toEqual(expected.content); expect(panel.state().editing).toBe(false); expect(panel.state().dirty).toBe(false);
});

test('form cancel does not apply; page cancel restores all confirmed fields including navigation/membership/geometry', async () => {
  await open(); const before = clone(draft()); await cardSettings(); change(input({ section: 'metrics' }), false); await click('取消');
  expect(draft()).toEqual(before); expect(panel.state().dirty).toBe(false);
  await settings(); change(input({ projectId: Q }), false); change(input({ connectionId: B }), true); change(input({ linkTarget: 'docs', linkScope: 'global' }), true); await apply(); move();
  expect(panel.state().dirty).toBe(true); await click('取消编辑');
  expect(draft()).toEqual(before); expect(config).toEqual(before); expect(settingsWrites()).toHaveLength(0); expect(panel.state().editing).toBe(false);
});

test('searchable library exposes registered projects/one quota/diagnostics with existing status and no duplicates; form cancel is local', async () => {
  await open(); await click('编辑模式'); await click('添加卡片');
  for (const id of [P, Q, 'accounts']) { expect(input({ libraryId: id }).disabled).toBe(true); expect(input({ libraryId: id }).checked).toBe(true); }
  const search = dom.node('modal').querySelector('.dashboard-library-search'); search.value = '运行';
  search.onkeydown({ key: 'Enter', isComposing: true }); expect(dom.node('modal').querySelector(`[data-library-id="${P}"]`).hidden).toBe(false);
  await click('搜索'); expect(dom.node('modal').querySelector(`[data-library-id="${P}"]`).hidden).toBe(true);
  expect(dom.node('modal').querySelector('[data-library-id="widget:diagnostics"]').hidden).toBe(false);
  search.value = 'missing'; await click('搜索'); expect(deepText(dom.node('modal'))).toContain('没有匹配'); await click('清空');
  change(input({ libraryId: 'widget:diagnostics' }), true); await click('取消'); expect(draft().diagnostics).toBe(false);
  await click('添加卡片'); change(input({ libraryId: 'widget:diagnostics' }), true); await apply();
  await click('添加卡片'); expect(input({ libraryId: 'widget:diagnostics' }).disabled).toBe(true); await apply();
  expect(widgets().map(row => row.dataset.cardId)).toEqual([P, Q, 'accounts', 'widget:diagnostics']); expect(settingsWrites()).toHaveLength(0);
});

test('empty explicit panel has actionable library; new online project content loads before save; remove and re-add all card types', async () => {
  config.widgets = []; await open(); expect(widgets()).toHaveLength(0);
  await click('添加第一张卡片'); for (const id of [P, 'accounts', 'widget:diagnostics']) change(input({ libraryId: id }), true); await apply();
  expect(widgets()).toHaveLength(3); expect(requests.some(row => row.path.startsWith(`/p/${P}/api/notices?`))).toBe(true);
  expect(requests.some(row => row.path.startsWith(`/p/${P}/api/workers?`))).toBe(true);
  for (const id of [P, 'accounts', 'widget:diagnostics']) { await cardSettings(id); change(input({ removeCard: id }), true); await apply(); }
  expect(widgets()).toHaveLength(0);
  await click('添加卡片'); for (const id of [P, 'accounts', 'widget:diagnostics']) change(input({ libraryId: id }), true); await apply();
  expect(widgets()).toHaveLength(3); await cardSettings('accounts'); change(input({ connectionId: B }), true); await apply();
  expect(aggregateAccountIds(draft())).toEqual([B]); expect(settingsWrites()).toHaveLength(0); await save(); expect(settingsWrites()).toHaveLength(1);
});

test('undo/redo includes content, source membership, removal, navigation and geometry; branching drops redo', async () => {
  await open(); await click('编辑模式'); const initial = clone(draft());
  await cardSettings(); change(input({ section: 'metrics' }), false); await apply(); const content = clone(draft());
  await cardSettings(Q); change(input({ removeCard: Q }), true); await apply(); const removed = clone(draft());
  move(); const moved = clone(draft());
  await click('撤销'); expect(draft()).toEqual(removed); await click('撤销'); expect(draft()).toEqual(content); expect(card(Q)).toBeDefined();
  await click('撤销'); expect(draft()).toEqual(initial); expect(button('撤销').disabled).toBe(true); expect(panel.state().dirty).toBe(false);
  await click('重做'); await click('重做'); await click('重做'); expect(draft()).toEqual(moved); expect(button('重做').disabled).toBe(true);
  await click('撤销'); await settings(); change(input({ linkTarget: 'settings', linkScope: 'global' }), true); await apply();
  expect(button('重做').disabled).toBe(true); expect(aggregateLinks(draft()).some(link => link.target === 'settings')).toBe(true); expect(settingsWrites()).toHaveLength(0);
});

test('reset explicitly confirms only visible aggregate geometry, retains legacy members/config, can undo and cancel', async () => {
  config.widgets = [status(), account()]; config.layout = [{ id: P, x: 2, y: 9, w: 4, h: 10 }, { id: 'widget:status', x: 1, y: 70, w: 4, h: 12 }];
  const before = clone(config); await open(); await click('编辑模式');
  let pending = click('恢复默认布局'); expect(deepText(dom.node('modal'))).toContain('来源、内容、导航和旧成员布局保留'); await click('取消'); await pending;
  expect(draft()).toEqual(before);
  pending = click('恢复默认布局'); await click('恢复布局'); await pending;
  expect(draft().layout).toContainEqual({ id: P, x: 0, y: 0, w: 6, h: 24 }); expect(draft().layout).toContainEqual(before.layout[1]); expect(draft().widgets).toEqual(before.widgets);
  await click('撤销'); expect(draft()).toEqual(before); await click('重做'); await save();
  expect(Object.keys(settingsWrites()[0].body).sort()).toEqual(['expected_revision', 'layout']);
});

test('v1-v4 content/source-only editing preserves null widgets and raw legacy fields, no-op or pure layout never materializes', async () => {
  for (const version of [1, 2, 3, 4]) {
    config = version === 1 ? { version, revision: 'legacy', cards: [] } : { version, revision: 'legacy', cards: [], widgets: null, account_view: 'tiles', hidden_projects: [], content: [], layout: [{ id: `account:${A}`, x: 1, y: 1, w: 2, h: 6 }] };
    if (version < 4) delete config.widgets;
    await open(); await cardSettings(); change(input({ section: 'metrics' }), false); await apply();
    await settings(); change(input({ projectId: Q }), false); await apply(); expect(settingsWrites().at(-1)?.body.expected_revision).not.toBe('legacy');
    await save(); expect(config.widgets).toBeNull(); expect(config.hidden_projects).toContain(Q); expect(config.content.find(row => row.id === P).sections).not.toContain('metrics');
    expect(settingsWrites().at(-1).body).not.toHaveProperty('widgets');
    const before = clone(config); await click('编辑模式'); await save(); expect(config.layout).toEqual(before.layout); expect(settingsWrites().at(-1).body).not.toHaveProperty('layout');
    await click('编辑模式'); move(); await save(); expect(config.widgets).toBeNull(); expect(settingsWrites().at(-1).body).not.toHaveProperty('widgets');
    for (const cell of before.layout) expect(config.layout).toContainEqual(cell);
  }
});

test('explicit v4 unchanged/toggle-back retains empty sections, custom links and every original member', async () => {
  const s = status(), empty = { ...s, id: 'widget:empty', sections: [] }, a = account(), b = { ...account(B, 'widget:b'), sections: [] };
  const nav = newWidget('shortcuts', 'widget:navigation'); nav.links = [{ scope: 'project', target: 'notices', project_id: P }, { scope: 'global', target: 'docs', project_id: null }];
  config.widgets = [s, empty, a, b, nav]; const before = clone(config); await open(); await cardSettings();
  change(input({ section: 'metrics' }), false); change(input({ section: 'metrics' }), true); change(input({ linkTarget: 'notices' }), false); change(input({ linkTarget: 'notices' }), true); await apply();
  await settings(); change(input({ projectId: P }), false); change(input({ projectId: P }), true); change(input({ connectionId: B }), false); change(input({ connectionId: B }), true); await apply();
  expect(draft()).toEqual(before); await save(); expect(settingsWrites().at(-1).body).toEqual({ account_view: 'list', expected_revision: 'initial' });
  expect(config.widgets).toEqual(before.widgets);
});

test('explicit project/source/section edits preserve unrelated raw members and independent legacy arrays', async () => {
  const q = newWidget('workers', 'widget:q', Q), disabled = { ...status(), id: 'widget:disabled', sections: [] }; config.widgets = [status(), disabled, q, account()]; const before = clone(config);
  await open(); await cardSettings(); change(input({ section: 'metrics' }), false); await apply();
  expect(draft().widgets[0].sections).not.toContain('metrics'); expect(draft().widgets[1].sections).toEqual([]); expect(draft().widgets.slice(2)).toEqual(before.widgets.slice(2));
  await cardSettings('accounts'); change(input({ connectionId: B }), true); await apply(); expect(aggregateAccountIds(draft())).toEqual([A, B]);
  await cardSettings(Q); change(input({ removeCard: Q }), true); await apply(); await save(); expect(config.widgets.some(row => row.project_id === Q)).toBe(false);
  for (const key of ['cards', 'content', 'hidden_projects', 'layout']) expect(config[key]).toEqual(before[key]);
});

test('global/project navigation draft is visible before save; enabling one chosen project target adds no implicit defaults', async () => {
  config.widgets = [{ ...status(), sections: [] }]; await open(); await cardSettings();
  change(input({ section: 'shortcuts' }), true); change(input({ linkTarget: 'workers' }), true); await apply();
  expect(aggregateLinks(draft(), P).map(row => row.target)).toEqual(['workers']);
  await settings(); change(input({ linkTarget: 'docs', linkScope: 'global' }), true); await apply();
  expect(panel.root.querySelector('.dashboard-global-direct-links').querySelector('a').href).toBe('/#docs');
  expect(settingsWrites()).toHaveLength(0); await save(); expect(aggregateLinks(config).map(row => row.target)).toEqual(['docs']);
});

test('over-limit materialized drafts remain editable and unsent; reducing membership permits one final save', async () => {
  projects = Array.from({ length: 26 }, (_, i) => ({ id: i.toString(16).padStart(16, '0'), name: `P${i}`, running: false })); config.cards = [];
  await open(); await settings(); change(input({ linkTarget: 'settings', linkScope: 'global' }), true); await apply();
  expect(draft().widgets.length).toBeGreaterThan(100); await save(); expect(settingsWrites()).toHaveLength(0); expect(button('保存更改').disabled).toBe(false);
  expect(deepText(panel.root)).toContain('选择原样保留'); expect(config.widgets).toBeNull();
  await settings(); for (const row of projects.slice(0, 3)) change(input({ projectId: row.id }), false); await apply(); await save();
  expect(config.widgets.length).toBeLessThanOrEqual(100); expect(config.widgets.filter(row => row.project_id)).toHaveLength(69);
  for (const row of projects.slice(3)) expect(aggregateLinks(config, row.id)).toHaveLength(3);
});

test('page save validation/POST is single-flight; in-flight cancel/refresh/form/leave cannot discard the draft', async () => {
  await open(); await cardSettings(); change(input({ section: 'metrics' }), false); await apply(); move(); const before = clone(draft());
  let release; intercept = (path, options) => path === '/api/host/dashboard' && options.method === 'POST' ? new Promise(resolve => { release = resolve; }) : null;
  const pending = save(); await save(); await click('取消编辑'); await click('刷新全部'); await cardSettings();
  expect(await requestPageLeave('#settings')).toBe(false); expect(draft()).toEqual(before); expect(settingsWrites()).toHaveLength(1);
  release(Response.json({ ...before, revision: 'saved' })); await pending; expect(panel.state().editing).toBe(false); expect(draft().revision).toBe('saved');
});

test('revision conflict retains full draft/history and locks writes; refresh keeps original revision; explicit reread failure retains and success replaces', async () => {
  await open(); await cardSettings(); change(input({ section: 'metrics' }), false); await apply(); move(); const before = clone(draft());
  config.revision = 'external'; await click('刷新全部'); expect(draft()).toEqual(before); await save();
  expect(panel.state().failedWrite).toBe(true); expect(button('保存更改').disabled).toBe(true); expect(draft()).toEqual(before);
  await save(); expect(settingsWrites()).toHaveLength(1); await click('撤销'); expect(draft().content).toEqual(before.content); await click('重做'); expect(draft()).toEqual(before);
  intercept = path => path === '/api/host/dashboard' ? Response.json({ error: 'read failed' }, { status: 503 }) : null;
  await reread(); expect(draft()).toEqual(before); expect(deepText(panel.root)).toContain('原编辑已保留');
  intercept = null; await reread(); expect(draft()).toEqual(config); expect(draft().revision).toBe('external'); expect(panel.state().failedWrite).toBe(false); expect(panel.state().editing).toBe(false);
});

test('malformed/legacy ACK is unknown, not success; complete ACK with paint failure is saved and never retried', async () => {
  await open(); await cardSettings(); change(input({ section: 'metrics' }), false); await apply(); const before = clone(draft());
  intercept = (path, options) => path === '/api/host/dashboard' && options.method === 'POST' ? Response.json({ ...config, version: 3, revision: 'wrong' }) : null;
  await save(); expect(panel.state().failedWrite).toBe(true); expect(draft()).toEqual(before);
  intercept = null; await reread(); await cardSettings(); change(input({ section: 'metrics' }), false); await apply();
  failPaint = true; await save(); expect(panel.state().failedWrite).toBe(false); expect(panel.state().editing).toBe(false); expect(panel.state().dirty).toBe(false);
  expect(deepText(panel.root)).toContain('设置已保存；展示更新失败'); const count = settingsWrites().length;
  failPaint = false; await click('刷新全部'); expect(settingsWrites()).toHaveLength(count);
});

test('late ACK after disposal cannot mutate old config, close replacement dialog or take focus', async () => {
  await open(); await cardSettings(); change(input({ section: 'metrics' }), false); await apply(); let release; const before = clone(draft());
  intercept = (path, options) => path === '/api/host/dashboard' && options.method === 'POST' ? new Promise(resolve => { release = resolve; }) : null;
  const pending = save(); await Promise.resolve(); expect(typeof release).toBe('function'); current = false; panel.dispose(); dom.node('detail').replaceChildren();
  void formDialog({ title: '新弹窗', content: el('div', 'new') }); const focus = dom.document.activeElement;
  release(Response.json({ ...config, widgets: [], revision: 'late' })); await pending;
  expect(deepText(dom.node('modal'))).toContain('新弹窗'); expect(dom.document.activeElement).toBe(focus); expect(draft()).toEqual(before);
});

test('refresh while modal open preserves form, full draft and revision; application stays local until page save conflicts', async () => {
  await open(); await settings(); const source = input({ projectId: Q }); change(source, false); config.revision = 'external'; await panel.refresh();
  expect(source.checked).toBe(false); expect(dom.node('modal').hidden).toBe(false); expect(draft().revision).toBe('initial'); await apply(); expect(settingsWrites()).toHaveLength(0);
  await save(); expect(settingsWrites().at(-1).body.expected_revision).toBe('initial'); expect(panel.state().failedWrite).toBe(true);
});

test('same-tab navigation warns dirty page, cancellation preserves it; open form blocks replacement and unload warns then disposes', async () => {
  await open(); await cardSettings(); change(input({ section: 'metrics' }), false);
  expect(await requestPageLeave('#settings')).toBe(false); expect(input({ section: 'metrics' }).checked).toBe(false);
  let prevented = false; await dom.fire('beforeunload', { preventDefault() { prevented = true; } }); expect(prevented).toBe(true);
  await apply(); let opened = 0; workspaceLink('settings-open', '#settings', () => { opened++; });
  let pending = dom.node('settings-open').onclick(); await click('取消'); await pending; expect(opened).toBe(0); expect(panel.state().dirty).toBe(true);
  pending = dom.node('settings-open').onclick(); await click('丢弃并离开'); await pending; expect(opened).toBe(1);
  panel.dispose(); prevented = false; await dom.fire('beforeunload', { preventDefault() { prevented = true; } }); expect(prevented).toBe(false);
  expect(await requestPageLeave('#settings')).toBe(true);
});

test('diagnostics legacy default, per-card removal/re-add and auto reads leave original widgets untouched', async () => {
  config = { ...config, version: 4 }; delete config.diagnostics;
  intercept = path => path === '/api/host/diagnostics' ? Response.json(diagnosticsSnapshot()) : null;
  await open(); expect(card('widget:diagnostics')).toBeDefined(); expect(requests.filter(row => row.path === '/api/host/diagnostics')).toHaveLength(1);
  await cardSettings('widget:diagnostics'); expect(deepText(dom.node('modal'))).toContain('60 / 300'); change(input({ removeCard: 'widget:diagnostics' }), true); await apply();
  expect(card('widget:diagnostics')).toBeUndefined(); expect(settingsWrites()).toHaveLength(0); await save();
  expect(settingsWrites()[0].body).toEqual({ diagnostics: false, expected_revision: 'initial' }); expect(config.widgets).toBeNull();
  await click('编辑模式'); await click('添加卡片'); change(input({ libraryId: 'widget:diagnostics' }), true); await apply();
  expect(card('widget:diagnostics')).toBeDefined(); await save(); expect(config.widgets).toBeNull(); expect(settingsWrites().at(-1).body).not.toHaveProperty('layout');
});

test('independent diagnostic refresh retains layout/form draft, card node and focus, never queries providers', async () => {
  config.diagnostics = true; intercept = path => path === '/api/host/diagnostics' ? Response.json(diagnosticsSnapshot()) : null;
  await open(); await click('编辑模式'); move(); const diagnostics = card('widget:diagnostics'), refresh = diagnostics.querySelector('.dashboard-diagnostics-refresh'); requests = [];
  refresh.focus(); await refresh.onclick(); expect(panel.state().editing).toBe(true); expect(panel.state().layoutDirty).toBe(true); expect(draft().revision).toBe('initial');
  expect(card('widget:diagnostics')).toBe(diagnostics); expect(dom.document.activeElement).toBe(refresh); expect(requests.map(row => row.path)).toEqual(['/api/host/diagnostics']);
  await settings(); const selected = input({ diagnostics: 'enabled' }); change(selected, false); await refresh.onclick(); expect(selected.checked).toBe(false); expect(draft().diagnostics).toBe(true);
});

test('refresh queries only selected grouped accounts; empty quotas/disabled sources cannot query other accounts', async () => {
  config.widgets = [account(B)]; await open(); expect(writes()).toHaveLength(0); requests = [];
  await click('刷新全部'); expect(writes().map(row => row.body.params.id)).toEqual([B]); expect(writes()[0].body.method).toBe('agent.connections.query'); expect(requests.some(row => /start|select/.test(row.path))).toBe(false);
  requests = []; await panel.refresh([A]); expect(writes()).toHaveLength(0);
  config.widgets = [{ ...account(), connection_ids: [] }]; await open(); expect(dom.node('detail').querySelector('.dashboard-accounts-refresh').disabled).toBe(true);
});

test('geometry callbacks keep fixed card shell/pagination and accessible overflow; real board retains appearance/identity and canonical layout', async () => {
  await open(); const p = card(P), quota = card('accounts'), footer = p.querySelector('.dashboard-widget-pagination');
  expect(p.querySelectorAll('.dashboard-widget-slot')).toHaveLength(3); expect(p.querySelectorAll('.dashboard-widget-message')).toHaveLength(2);
  const grid = dom.node('detail').querySelector('.project-board'); grid.changeGeometry(P, 10); await p.dashboardReady();
  expect(card(P)).toBe(p); expect(p.querySelectorAll('.dashboard-widget-slot')).toHaveLength(0); expect(p.querySelector('.dashboard-widget-pagination')).toBe(footer);
  await p.querySelector('.dashboard-project-details').onclick(); expect(dom.node('modal').querySelector('.project-development')).not.toBeNull(); await click('关闭');
  grid.changeGeometry('accounts', 10); expect(card('accounts')).toBe(quota); expect(quota.querySelectorAll('.dashboard-widget-slot')).toHaveLength(1);
  config.widgets = [status(), account(A), account(B, 'widget:second')]; config.layout = [{ id: P, x: 0, y: 0, w: 6, h: 24 }]; await open(true);
  expect(card(P).dataset.boardId).toBe(P); expect(card(P).dataset.projectId).toBe(P); expect(card(P).dataset.boardColor).toBe('rose');
  await cardSettings(); await apply(); expect(dom.document.activeElement).toBe(card(P)); const realQuota = card('accounts'), resize = realQuota.querySelector('.project-board-resize');
  for (let i = 0; i < 6; i++) resize.onkeydown({ key: 'ArrowUp', preventDefault() {} });
  expect(card('accounts')).toBe(realQuota); expect(realQuota.querySelectorAll('.dashboard-widget-slot')).toHaveLength(1); expect(realQuota.querySelectorAll('.dashboard-widget-pagination')).toHaveLength(1);
  expect(settingsWrites()).toHaveLength(0); await save(); expect(settingsWrites().at(-1).body).not.toHaveProperty('widgets');
});

test('responsive display/refresh never writes desktop geometry, legacy minimums or empty widget membership', async () => {
  config.layout = [{ id: P, x: 6, y: 2, w: 2, h: 6 }]; const before = clone(config);
  await open(true); panel.root.querySelector('.project-board').getBoundingClientRect = () => ({ width: 390 });
  await click('编辑模式'); await panel.refresh(); expect(draft()).toEqual(before); expect(panel.state().dirty).toBe(false); await save();
  expect(config.layout).toEqual(before.layout); expect(config.widgets).toBeNull(); expect(settingsWrites()[0].body).not.toHaveProperty('layout');
  config.widgets = []; config.diagnostics = false; await open(true); await click('编辑模式'); await save();
  expect(config.widgets).toEqual([]); expect(settingsWrites().at(-1).body).not.toHaveProperty('widgets');
});

test('replacing a settings modal during apply does not close replacement or steal its focus', async () => {
  await open(); await cardSettings(); change(input({ section: 'metrics' }), false);
  const pending = apply(); void formDialog({ title: '替换弹窗', content: el('div', 'new') }); const focus = dom.document.activeElement;
  await pending; expect(deepText(dom.node('modal'))).toContain('替换弹窗'); expect(dom.document.activeElement).toBe(focus); expect(panel.state().dirty).toBe(true);
});

test('configuration read failure remains unconfirmed and cannot open a writable false empty panel', async () => {
  intercept = path => path === '/api/host/dashboard' ? Response.json({ error: 'missing config' }, { status: 503 }) : null;
  await open(); expect(draft()).toBeNull(); expect(writes()).toHaveLength(0); expect(deepText(panel.root)).toContain('卡片配置读取失败'); expect(button('编辑模式').disabled).toBe(true);
});
