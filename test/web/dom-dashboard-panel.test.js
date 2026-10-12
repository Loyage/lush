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
    if (options.method === 'POST') { if (body.expected_revision !== config.revision) return Response.json({ error: 'revision changed' }, { status: 409 }); const { expected_revision, ...patch } = body; config = { ...config, ...clone(patch), version: 4, revision: `r${++serial}` }; }
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
const { newWidget, WIDGET_SIZES } = await import('../../src/ui/web/assets/dashboard-widget-model.js');
const { closeDialog, formDialog } = await import('../../src/ui/web/assets/dialog.js');
const { el } = await import('../../src/ui/web/assets/dom.js');
// Isolate this child's content/revision responsibility from the parallel grid implementation.
// Real grid/appearance/CSP/320px integration is verified by W234 after both deliveries.
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
      layout = rows.map((row, i) => ({ id: row.id, x: 0, y: i * 16, ...WIDGET_SIZES[row.type], ...saved?.find(cell => cell.id === row.id) }));
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
const change = (node, checked) => { node.checked = checked; node.onchange(); };
const writes = () => requests.filter(row => row.method === 'POST');
async function open(real = false) { panel = createDashboardPanel({ ownsPage: () => current, ...(real ? {} : { createBoard }) }); dom.node('detail').replaceChildren(panel.root); await panel.ready(); return panel; }
async function settings() { await dom.node('detail').querySelector('.dashboard-settings-open').onclick(); }
const widgets = () => dom.node('detail').querySelectorAll('.dashboard-widget');
beforeEach(() => {
  closeDialog(); dom.node('detail').replaceChildren(); requests = []; intercept = null; serial = 0; current = true;
  config = { version: 4, revision: 'initial', widgets: null, account_view: 'list', cards: [{ type: 'account', connection_id: A }], hidden_projects: [], layout: [], content: [] };
  projects = [{ id: P, name: '项目A', project: '/fixture/a', running: true }, { id: Q, name: '项目B', running: false }];
  connections = [A, B].map(id => ({ id, label: id, enabled: true, observation: { status: 'available', resources: [] } }));
});
test('entry is read-only; legacy projection independent status/messages/workers/accounts/shortcuts, true [] empty', async () => {
  await open(); expect(widgets()).toHaveLength(8); expect(widgets().map(node => node.dataset.widgetType)).toEqual(['status', 'messages', 'workers', 'status', 'messages', 'workers', 'accounts', 'shortcuts']);
  expect(writes()).toHaveLength(0); expect(config.widgets).toBeNull(); expect(dom.node('detail').querySelector('.project-order')).toBeNull();
  expect(requests.some(row => row.path.startsWith(`/p/${Q}/api/`))).toBe(false);
  config.widgets = []; await open(); expect(widgets()).toHaveLength(0); expect(dom.node('detail').querySelector('.workbench-empty').hidden).toBe(false);
});
test('add same-type cards/source selection then remove/edit; complete widget save keeps old fields and stable geometry', async () => {
  config.widgets = [newWidget('status', 'widget:old', P)];
  config.layout = [{ id: P, x: 0, y: 0, w: 6, h: 16 }]; config.content = [{ id: P, sections: ['recent'] }];
  const legacy = clone(config); await open(); await settings();
  const type = dom.node('modal').querySelector('.dashboard-widget-type'); type.value = 'messages'; type.onchange();
  const source = dom.node('modal').querySelector('.dashboard-widget-add-project'); source.value = Q; source.onchange();
  await button('添加卡片').onclick(); await button('添加卡片').onclick(); await button('保存').onclick();
  expect(config.widgets.map(row => row.type)).toEqual(['status', 'messages', 'messages']); expect(config.widgets.slice(1).every(row => row.project_id === Q)).toBe(true);
  for (const field of ['cards', 'content', 'hidden_projects', 'account_view']) expect(config[field]).toEqual(legacy[field]); expect(config.layout.find(row => row.id === P)).toEqual(legacy.layout[0]);
  expect(writes()[0].body.expected_revision).toBe('initial'); expect(config.layout.some(row => row.id === 'widget:old')).toBe(true);
  const ids = config.widgets.map(row => row.id); await open(); expect(widgets().map(node => node.dataset.cardId)).toEqual(ids);
  await widgets()[1].querySelector('.dashboard-card-settings').onclick(); change(inputs().find(node => node.dataset.section === 'messages'), false); await button('保存').onclick(); expect(config.widgets[1].sections).toEqual([]); expect(config.content).toEqual(legacy.content);
  await widgets()[1].querySelector('.dashboard-card-settings').onclick(); await button('移除卡片').onclick(); await button('保存').onclick(); expect(config.widgets).toHaveLength(2);
});
test('account and shortcut selection writes widgets only, real project/global links selected without agent or maintenance actions', async () => {
  const accounts = newWidget('accounts', 'widget:accounts'); accounts.connection_ids = [A]; const links = newWidget('shortcuts', 'widget:links'); config.widgets = [accounts, links];
  await open(); await widgets()[0].querySelector('.dashboard-card-settings').onclick(); change(inputs().find(node => node.dataset.connectionId === B), true); await button('保存').onclick(); expect(config.widgets[0].connection_ids).toEqual([A, B]); expect(config.cards).toEqual([{ type: 'account', connection_id: A }]);
  await widgets()[1].querySelector('.dashboard-card-settings').onclick(); change(inputs().find(node => node.dataset.linkScope === 'global' && node.dataset.linkTarget === 'settings'), true); change(inputs().find(node => node.dataset.linkScope === 'project' && node.dataset.linkTarget === 'workers' && node.dataset.projectId === Q), true); await button('保存').onclick();
  expect(config.widgets[1].links).toEqual([{ scope: 'global', target: 'settings', project_id: null }, { scope: 'project', target: 'workers', project_id: Q }]); expect(dom.node('detail').querySelector('.agent-call')).toBeNull();
});
test('layout publishes legacy projection and widgets atomically, cancel never writes and layout failures keep draft/revision', async () => {
  await open(); const legacy = clone(config); await button('编辑布局').onclick(); dom.node('detail').querySelector('.project-board-handle').onkeydown({ key: 'ArrowDown' }); await button('取消布局').onclick(); expect(writes()).toHaveLength(0);
  await button('编辑布局').onclick(); dom.node('detail').querySelector('.project-board-handle').onkeydown({ key: 'ArrowDown' }); await button('保存布局').onclick(); expect(config.widgets).toHaveLength(8); expect(config.layout).toHaveLength(8); expect(writes()[0].body.expected_revision).toBe(legacy.revision);
  await button('编辑布局').onclick(); intercept = path => path === '/api/host/dashboard' ? Response.json({ error: 'revision conflict' }, { status: 409 }) : null;
  await button('保存布局').onclick(); expect(panel.state().editing).toBe(true); expect(panel.state().failedWrite).toBe(true); expect(button('保存布局').disabled).toBe(true);
});
test('modal single-flight/close protection, failed ACK keeps form and explicit reread failure retains edits', async () => {
  await open(); await settings(); const control = inputs().find(node => node.dataset.section === 'metrics'); change(control, false);
  let release; intercept = (path, options) => path === '/api/host/dashboard' && options.method === 'POST' ? new Promise(resolve => { release = resolve; }) : null;
  const pending = button('保存').onclick(); await button('保存').onclick(); await button('取消').onclick(); dom.node('modal').onkeydown({ key: 'Escape', preventDefault() {} }); expect(dom.node('modal').hidden).toBe(false); expect(writes()).toHaveLength(1);
  release(Response.json({ error: 'revision changed' }, { status: 409 })); await pending; expect(control.checked).toBe(false); expect(dom.node('modal').hidden).toBe(false); expect(button('保存').disabled).toBe(true);
  intercept = path => path === '/api/host/dashboard' ? Response.json({ error: 'read failed' }, { status: 503 }) : null;
  await button('重新读取设置').onclick(); expect(control.checked).toBe(false); expect(deepText(dom.node('modal'))).toContain('原编辑已保留');
});
test('a save must have complete v4 ACK; legacy ACK is unconfirmed and never clears draft', async () => {
  await open(); await settings(); intercept = (path, options) => path === '/api/host/dashboard' && options.method === 'POST' ? Response.json({ ...config, version: 3, revision: 'wrong' }) : null;
  await button('保存').onclick(); expect(panel.state().failedWrite).toBe(true); expect(dom.node('modal').hidden).toBe(false); expect(panel.state().config.revision).toBe('initial');
});
test('refresh queries only actual widget sources even if old cards disagree; explicit partial refresh restricted to placed accounts', async () => {
  const account = newWidget('accounts', 'widget:accounts'); account.connection_ids = [B]; config.widgets = [account]; await open(); requests = [];
  await button('刷新全部').onclick(); expect(writes().map(row => row.body.params.id)).toEqual([B]); expect(writes()[0].body.method).toBe('agent.connections.query'); expect(requests.some(row => /start|select/.test(row.path))).toBe(false);
  requests = []; await panel.refresh([A]); expect(writes()).toHaveLength(0);
});
test('navigation late save does not close replacement modal or take focus; failed/late reads do not clear current draft', async () => {
  await open(); await settings(); let release; intercept = (path, options) => path === '/api/host/dashboard' && options.method === 'POST' ? new Promise(resolve => { release = resolve; }) : null;
  const pending = button('保存').onclick(); current = false; dom.node('detail').replaceChildren(); void formDialog({ title: '新弹窗', content: el('div', 'new') });
  release(Response.json({ ...config, widgets: [], revision: 'late' })); await pending; expect(deepText(dom.node('modal'))).toContain('新弹窗'); expect(dom.node('modal').hidden).toBe(false); expect(panel.state().config.revision).toBe('initial');
});
test('geometry callback resizes slots in the existing shell, keeps one footer and does not query providers', async () => {
  const row = newWidget('accounts', 'widget:accounts'); row.connection_ids = [A, B]; config.widgets = [row];
  await open(); const card = widgets()[0], footer = card.querySelector('.dashboard-widget-pagination');
  expect(card.querySelectorAll('.dashboard-widget-slot')).toHaveLength(2);
  dom.node('detail').querySelector('.project-board').changeGeometry(row.id, 10);
  expect(widgets()[0]).toBe(card); expect(card.querySelectorAll('.dashboard-widget-slot')).toHaveLength(1);
  expect(card.querySelectorAll('.dashboard-widget-pagination')).toHaveLength(1); expect(card.querySelector('.dashboard-widget-pagination')).toBe(footer);
  expect(footer.parentNode.classList.contains('project-board-content')).toBe(true); expect(writes()).toHaveLength(0);
});
test('真实网格使用来源配色和独立board-id，modal保存恢复同一卡片焦点，缩放保留LI和一份页脚', async () => {
  const status = newWidget('status', 'widget:status', P), accounts = newWidget('accounts', 'widget:accounts'); accounts.connection_ids = [A, B];
  config.widgets = [status, accounts]; await open(true);
  const card = widgets()[0]; expect(card.dataset.boardId).toBe(status.id); expect(card.dataset.projectId).toBe(P); expect(card.dataset.boardColor).toBe('rose');
  expect(requests.filter(row => row.path.endsWith('/appearance')).every(row => row.path.includes(P) && !row.path.includes('widget:'))).toBe(true);
  await card.querySelector('.dashboard-card-settings').onclick(); await button('保存').onclick();
  expect(dom.document.activeElement).toBe(widgets()[0]);
  const account = widgets()[1]; expect(account.querySelectorAll('.dashboard-widget-slot')).toHaveLength(2);
  await button('编辑布局').onclick(); const resize = account.querySelector('.project-board-resize');
  resize.onkeydown({ key: 'ArrowUp', preventDefault() {} }); resize.onkeydown({ key: 'ArrowUp', preventDefault() {} }); resize.onkeydown({ key: 'ArrowUp', preventDefault() {} });
  expect(widgets()[1]).toBe(account); expect(account.querySelectorAll('.dashboard-widget-slot')).toHaveLength(1);
  expect(account.querySelectorAll('.dashboard-widget-pagination')).toHaveLength(1);
});
test('shared shell preserves per-card group refresh blockers; empty group cannot query another group source', async () => {
  const empty = newWidget('accounts', 'widget:empty'), selected = newWidget('accounts', 'widget:selected'); selected.connection_ids = [B]; config.widgets = [empty, selected];
  await open(); const groups = dom.node('detail').querySelectorAll('.dashboard-accounts-refresh');
  expect(groups[0].disabled).toBe(true); expect(groups[1].disabled).toBe(false); requests = [];
  await groups[1].onclick(); expect(writes().map(row => row.body.params.id)).toEqual([B]);
});
test('configuration read failure stays unconfirmed, does not create/write a false empty panel', async () => {
  intercept = path => path === '/api/host/dashboard' ? Response.json({ error: 'missing config' }, { status: 503 }) : null;
  await open(); expect(panel.state().config).toBeNull(); expect(writes()).toHaveLength(0);
  expect(deepText(dom.node('detail'))).toContain('卡片配置读取失败'); expect(dom.node('detail').querySelector('.dashboard-settings-open').disabled).toBe(true);
});
test('refresh while modal open keeps original revision, external change conflicts instead of overwriting old draft', async () => {
  await open(); await settings(); config.revision = 'external'; await panel.refresh(); await button('保存').onclick(); expect(writes().at(-1).body.expected_revision).toBe('initial'); expect(panel.state().failedWrite).toBe(true);
});
