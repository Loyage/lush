import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
const P = 'aaaaaaaaaaaaaaaa', Q = 'bbbbbbbbbbbbbbbb', A = '11111111-1111-4111-8111-111111111111';
let requests, intercept, current, notices, workers;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null; requests.push({ path, body, method: options.method || 'GET' });
  const blocked = intercept?.(path, options, body); if (blocked) return blocked;
  if (path.includes('/api/notices?')) {
    const status = new URL(path, 'http://localhost').searchParams.get('status'), rows = notices[status];
    return Response.json({ notices: structuredClone(rows.slice(0, 3)), total: rows.length, has_more: rows.length > 3 });
  }
  if (path.includes('/api/workers?')) {
    const params = new URL(path, 'http://localhost').searchParams, before = Number(params.get('before')) || Infinity, limit = Number(params.get('limit'));
    const rows = workers.filter(row => row.id < before).slice(0, limit);
    return Response.json({ tasks: [...rows].reverse(), has_more: workers.some(row => row.id < (rows.at(-1)?.id || 0)), cursor: rows.at(-1)?.id || null });
  }
  if (path === '/api/host/inbox/action') return receipt(body.project_id, notices.unread.find(row => row.id === body.id));
  throw new Error(`unexpected ${path}`);
} });
afterAll(() => dom.restore());
const { createAggregateRenderer } = await import('../../src/ui/web/assets/dashboard-widget-aggregate-render.js');
const { aggregateRows } = await import('../../src/ui/web/assets/dashboard-widget-aggregate-model.js');
const { loadProjectCardMessages, PROJECT_CARD_DEFAULTS } = await import('../../src/ui/web/assets/project-dashboard-content.js');
const { closeDialog, formDialog } = await import('../../src/ui/web/assets/dialog.js');
const { el } = await import('../../src/ui/web/assets/dom.js');
const source = id => ({ id, project: '/source', running: true, name: '项目'.repeat(200), summary: { notices: 2, development: {
  workers_total: 100, active: 3, agents_running: 1, awaiting_acceptance: 2, parent_confirmation: 1, pending_merges: 1, merging: 0, merge_conflicts: 0,
  counts: [{ status: 'running', count: 3 }], recent_workers: [],
} } });
const notice = (id, kind = 'info') => ({ id, kind, task_id: 92, task_worker_number: 'W204-3', title: '<img src=x>' + '长文本'.repeat(300), body: 'body', status: kind === 'info' ? 'sent' : 'open', read_at: null,
  source_event_id: kind === 'info' ? id : null, created_at: '2026-10-01T00:00:00Z', sync_identity: String(id).padStart(32, '0') });
const receipt = (project_id, record, extra = {}) => Response.json({ project_id, project: '/source', project_name: 'Source', online: true, notice: { ...record, read_at: 'now', ...extra } });
function mount(renderer, { id = P, sections = PROJECT_CARD_DEFAULTS, geometry = { w: 6, h: 24 }, project = source(id), links = [] } = {}) {
  const row = { ...project, id, type: 'project', project_id: id, source: project, sections, links };
  const root = renderer.render(row, { geometry }); dom.node('detail').append(root); return root;
}
const next = root => root.querySelector('.dashboard-widget-pagination').children[2].children[0];
const previous = root => root.querySelector('.dashboard-widget-pagination').children[0].children[0];
beforeEach(() => {
  closeDialog(); current = true; requests = []; intercept = null; dom.node('detail').replaceChildren();
  notices = { open: [notice(20, 'question')], unread: [notice(18), notice(17), notice(16), notice(15)] };
  workers = Array.from({ length: 9 }, (_, i) => ({ id: 9 - i, worker_number: `W1-${9 - i}`, goal: '长目标'.repeat(200), status: 'running' }));
});
test('all selected content stays in one project shell: six fixed metrics, two message rows, three worker slots and one footer', async () => {
  for (const count of [0, 1, 5]) {
    notices.open = Array.from({ length: count }, (_, i) => notice(30 - i, 'question')); notices.unread = Array.from({ length: count }, (_, i) => notice(20 - i));
    const models = await loadProjectCardMessages([source(P)]), root = mount(createAggregateRenderer({ messages: () => models })); await root.dashboardReady();
    expect(root.dataset.cardId).toBe(P); expect(root.dataset.widgetType).toBe('project'); expect(root.querySelectorAll('.project-development-metric')).toHaveLength(6);
    expect(root.querySelectorAll('.dashboard-widget-message')).toHaveLength(2); expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(3); expect(root.querySelectorAll('.dashboard-widget-footer')).toHaveLength(1);
    expect(root.querySelectorAll('.dashboard-widget-count').map(node => node.textContent)).toEqual([`待答 ${count}`, `告知 ${count}`]);
    expect(root.querySelectorAll('img')).toHaveLength(0); expect(root.querySelectorAll('.project-open small')).toHaveLength(0); expect(root.querySelectorAll('.project-development-metric small')).toHaveLength(0);
    if (count) { const target = root.querySelector('.project-dashboard-message'); expect(target.href).toBe(`/p/${P}/#notices-30`); expect(target.target).toBe('_blank'); expect(deepText(target)).toContain('D30'); expect(deepText(target)).toContain('W204-3'); expect(target.onclick).toBeUndefined(); }
    root.remove();
  }
  expect(requests.every(row => row.method === 'GET')).toBe(true);
});
test('minimum geometry detaches overflow rather than hiding focusable content; selected modules remain reachable in modal and native full pages', async () => {
  const models = await loadProjectCardMessages([source(P)]), root = mount(createAggregateRenderer({ messages: () => models }), { geometry: { w: 4, h: 10 } }); await root.dashboardReady();
  expect(root.querySelector('.project-development-metrics')).toBeNull(); expect(root.querySelectorAll('.dashboard-widget-message')).toHaveLength(2); expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(0);
  expect(requests.filter(row => row.path.includes('/api/workers?'))).toHaveLength(0);
  await root.querySelector('.dashboard-project-details').onclick(); expect(dom.node('modal').querySelectorAll('.project-development-metric')).toHaveLength(4); expect(dom.node('modal').querySelectorAll('.dashboard-widget-message')).toHaveLength(2);
  expect(dom.node('modal').querySelectorAll('a').every(target => target.target === '_blank')).toBe(true); closeDialog();
  root.dashboardGeometryChange({ w: 6, h: 16 }); expect(root.querySelector('.dashboard-project-workers')).toBeNull();
  expect(root.querySelector('.dashboard-widget-body').children.map(node => node.dataset.section)).toEqual(['metrics', 'distribution', 'messages']);
  root.dashboardGeometryChange({ w: 4, h: 6 }); expect(root.querySelectorAll('.dashboard-widget-message')).toHaveLength(0); expect(root.querySelector('.dashboard-project-details')).not.toBeNull();
  expect(root.querySelector('.dashboard-project-links')).toBeNull(); expect(root.querySelector('.dashboard-widget-footer').querySelectorAll('button')).toHaveLength(3);
  await root.querySelector('.dashboard-project-details').onclick(); expect(dom.node('modal').querySelector('.dashboard-navigation-menu').querySelectorAll('a').map(target => target.href)).toEqual([`/p/${P}/#workers`, `/p/${P}/#notices`]);
});
test('selected shortcuts retain native direct links while cramped cards keep the complete modal fallback', async () => {
  const links = ['workers', 'inputs', 'versions', 'notices'].map(target => ({ scope: 'project', project_id: P, target }));
  const root = mount(createAggregateRenderer(), { sections: ['metrics', 'shortcuts'], links: [...links, links[0]] });
  const direct = root.querySelector('.dashboard-project-direct-links');
  expect(direct.querySelectorAll('a').map(a => a.href)).toEqual(links.map(link => `/p/${P}/#${link.target}`));
  expect(direct.querySelectorAll('a').every(a => a.target === '_blank' && a.rel === 'noopener' && !a.onclick)).toBe(true);
  root.dashboardGeometryChange({ w: 4, h: 10 });
  await root.querySelector('.dashboard-project-details').onclick();
  expect(dom.node('modal').querySelector('.dashboard-navigation-menu').querySelectorAll('a')).toHaveLength(4);
  expect(requests).toHaveLength(0);
});
test('pure navigation cards show bounded direct entries, page them and retain all entries at zero capacity', async () => {
  const links = ['workers', 'inputs', 'versions', 'notices'].map(target => ({ scope: 'project', project_id: P, target }));
  const root = mount(createAggregateRenderer(), { sections: ['shortcuts'], links, geometry: { w: 4, h: 10 } });
  const entries = () => root.querySelector('.dashboard-widget-body').querySelectorAll('a').map(a => a.href);
  expect(entries()).toEqual([`/p/${P}/#workers`, `/p/${P}/#inputs`]);
  const forward = next(root); await forward.onclick();
  expect(entries()).toEqual([`/p/${P}/#versions`, `/p/${P}/#notices`]); expect(next(root)).toBe(forward);
  root.dashboardGeometryChange({ w: 4, h: 6 }); expect(entries()).toEqual([]);
  await root.querySelector('.dashboard-project-links').onclick();
  expect(dom.node('modal').querySelectorAll('a')).toHaveLength(4); closeDialog();
  root.dashboardGeometryChange({ w: 6, h: 24 }); expect(entries()).toHaveLength(4);
  expect(root.querySelectorAll('.dashboard-widget-footer')).toHaveLength(1); expect(requests).toHaveLength(0);
});
test('project workers paginate source history and geometry keeps before anchor, invalidates stale cursors, preserves native controls', async () => {
  const root = mount(createAggregateRenderer(), { sections: ['recent'] , geometry: { w: 6, h: 12 } }); await root.dashboardReady();
  expect(requests.at(-1).path).toBe(`/p/${P}/api/workers?scope=work&limit=3`); const footer = root.querySelector('.dashboard-widget-pagination'), nextButton = next(root);
  await next(root).onclick(); expect(deepText(root)).toContain('W1-6');
  root.dashboardGeometryChange({ w: 4, h: 10 }); await root.dashboardReady(); expect(requests.at(-1).path).toBe(`/p/${P}/api/workers?scope=work&limit=2&before=7`); expect(deepText(root)).toContain('W1-6');
  expect(next(root)).toBe(nextButton); expect(root.querySelector('.dashboard-widget-pagination')).toBe(footer); expect(root.querySelectorAll('.dashboard-project-details')).toHaveLength(1); expect(footer.querySelectorAll('button')).toHaveLength(3);
  await next(root).onclick(); expect(requests.at(-1).path).toContain('before=5'); await previous(root).onclick(); expect(deepText(root)).toContain('W1-6');
  root.dashboardGeometryChange({ w: 4, h: 6 }); await root.dashboardReady(); expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(0);
  root.dashboardGeometryChange({ w: 6, h: 12 }); await root.dashboardReady(); expect(requests.at(-1).path).toContain('limit=3&before=7');
});
test('resize during in-flight workers rejects old capacity, late response after leaving cannot repaint or read older pages', async () => {
  let release; intercept = path => path.includes('/api/workers?') ? new Promise(resolve => { release = resolve; }) : null;
  const root = mount(createAggregateRenderer({ ownsPage: () => current }), { sections: ['recent'], geometry: { w: 6, h: 12 } }), first = root.dashboardReady(), oldRelease = release;
  root.dashboardGeometryChange({ w: 4, h: 10 }); const pending = root.dashboardReady();
  oldRelease(Response.json({ tasks: workers.slice(0, 3), has_more: true, cursor: 7 })); await first; expect(deepText(root)).not.toContain('W1-9');
  release(Response.json({ tasks: workers.slice(0, 2), has_more: true, cursor: 8 })); await pending; expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(2);
  const older = next(root).onclick(), before = deepText(root); current = false;
  release(Response.json({ tasks: workers.slice(2, 4), has_more: true, cursor: 6 })); await older; expect(deepText(root)).toBe(before);
});
test('offline/partial/unknown/error messages and worker states are not presented as zero; unknown kinds never gain read actions', async () => {
  const renderer = createAggregateRenderer(), root = mount(renderer, { project: { ...source(P), running: false } }); await root.dashboardReady();
  expect(root.querySelectorAll('.project-development-value').map(node => node.textContent)).toEqual(['—', '—', '—', '—', '—', '—']); expect(deepText(root)).toContain('待答 —'); expect(requests).toHaveLength(0); root.remove();
  intercept = path => path.includes('/api/notices?') ? Response.json({ notices: [notice(9, 'unknown')], has_more: true }) : path.includes('/api/workers?') ? Response.json({ error: 'unavailable' }, { status: 503 }) : null;
  const models = await loadProjectCardMessages([source(P)]), unknown = mount(createAggregateRenderer({ messages: () => models })); await unknown.dashboardReady();
  expect(deepText(unknown)).toContain('待处理 1+'); expect(deepText(unknown)).toContain('N9'); expect(deepText(unknown)).toContain('读取失败'); expect(unknown.querySelectorAll('.dashboard-widget-notice-read')).toHaveLength(0);
  expect(unknown.querySelectorAll('.dashboard-widget-slot')).toHaveLength(3);
});
test('current info ACK is single-flight across card/details, identity checked, immediate next line updates both without whole-page refresh', async () => {
  const models = await loadProjectCardMessages([source(P)]), renderer = createAggregateRenderer({ messages: () => models }), root = mount(renderer, { sections: ['messages'] });
  await root.querySelector('.dashboard-project-details').onclick(); const modal = dom.node('modal'), detail = modal.querySelector('.dashboard-widget-notice-read');
  let release; intercept = path => path === '/api/host/inbox/action' ? new Promise(resolve => { release = resolve; }) : null;
  const main = root.querySelector('.dashboard-widget-notice-read'), pending = main.onclick(); await detail.onclick();
  expect(requests.filter(row => row.method === 'POST')).toHaveLength(1); expect(detail.disabled).toBe(true); expect(requests.at(-1).body).toEqual({ project_id: P, id: 18, method: 'notice.read', expected_identity: notices.unread[0].sync_identity });
  release(receipt(P, notices.unread[0])); await pending;
  for (const container of [root, modal]) { expect(deepText(container)).toContain('告知 3'); expect(container.querySelectorAll('.project-dashboard-message')[1].href).toBe(`/p/${P}/#notices-17`); expect(container.querySelector('.dashboard-widget-notice-read').disabled).toBe(false); }
});
test('ACK through details while small geometry has detached message nodes is visible when the same project grows again', async () => {
  const models = await loadProjectCardMessages([source(P)]), root = mount(createAggregateRenderer({ messages: () => models }), { sections: ['messages'], geometry: { w: 4, h: 6 } });
  await root.querySelector('.dashboard-project-details').onclick(); await dom.node('modal').querySelector('.dashboard-widget-notice-read').onclick(); closeDialog();
  root.dashboardGeometryChange({ w: 4, h: 10 }); expect(deepText(root)).toContain('告知 3');
  expect(root.querySelectorAll('.project-dashboard-message')[1].href).toContain('notices-17'); expect(root.querySelector('.dashboard-widget-notice-read').disabled).toBe(false);
});
test('known continues beyond the three-record window through one bounded source read, not a whole-page refresh', async () => {
  let live = Array.from({ length: 5 }, (_, i) => notice(18 - i));
  intercept = (path, options, body) => {
    if (path.includes('status=unread')) return Response.json({ notices: live.slice(0, 3), total: live.length, has_more: live.length > 3, cursor: live.slice(0, 3).at(-1)?.id });
    if (path === '/api/host/inbox/action') { const record = live.find(item => item.id === body.id); live = live.filter(item => item.id !== body.id); return receipt(P, record); }
    return null;
  };
  const models = await loadProjectCardMessages([source(P)]), root = mount(createAggregateRenderer({ messages: () => models }), { sections: ['messages'] });
  for (let i = 0; i < 5; i++) { expect(root.querySelectorAll('.project-dashboard-message')[1].href).toContain(`notices-${18 - i}`); await root.querySelector('.dashboard-widget-notice-read').onclick(); }
  expect(deepText(root)).toContain('告知 0'); expect(root.querySelector('.dashboard-widget-notice-read')).toBeNull();
  expect(requests.filter(row => row.path.includes('status=unread'))).toHaveLength(2); expect(requests.filter(row => row.path.includes('status=open'))).toHaveLength(1);
});
test('next-info failure cannot turn an acknowledged read into failure or zero; missing source identity never posts', async () => {
  notices.unread = [notice(18)];
  intercept = path => path.includes('status=unread') ? Response.json({ notices: notices.unread, total: 2, has_more: true, cursor: 18 }) : null;
  const models = await loadProjectCardMessages([source(P)]), root = mount(createAggregateRenderer({ messages: () => models }), { sections: ['messages'] });
  intercept = path => path.includes('status=unread') ? Response.json({ error: 'next failed' }, { status: 503 }) : null;
  await root.querySelector('.dashboard-widget-notice-read').onclick(); expect(deepText(root)).toContain('告知 1'); expect(deepText(root)).toContain('当前已知已确认'); expect(deepText(root)).not.toContain('已知失败');
  root.remove(); const incomplete = structuredClone(models.get(P)); incomplete.groups.unread.notices = [{ ...notice(17), created_at: undefined }];
  const currentModels = new Map([[P, incomplete]]), missing = mount(createAggregateRenderer({ messages: () => currentModels }), { sections: ['messages'] });
  const count = requests.length; expect(missing.querySelector('.dashboard-widget-notice-read').disabled).toBe(true); await missing.querySelector('.dashboard-widget-notice-read').onclick(); expect(requests).toHaveLength(count);
});
test('an ACK whose record fell out of a concurrent fresh window revalidates only that source total', async () => {
  let models = await loadProjectCardMessages([source(P)]), release;
  const renderer = createAggregateRenderer({ messages: () => models }), old = mount(renderer, { sections: ['messages'] });
  intercept = path => path === '/api/host/inbox/action' ? new Promise(resolve => { release = resolve; }) : null;
  const pending = old.querySelector('.dashboard-widget-notice-read').onclick(), snapshot = structuredClone(models.get(P));
  snapshot.groups.unread.notices = [notice(31), notice(30), notice(29)]; snapshot.groups.unread.total = 7; models = new Map([[P, snapshot]]); old.remove(); const fresh = mount(renderer, { sections: ['messages'] });
  intercept = path => path.includes('status=unread') ? Response.json({ notices: snapshot.groups.unread.notices, total: 6, has_more: true, cursor: 29 }) : null;
  release(receipt(P, notice(18))); await pending; expect(deepText(fresh)).toContain('告知 6'); expect(snapshot.groups.unread.total).toBe(6);
});
test('a late next-info response cannot resurrect an info acknowledged from a concurrent replacement view', async () => {
  let models = await loadProjectCardMessages([source(P)]), read18, read31, page;
  const renderer = createAggregateRenderer({ messages: () => models }), old = mount(renderer, { sections: ['messages'] });
  intercept = (path, options, body) => path === '/api/host/inbox/action' ? new Promise(resolve => { if (body.id === 18) read18 = resolve; else read31 = resolve; }) : null;
  const first = old.querySelector('.dashboard-widget-notice-read').onclick(), snapshot = structuredClone(models.get(P));
  snapshot.groups.unread.notices = [notice(31), notice(30), notice(29)]; snapshot.groups.unread.total = 7;
  models = new Map([[P, snapshot]]); old.remove(); const fresh = mount(renderer, { sections: ['messages'] }), second = fresh.querySelector('.dashboard-widget-notice-read').onclick();
  intercept = path => path.includes('status=unread') ? new Promise(resolve => { page = resolve; }) : null;
  read18(receipt(P, notice(18))); await new Promise(setImmediate); read31(receipt(P, notice(31))); await second;
  intercept = path => path.includes('status=unread') ? Response.json({ notices: [notice(30), notice(29)], total: 5, has_more: true, cursor: 29 }) : null;
  page(Response.json({ notices: [notice(31), notice(30), notice(29)], total: 6, has_more: true, cursor: 29 })); await first; await new Promise(setImmediate);
  expect(deepText(fresh)).toContain('告知 5'); expect(fresh.querySelectorAll('.project-dashboard-message')[1].href).toContain('notices-30');
  expect(snapshot.groups.unread.notices.some(item => item.id === 31)).toBe(false);
});
test('same integer notice id is source-isolated and failed/wrong ACK keeps current record; leaving prevents late updates', async () => {
  const models = await loadProjectCardMessages([source(P), source(Q)]), renderer = createAggregateRenderer({ messages: () => models, ownsPage: () => current });
  const p = mount(renderer, { sections: ['messages'] }), q = mount(renderer, { id: Q, sections: ['messages'] });
  intercept = path => path === '/api/host/inbox/action' ? receipt(P, notices.unread[0], { sync_identity: 'f'.repeat(32) }) : null;
  await p.querySelector('.dashboard-widget-notice-read').onclick(); expect(p.querySelectorAll('.project-dashboard-message')[1].href).toContain('notices-18'); expect(deepText(p)).toContain('已知失败');
  intercept = null; await p.querySelector('.dashboard-widget-notice-read').onclick(); expect(p.querySelectorAll('.project-dashboard-message')[1].href).toContain('notices-17'); expect(q.querySelectorAll('.project-dashboard-message')[1].href).toContain('notices-18');
  let release; intercept = path => path === '/api/host/inbox/action' ? new Promise(resolve => { release = resolve; }) : null;
  const pending = q.querySelector('.dashboard-widget-notice-read').onclick(), text = deepText(q); current = false; release(receipt(Q, notices.unread[0])); await pending; expect(deepText(q)).toBe(text);
});
test('concurrent model replacement is updated only for the same record identity, and closed/replaced details cannot submit stale buttons', async () => {
  let models = await loadProjectCardMessages([source(P)]); const renderer = createAggregateRenderer({ messages: () => models }), old = mount(renderer, { sections: ['messages'] });
  let release; intercept = path => path === '/api/host/inbox/action' ? new Promise(resolve => { release = resolve; }) : null;
  const pending = old.querySelector('.dashboard-widget-notice-read').onclick();
  const snapshot = structuredClone(models.get(P)); models = new Map([[P, snapshot]]); old.remove(); const fresh = mount(renderer, { sections: ['messages'] });
  release(receipt(P, notices.unread[0])); await pending; expect(fresh.querySelectorAll('.project-dashboard-message')[1].href).toContain('notices-17'); expect(snapshot.groups.unread.total).toBe(3);
  await fresh.querySelector('.dashboard-project-details').onclick(); const stale = dom.node('modal').querySelector('.dashboard-widget-notice-read');
  void formDialog({ title: 'replacement', content: el('div', 'new') }); const count = requests.length; await stale.onclick(); expect(requests).toHaveLength(count);
});
test('account exceptions and per-source refresh failures stay inside two metric slots; all requested cached content remains accessible at zero capacity', async () => {
  const id2 = A.replace(/^11111111/, '22222222'), config = { widgets: [{ id: 'widget:accounts', type: 'accounts', project_id: null, connection_ids: [A, id2], links: [], sections: ['quota', 'balance', 'history', 'provenance'] }] };
  const connection = { id: A, label: 'partial', enabled: false, observation: { status: 'partial', resources: Array.from({ length: 2 }, (_, i) => ({ id: String(i), kind: 'balance', unit: 'USD', remaining: i + 1 })) } };
  const row = aggregateRows(config, [], [connection])[0], renderer = createAggregateRenderer({ refresh: async () => { throw new Error('refresh failed'); } });
  const root = renderer.render(row, { geometry: { w: 6, h: 16 } }); dom.node('detail').append(root);
  for (const child of root.querySelectorAll('.dashboard-account-card')) { expect(child.querySelector('.dashboard-account-content').children).toHaveLength(1); expect(child.querySelectorAll('.dashboard-account-metric-slot')).toHaveLength(2); }
  expect(deepText(root)).toContain('来源已停用'); expect(deepText(root)).toContain('部分指标可用'); expect(root.querySelectorAll('.dashboard-account-metric')).toHaveLength(2);
  await root.querySelector('.dashboard-account-details').onclick(); expect(dom.node('modal').querySelectorAll('.dashboard-account-metric')).toHaveLength(2); closeDialog();
  root.dashboardGeometryChange({ w: 4, h: 6 }); await root.querySelector('.dashboard-accounts-details').onclick();
  expect(dom.node('modal').querySelectorAll('.dashboard-account-card')).toHaveLength(2); expect(deepText(dom.node('modal'))).toContain('USD'); closeDialog();
  const active = { ...connection, enabled: true, observation: { status: 'available', resources: connection.observation.resources } };
  const fresh = renderer.render(aggregateRows(config, [], [active])[0], { geometry: { w: 6, h: 16 } }); dom.node('detail').append(fresh);
  const source = fresh.querySelector('.dashboard-account-card'); await source.querySelector('.dashboard-account-refresh').onclick();
  expect(deepText(source)).toContain('刷新失败'); expect(source.querySelector('.dashboard-account-content').children).toHaveLength(1); expect(source.querySelectorAll('.dashboard-account-metric-slot')).toHaveLength(2);
  await source.querySelector('.dashboard-account-details').onclick(); expect(dom.node('modal').querySelectorAll('.dashboard-account-metric')).toHaveLength(2);
});
test('selected accounts form one fixed paged quota window with per-source sections/mode, source-specific metric detail and bounded errors', async () => {
  const ids = Array.from({ length: 5 }, (_, i) => A.replace(/^11111111/, String(i).padStart(8, '0')));
  const config = { cards: [], content: [], layout: [], hidden_projects: [], widgets: ids.map((id, i) => ({ id: `widget:account-${i}`, type: 'accounts', project_id: null, connection_ids: [id], links: [], sections: i === 0 ? [] : ['quota', 'balance'] })) };
  const connections = ids.map(id => ({ id, label: '账户'.repeat(200), enabled: true, observation: { status: 'available', resources: Array.from({ length: 4 }, (_, i) => ({ id: `balance-${i}`, kind: 'balance', remaining: i, unit: 'USD', scope: 'account' })) } }));
  const rows = aggregateRows(config, [], connections); expect(rows).toHaveLength(1);
  const renderer = createAggregateRenderer({ refreshAccounts: async () => { throw new Error('bounded failure'); } }), root = renderer.render(rows[0], { mode: 'tiles', geometry: { w: 6, h: 16 } }); dom.node('detail').append(root);
  expect(root.dataset.cardId).toBe('accounts'); expect(root.dataset.accountView).toBe('tiles'); expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(2);
  root.dashboardGeometryChange({ w: 6, h: 17 }); expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(2);
  expect(root.querySelectorAll('.dashboard-account-card')[0].querySelectorAll('.dashboard-account-metric')).toHaveLength(0);
  await next(root).onclick(); expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(2); expect(root.querySelectorAll('.dashboard-account-metric')).toHaveLength(4);
  await root.querySelector('.dashboard-account-details').onclick(); expect(dom.node('modal').querySelectorAll('.dashboard-account-metric')).toHaveLength(4); closeDialog();
  const footer = root.querySelector('.dashboard-widget-pagination'); await root.querySelector('.dashboard-accounts-refresh').onclick();
  expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(2); expect(deepText(footer)).toContain('bounded failure');
  const anchor = root.querySelector('.dashboard-account-card').dataset.connectionId; root.dashboardGeometryChange({ w: 4, h: 10 });
  expect(root.querySelectorAll('.dashboard-widget-slot')).toHaveLength(1); expect(root.querySelector('.dashboard-account-card').dataset.connectionId).toBe(anchor); expect(root.querySelector('.dashboard-widget-pagination')).toBe(footer);
});
