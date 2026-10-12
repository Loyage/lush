import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
const P = 'aaaaaaaaaaaaaaaa', Q = 'bbbbbbbbbbbbbbbb';
const A = '11111111-1111-4111-8111-111111111111';
let requests, intercept, current, notices, workers;
const clone = value => structuredClone(value);
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null; requests.push({ path, body, method: options.method || 'GET' });
  const blocked = intercept?.(path, options, body); if (blocked) return blocked;
  if (path.includes('/api/notices?')) { const status = new URL(path, 'http://localhost').searchParams.get('status'); const rows = notices[status]; return Response.json({ notices: clone(rows.slice(0, 3)), total: rows.length, has_more: rows.length > 3 }); }
  if (path.includes('/api/workers?')) { const query = new URL(path, 'http://localhost').searchParams, before = Number(query.get('before')) || Infinity, limit = Number(query.get('limit')); const rows = workers.filter(row => row.id < before).slice(0, limit); return Response.json({ tasks: clone(rows).reverse(), cursor: rows.at(-1)?.id || null, has_more: workers.some(row => row.id < (rows.at(-1)?.id || 0)) }); }
  if (path === '/api/host/inbox/action') {
    const notice = notices.unread.find(row => row.id === body.id); return Response.json({ project_id: body.project_id, project: '/source', project_name: 'Source', online: true, notice: { ...notice, read_at: '2026-10-12T00:00:00Z' } });
  }
  return Response.json({ error: path }, { status: 404 });
} });
afterAll(() => dom.restore());
const { createWidgetRenderer } = await import('../../src/ui/web/assets/dashboard-widget-render.js');
const { newWidget, widgetRows } = await import('../../src/ui/web/assets/dashboard-widget-model.js');
const { loadProjectCardMessages } = await import('../../src/ui/web/assets/project-dashboard-content.js');
const { readDashboardConfig } = await import('../../src/ui/web/assets/dashboard-cards.js');
const source = id => ({ id, name: 'Source', project: '/source', running: true });
const notice = (id, kind = 'info') => ({ id, task_id: 92, task_worker_number: 'W204-3', title: '<img src=x>' + '长文本'.repeat(200), body: 'body', kind, status: kind === 'info' ? 'sent' : 'open', source_event_id: kind === 'info' ? id : null, read_at: null, created_at: '2026-10-01T00:00:00Z', sync_identity: String(id).padStart(32, '0') });
beforeEach(() => { requests = []; intercept = null; current = true; dom.node('detail').replaceChildren(); notices = { open: [notice(20, 'questionnaire'), notice(19, 'question')], unread: [notice(18), notice(17), notice(16), notice(15)] }; workers = Array.from({ length: 7 }, (_, i) => ({ id: 7 - i, worker_number: `W1-${i + 1}`, goal: '目标'.repeat(200), status: 'running' })); });
function mount(renderer, widget, { project = source(widget.project_id || P), connections = [], geometry } = {}) { const row = widgetRows([widget], [project], connections)[0], root = renderer.render(row, { geometry }); dom.node('detail').append(root); return root; }
const footerButtons = root => root.querySelector('.dashboard-widget-pagination').querySelectorAll('button');

test('v4 strict reader keeps legacy fields, null compatibility and genuine empty; invalid or incomplete ACK is never blank', async () => {
  const base = { version: 4, revision: 'r4', account_view: 'list', cards: [], hidden_projects: [], layout: [], content: [], widgets: null };
  expect(await readDashboardConfig({ value: base })).toEqual({ ...base, diagnostics: true });
  expect((await readDashboardConfig({ value: { ...base, widgets: [] } })).widgets).toEqual([]);
  for (const patch of [{ widgets: undefined }, { widgets: [{ id: 'widget:a', type: 'accounts' }] }, { account_view: undefined }, { layout: undefined }]) await expect(readDashboardConfig({ value: { ...base, ...patch } })).rejects.toThrow();
  const widget = newWidget('messages', 'widget:messages', P);
  expect((await readDashboardConfig({ value: { ...base, widgets: [widget], layout: [{ id: widget.id, x: 0, y: 0, w: 4, h: 8 }] } })).widgets).toEqual([widget]);
});
test('messages always two single-summary lines, exact totals/full titles/source D/N and W, 0/1/many do not add slots', async () => {
  for (const count of [0, 1, 5]) {
    notices.open = Array.from({ length: count }, (_, i) => notice(30 - i, 'question')); notices.unread = Array.from({ length: count }, (_, i) => notice(20 - i));
    const models = await loadProjectCardMessages([source(P)]), renderer = createWidgetRenderer({ ownsPage: () => current, messages: () => models });
    const root = mount(renderer, newWidget('messages', `widget:messages-${count}`, P));
    expect(root.querySelectorAll('.dashboard-widget-message')).toHaveLength(2); expect(root.querySelectorAll('.dashboard-widget-count').map(node => node.textContent)).toEqual([`待答 ${count}`, `告知 ${count}`]);
    expect(root.querySelectorAll('img')).toHaveLength(0);
    if (count) { const target = root.querySelector('.project-dashboard-message'); expect(target.href).toBe(`/p/${P}/#notices-30`); expect(target.target).toBe('_blank'); expect(deepText(target)).toContain('D30'); expect(deepText(target)).toContain('W204-3'); expect(target.onclick).toBeUndefined(); }
    root.remove();
  }
  expect(requests.every(row => row.method === 'GET')).toBe(true);
});
test('legacy absent total explicitly lower-bound +; unknown kind never guessed as question or gains a read action', async () => {
  intercept = path => path.includes('/api/notices?') ? Response.json({ notices: [notice(9, 'unknown')], has_more: true }) : null;
  const models = await loadProjectCardMessages([source(P)]), root = mount(createWidgetRenderer({ messages: () => models }), newWidget('messages', 'widget:m', P));
  expect(deepText(root)).toContain('待处理 1+'); expect(deepText(root)).toContain('N9'); expect(deepText(root)).toContain('类型未知'); expect(root.querySelectorAll('.dashboard-widget-notice-read')).toHaveLength(0);
});
test('known only reads current info with expected source identity, single flight and success immediately reveals next', async () => {
  const models = await loadProjectCardMessages([source(P)]), renderer = createWidgetRenderer({ messages: () => models, ownsPage: () => current });
  const root = mount(renderer, newWidget('messages', 'widget:m', P));
  let release; intercept = path => path === '/api/host/inbox/action' ? new Promise(resolve => { release = resolve; }) : null;
  const button = root.querySelector('.dashboard-widget-notice-read'), pending = button.onclick(); await button.onclick();
  expect(requests.filter(row => row.method === 'POST')).toHaveLength(1); expect(button.disabled).toBe(true);
  expect(requests.at(-1).body).toEqual({ project_id: P, id: 18, method: 'notice.read', expected_identity: notices.unread[0].sync_identity });
  release(Response.json({ project_id: P, project: '/source', project_name: 'Source', online: true, notice: { ...notices.unread[0], read_at: 'now' } })); await pending;
  expect(deepText(root)).toContain('告知 3'); expect(root.querySelectorAll('.project-dashboard-message')[1].href).toBe(`/p/${P}/#notices-17`);
  expect(root.querySelector('.dashboard-widget-notice-read').disabled).toBe(false); expect(requests.filter(row => row.method === 'POST')).toHaveLength(1);
});
test('same local notice ids isolated across project sources; duplicate widgets share source lock and ACK overlay', async () => {
  const models = await loadProjectCardMessages([source(P), source(Q)]), renderer = createWidgetRenderer({ messages: () => models });
  const roots = [mount(renderer, newWidget('messages', 'widget:a', P)), mount(renderer, newWidget('messages', 'widget:b', P)), mount(renderer, newWidget('messages', 'widget:c', Q), { project: source(Q) })];
  await roots[0].querySelector('.dashboard-widget-notice-read').onclick();
  expect(roots[0].querySelectorAll('.project-dashboard-message')[1].href).toBe(`/p/${P}/#notices-17`); expect(roots[1].querySelectorAll('.project-dashboard-message')[1].href).toBe(`/p/${P}/#notices-17`);
  expect(roots[2].querySelectorAll('.project-dashboard-message')[1].href).toBe(`/p/${Q}/#notices-18`);
});
test('read failure/source mismatch retains current info; late ACK after navigation does not paint or submit again', async () => {
  const models = await loadProjectCardMessages([source(P)]), root = mount(createWidgetRenderer({ messages: () => models, ownsPage: () => current }), newWidget('messages', 'widget:a', P));
  intercept = path => path === '/api/host/inbox/action' ? Response.json({ error: 'offline' }, { status: 503 }) : null;
  await root.querySelector('.dashboard-widget-notice-read').onclick(); expect(deepText(root)).toContain('已知失败'); expect(root.querySelectorAll('.project-dashboard-message')[1].href).toContain('notices-18');
  intercept = path => path === '/api/host/inbox/action' ? Response.json({ project_id: Q, project: '/source', project_name: 'Q', online: true, notice: { ...notices.unread[0], read_at: 'now' } }) : null;
  await root.querySelector('.dashboard-widget-notice-read').onclick(); expect(deepText(root)).toContain('来源不一致');
  let release; intercept = path => path === '/api/host/inbox/action' ? new Promise(resolve => { release = resolve; }) : null;
  const pending = root.querySelector('.dashboard-widget-notice-read').onclick(), text = deepText(root); current = false;
  release(Response.json({ project_id: P, project: '/source', project_name: 'Source', online: true, notice: { ...notices.unread[0], read_at: 'now' } })); await pending; expect(deepText(root)).toBe(text);
});
test('workers use source bounded pages not recent-three摘要, fixed empty slots and bidirectional pages; no eager whole history', async () => {
  const renderer = createWidgetRenderer({ ownsPage: () => current }), root = mount(renderer, newWidget('workers', 'widget:workers', P), { geometry: { w: 4, h: 12 } }); await root.dashboardReady();
  expect(requests.map(row => row.path)).toEqual([`/p/${P}/api/workers?scope=work&limit=3`]);
  expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(3); expect(deepText(root)).toContain('W1-1');
  await footerButtons(root)[1].onclick(); await new Promise(setImmediate);
  expect(requests.at(-1).path).toBe(`/p/${P}/api/workers?scope=work&limit=3&before=5`); expect(deepText(root)).toContain('W1-4');
  await footerButtons(root)[1].onclick(); await new Promise(setImmediate); expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(3); expect(root.querySelectorAll('[data-empty="true"]')).toHaveLength(2);
  expect(footerButtons(root)[1].disabled).toBe(true); await footerButtons(root)[0].onclick(); expect(deepText(root)).toContain('W1-4'); expect(requests).toHaveLength(3);
});
test('workers offline never read; failed page retains fixed slots and retry only by refresh; geometry page capacity is bounded', async () => {
  const renderer = createWidgetRenderer({ ownsPage: () => current }), widget = newWidget('workers', 'widget:w', P);
  const offline = mount(renderer, widget, { project: { ...source(P), running: false } }); await offline.dashboardReady(); expect(requests).toHaveLength(0); expect(deepText(offline)).toContain('未确认');
  offline.remove(); intercept = path => path.includes('/api/workers?') ? Response.json({ error: 'failed' }, { status: 503 }) : null;
  const root = mount(renderer, widget, { geometry: { w: 4, h: 14 } }); await root.dashboardReady(); expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(4); expect(deepText(root)).toContain('读取失败');
});
test('accounts fixed three slots and two metric slots; empty/many/long labels keep occupancy, excess accounts paginate and metrics open bounded details', async () => {
  const widget = newWidget('accounts', 'widget:accounts'); widget.connection_ids = Array.from({ length: 5 }, (_, i) => A.replace(/^11111111/, String(i).padStart(8, '0')));
  const connections = widget.connection_ids.map(id => ({ id, label: '账户'.repeat(300), enabled: true, observation: { status: 'available', resources: Array.from({ length: 5 }, (_, i) => ({ id: `cash-${i}`, kind: 'balance', remaining: i, unit: 'USD', scope: 'account' })) } }));
  const renderer = createWidgetRenderer(), root = mount(renderer, widget, { connections, geometry: { w: 6, h: 18 } });
  expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(3); expect(root.querySelectorAll('.dashboard-account-metric-slot')).toHaveLength(6);
  expect(root.querySelectorAll('.dashboard-account-metric')).toHaveLength(6); await root.querySelector('.dashboard-account-details').onclick();
  expect(dom.node('modal').querySelectorAll('.dashboard-account-metric')).toHaveLength(5); expect(root.querySelectorAll('.dashboard-account-metric')).toHaveLength(6);
  await footerButtons(root)[1].onclick(); expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(3); expect(root.querySelectorAll('[data-empty="true"]')).toHaveLength(1);
  expect(root.querySelectorAll('.dashboard-account-card')).toHaveLength(2);
  const empty = mount(renderer, newWidget('accounts', 'widget:empty')); expect(empty.querySelectorAll('.dashboard-widget-slot')).toHaveLength(2);
});
test('shortcuts selected global/project destinations are native safe new-tab links, fixed slots and pagination; no calls or maintenance', async () => {
  const widget = newWidget('shortcuts', 'widget:links'); widget.links = ['notices', 'settings', 'model-sources', 'docs'].map(target => ({ scope: 'global', target, project_id: null })); widget.links.push({ scope: 'project', target: 'workers', project_id: Q });
  const root = mount(createWidgetRenderer(), widget, { geometry: { w: 4, h: 12 } }); expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(3);
  expect(root.querySelector('.dashboard-widget-links').querySelectorAll('a').map(row => row.href)).toEqual(['/#notices', '/#settings', '/#model-sources']);
  const next = footerButtons(root)[1]; next.focus(); await next.onclick();
  expect(footerButtons(root)[1]).toBe(next); expect(dom.document.activeElement).toBe(next);
  expect(root.querySelector('.dashboard-widget-links').querySelectorAll('a').map(row => row.href)).toEqual(['/#docs', `/p/${Q}/#workers`]);
  expect(root.querySelectorAll('a').every(row => row.target === '_blank' && row.rel === 'noopener')).toBe(true); expect(requests).toHaveLength(0); expect(root.querySelector('.agent-call')).toBeNull();
});
