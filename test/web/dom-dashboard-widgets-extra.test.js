import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
const P = 'aaaaaaaaaaaaaaaa', Q = 'bbbbbbbbbbbbbbbb';
let fetcher, requests = [], current = true;
const dom = installDom({ fetch: async (url, options = {}) => { requests.push(String(url)); return fetcher(String(url), options); } });
afterAll(() => dom.restore());
const { createWidgetRenderer } = await import('../../src/ui/web/assets/dashboard-widget-render.js');
const { newWidget, widgetRows } = await import('../../src/ui/web/assets/dashboard-widget-model.js');
const { loadProjectCardMessages } = await import('../../src/ui/web/assets/project-dashboard-content.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const { renderAccountCard } = await import('../../src/ui/web/assets/dashboard-cards.js');
const project = id => ({ id, running: true, name: 'project', project: '/source' });
const workerPage = (ids, more = false) => Response.json({ tasks: ids.map(id => ({ id, worker_number: `W1-${id}`, goal: `goal ${id}`, status: 'running' })), has_more: more, cursor: ids.at(-1) || null });
function mount(renderer, row, geometry = { w: 4, h: 12 }) { const root = renderer.render(widgetRows([row], [project(row.project_id)], [])[0], { geometry }); dom.node('detail').append(root); return root; }
test('late worker page after same-source geometry repaint applies to current node, and source switch never gets old-source rows', async () => {
  requests = []; current = true; dom.node('detail').replaceChildren();
  let release; fetcher = () => new Promise(resolve => { release = resolve; });
  const renderer = createWidgetRenderer({ ownsPage: () => current }), row = newWidget('workers', 'widget:w', P);
  const first = mount(renderer, row), pending = first.dashboardReady();
  first.remove(); const next = mount(renderer, row); release(workerPage([9, 8, 7])); await pending;
  expect(deepText(next)).toContain('W1-9'); expect(next.querySelectorAll('.dashboard-widget-slot')).toHaveLength(3);
  renderer.resetWorkers(); next.remove(); const second = mount(renderer, row), oldPending = second.dashboardReady();
  const oldRelease = release; second.remove(); const switched = mount(renderer, { ...row, project_id: Q }); const newPending = switched.dashboardReady(), newRelease = release;
  oldRelease(workerPage([6, 5, 4])); await oldPending; expect(deepText(switched)).not.toContain('W1-6');
  newRelease(workerPage([3, 2, 1])); await newPending; expect(deepText(switched)).toContain('W1-3');
  expect(requests.at(-1)).toContain(`/p/${Q}/`);
});
test('worker resize retains current before anchor, changes capacity and never skips rows through a stale cursor', async () => {
  current = true; requests = []; dom.node('detail').replaceChildren();
  fetcher = path => {
    const query = new URL(path, 'http://localhost').searchParams, before = Number(query.get('before')) || 10, limit = Number(query.get('limit'));
    const ids = Array.from({ length: before - 1 }, (_, i) => before - 1 - i).slice(0, limit); return workerPage(ids, ids.at(-1) > 1);
  };
  const root = mount(createWidgetRenderer({ ownsPage: () => current }), newWidget('workers', 'widget:resize', P)); await root.dashboardReady();
  const buttons = () => root.querySelector('.dashboard-widget-pagination').querySelectorAll('button');
  await buttons()[1].onclick(); expect(deepText(root)).toContain('W1-6');
  root.dashboardGeometryChange({ w: 4, h: 10 }); await root.dashboardReady();
  expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(2); expect(deepText(root)).toContain('W1-6');
  expect(requests.at(-1)).toBe(`/p/${P}/api/workers?scope=work&limit=2&before=7`);
  await buttons()[1].onclick(); expect(deepText(root)).toContain('W1-4'); expect(requests.at(-1)).toContain('before=5');
  await buttons()[0].onclick(); expect(deepText(root)).toContain('W1-6');
  await buttons()[0].onclick(); expect(deepText(root)).toContain('W1-9'); expect(deepText(root)).toContain('W1-8');
  await buttons()[1].onclick(); expect(deepText(root)).toContain('W1-7'); expect(requests.at(-1)).toContain('before=8');
  expect(root.querySelectorAll('.dashboard-widget-pagination')).toHaveLength(1);
});
test('geometry resize during pending worker read ignores late old-capacity data and coalesces same-turn capacity changes', async () => {
  current = true; requests = []; dom.node('detail').replaceChildren(); let release;
  fetcher = () => new Promise(resolve => { release = resolve; });
  const root = mount(createWidgetRenderer({ ownsPage: () => current }), newWidget('workers', 'widget:pending-resize', P)), old = root.dashboardReady(), oldRelease = release;
  root.dashboardGeometryChange({ w: 4, h: 8 }); root.dashboardGeometryChange({ w: 4, h: 14 });
  const next = root.dashboardReady(), newRelease = release;
  oldRelease(workerPage([9, 8, 7])); await old; expect(deepText(root)).not.toContain('W1-9');
  newRelease(workerPage([6, 5, 4, 3])); await next;
  expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(4); expect(deepText(root)).toContain('W1-6'); expect(requests).toHaveLength(2);
});
test('leaving before worker response cannot paint old DOM, start older page or repeat fetch', async () => {
  requests = []; current = true; dom.node('detail').replaceChildren();
  let release; fetcher = () => new Promise(resolve => { release = resolve; });
  const root = mount(createWidgetRenderer({ ownsPage: () => current }), newWidget('workers', 'widget:leave', P));
  const pending = root.dashboardReady(), before = deepText(root); current = false;
  release(workerPage([9, 8, 7], true)); await pending; expect(deepText(root)).toBe(before); expect(requests).toHaveLength(1);
});
test('empty filtered notice pages follow bounded cursor, preserve full status total and latest origin record', async () => {
  current = true; requests = []; let count = 0;
  fetcher = path => path.includes('status=unread') ? Response.json({ notices: [], total: 0, has_more: false }) : ++count < 3
    ? Response.json({ notices: [], total: 4, has_more: true, cursor: count === 1 ? 20 : 15 })
    : Response.json({ notices: [{ id: 12, task_id: 5, kind: 'question', status: 'open', title: 'latest' }], total: 4, has_more: true, cursor: 12 });
  const model = (await loadProjectCardMessages([project(P)])).get(P);
  expect(model.groups.open.total).toBe(4); expect(model.groups.open.notices[0].id).toBe(12);
  expect(requests.filter(path => path.includes('status=open'))).toEqual([`/p/${P}/api/notices?status=open&limit=3`, `/p/${P}/api/notices?status=open&limit=3&before=20`, `/p/${P}/api/notices?status=open&limit=3&before=15`]);
  count = 0; requests = []; fetcher = path => Response.json({ notices: [], total: 4, has_more: true, cursor: 30 - ++count });
  const bounded = (await loadProjectCardMessages([project(P)])).get(P); expect(requests).toHaveLength(6); expect(bounded.complete).toBe(false); expect(bounded.groups.open.total).toBe(4);
});
test('exact non-plan zero total settles filtered empty pages without walking retired plans or calling it unconfirmed', async () => {
  current = true; requests = []; dom.node('detail').replaceChildren();
  fetcher = () => Response.json({ notices: [], total: 0, has_more: true, cursor: 20 });
  const models = await loadProjectCardMessages([project(P)]);
  expect(requests).toHaveLength(2);
  const root = mount(createWidgetRenderer({ messages: () => models }), newWidget('messages', 'widget:non-plan-zero', P));
  expect(root.querySelectorAll('.dashboard-widget-count').map(node => node.textContent)).toEqual(['待答 0', '告知 0']);
  expect(root.querySelectorAll('span.dashboard-widget-title').map(node => node.textContent)).toEqual(['暂无', '暂无']);
});
test('zero-capacity projections retain full navigation, never request limit=0, and restore source anchors', async () => {
  current = true; requests = []; dom.node('detail').replaceChildren(); closeDialog();
  fetcher = path => {
    const query = new URL(path, 'http://localhost').searchParams, before = Number(query.get('before')) || 10, limit = Number(query.get('limit'));
    const ids = Array.from({ length: before - 1 }, (_, i) => before - 1 - i).slice(0, limit); return workerPage(ids, ids.at(-1) > 1);
  };
  const renderer = createWidgetRenderer(), workers = mount(renderer, newWidget('workers', 'widget:zero-workers', P), { w: 4, h: 6 });
  await workers.dashboardReady(); expect(requests).toHaveLength(0); expect(workers.querySelectorAll('.dashboard-widget-slot')).toHaveLength(0);
  expect(workers.querySelector('a').href).toBe(`/p/${P}/#workers`);
  workers.dashboardGeometryChange({ w: 4, h: 12 }); await workers.dashboardReady();
  await workers.querySelector('.dashboard-widget-pagination').querySelectorAll('button')[1].onclick();
  workers.dashboardGeometryChange({ w: 4, h: 6 }); await workers.dashboardReady(); expect(requests).toHaveLength(2);
  workers.dashboardGeometryChange({ w: 4, h: 10 }); await workers.dashboardReady(); expect(requests.at(-1)).toContain('limit=2&before=7'); expect(deepText(workers)).toContain('W1-6');
  const account = newWidget('accounts', 'widget:zero-accounts'); account.connection_ids = Array.from({ length: 5 }, (_, i) => `${i + 1}1111111-1111-4111-8111-111111111111`);
  const accounts = mount(renderer, account, { w: 6, h: 18 }); await accounts.querySelector('.dashboard-widget-pagination').querySelectorAll('button')[1].onclick();
  const anchor = accounts.querySelector('.dashboard-account-card').dataset.connectionId;
  accounts.dashboardGeometryChange({ w: 4, h: 8 }); expect(accounts.querySelectorAll('.dashboard-widget-slot')).toHaveLength(0);
  expect(accounts.querySelector('.dashboard-widget-footer').querySelectorAll('button')).toHaveLength(3);
  await accounts.querySelector('.dashboard-accounts-details').onclick(); expect(dom.node('modal').querySelector('a').href).toBe('/#model-sources'); closeDialog();
  accounts.dashboardGeometryChange({ w: 6, h: 14 }); expect(accounts.querySelectorAll('.dashboard-account-card').map(row => row.dataset.connectionId)).toContain(anchor);
  const shortcut = newWidget('shortcuts', 'widget:zero-links'); shortcut.links = ['notices', 'settings', 'model-sources', 'docs'].map(target => ({ scope: 'global', target, project_id: null }));
  const shortcuts = mount(renderer, shortcut, { w: 4, h: 6 }); expect(shortcuts.querySelectorAll('.dashboard-widget-slot')).toHaveLength(0);
  await shortcuts.querySelector('.dashboard-widget-fullpage').onclick(); expect(dom.node('modal').querySelectorAll('nav')[0].querySelectorAll('a')).toHaveLength(4);
  expect([accounts, shortcuts, workers].every(root => !/Infinity|NaN/.test(deepText(root)))).toBe(true);
});
test('bounded quota reset stays inline and extra currency metrics remain in a source-specific modal', async () => {
  current = true; dom.node('detail').replaceChildren(); closeDialog();
  const id = '11111111-1111-4111-8111-111111111111', row = newWidget('accounts', 'widget:quota'); row.connection_ids = [id];
  const source = { id, label: 'quota source', enabled: true, observation: { status: 'available', source: 'usage_api', resources: [
    { id: 'quota', kind: 'quota', scope: 'key', unit: 'tokens', window_seconds: 3600, used_percent: 0, remaining: 500, reset_at: new Date(Date.now() + 3600000).toISOString() },
    { id: 'usd', kind: 'balance', scope: 'account', unit: 'USD', remaining: 3 }, { id: 'eur', kind: 'balance', scope: 'account', unit: 'EUR', remaining: 4 },
  ] } };
  const renderer = createWidgetRenderer(), root = renderer.render(widgetRows([row], [], [source])[0]); dom.node('detail').append(root);
  const metric = root.querySelector('.dashboard-account-metric');
  expect(metric.querySelector('.dashboard-account-reset-inline')).not.toBeNull(); expect(metric.querySelector('.dashboard-account-reset')).toBeNull();
  expect(deepText(root)).toContain('Key 预算'); expect(deepText(root)).toContain('0%'); expect(deepText(root)).not.toContain('EUR');
  await root.querySelector('.dashboard-account-details').onclick();
  expect(deepText(dom.node('modal'))).toContain('EUR'); expect(deepText(dom.node('modal'))).toContain('tokens'); expect(root.querySelectorAll('.dashboard-account-metric')).toHaveLength(2);
});
test('account details stay in modal and never add metrics/paths/history into fixed card; source deletion remains visible', () => {
  current = true; dom.node('detail').replaceChildren(); closeDialog();
  const row = newWidget('accounts', 'widget:deleted'); row.connection_ids = ['11111111-1111-4111-8111-111111111111'];
  const root = mount(createWidgetRenderer(), row, { w: 6, h: 14 }); expect(deepText(root)).toContain('来源已删除'); expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(2);
});
test('bounded account metrics are the slots themselves; warning/history state stays in the fixed identity row', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const resource = { id: 'quota', kind: 'quota', scope: 'account', unit: '%', used_percent: 25, window_seconds: 18000 };
  for (const status of ['available', 'error', 'unknown', 'partial']) {
    const connection = { id, label: 'source', enabled: status !== 'error', observation: { status, resources: [resource] }, last_success: { observation: { status: 'available', resources: [resource] } } };
    const root = renderAccountCard({ id: `account:${id}`, connection_id: id, connection }, { embedded: true, bounded: true, sections: ['quota', 'observed'] });
    const slots = root.querySelectorAll('.dashboard-account-metric-slot'); expect(slots).toHaveLength(2);
    for (const slot of slots) expect(slot.querySelector('.dashboard-account-metric')).toBeNull();
    expect(root.querySelector('.dashboard-account-content').querySelector('.dashboard-card-warning')).toBeNull();
    if (status !== 'available') expect(root.querySelector('.dashboard-account-identity').querySelector('.dashboard-account-state')).not.toBeNull();
    if (status === 'error') expect(root.querySelector('.dashboard-account-state').textContent).toContain('有历史观测（非当前值）');
  }
});
