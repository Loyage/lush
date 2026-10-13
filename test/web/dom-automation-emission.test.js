import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText } from './project-dom.js';
import { until } from '../helpers.js';

const json = value => ({ ok: true, json: async () => structuredClone(value) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const draft = (id, extra = {}) => ({ kind: 'draft', id, content: `conditional ${id}`, created_at: '2026-01-01T00:00:00Z',
  revision: 2, status: 'draft', parent_id: 1, branch: 'main', mode: 'order', conditions: [{ kind: 'parent_quiet' }], exclusive: false,
  merge_status: 'none', references: [], ...extra });
let rows, intercept, nextCursor, page, owned;
const calls = [], reads = [];
const dom = installDom({ fetch: async (url, options = {}) => {
  const route = new URL(String(url), 'http://localhost'); const body = options.body && JSON.parse(options.body);
  const hit = intercept?.(route, body); if (hit) return hit;
  if (body) {
    calls.push(body);
    const old = rows.find(item => item.id === (body.params.id ?? body.params.draft_id));
    if (body.method === 'draft.update') { Object.assign(old, body.params, { revision: old.revision + 1, ...(body.params.branch ? { parent_id: body.params.branch === 'feature' ? 2 : 1 } : {}) }); return json(old); }
    if (body.method === 'input.emit') { old.dispatch = { state: 'waiting_conditions' }; return json({ emitted: true, draft_id: old.id, revision: old.revision, dispatch: old.dispatch }); }
    throw Error(`unexpected write ${body.method}`);
  }
  reads.push(route);
  if (route.pathname === '/api/inputs') {
    const query = route.searchParams;
    return json({ items: rows.filter(item => (query.get('conditional') !== 'mounted' || item.dispatch)
      && item.content.includes(query.get('q') || '') && (!query.get('cursor') || item.id > 1)), next_cursor: query.get('cursor') ? null : nextCursor });
  }
  if (route.pathname === '/api/workers') return json({ tasks: [{ id: 10, worker_number: 'W9' }, { id: 20, worker_number: 'W8' }], has_more: false });
  if (route.pathname === '/api/input-parents') return json({ items: [{ id: 1, worker_number: 'W1', branch: 'main' }, { id: 2, worker_number: 'W2', branch: 'feature' }] });
  const match = route.pathname.match(/^\/api\/input\/draft\/(\d+)$/);
  if (match) return json(rows.find(item => item.id === Number(match[1])));
  throw Error(`unexpected read ${route}`);
} });
const { renderEmissionAutomation } = await import('../../src/ui/web/assets/automation-emission.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { openProjectAutomation } = await import('../../src/ui/web/assets/render-project-automation.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const button = (label, root = page) => root.querySelectorAll('button').find(node => node.textContent === label);
const active = () => [...page.children].find(node => !node.hidden);
const open = async id => active().querySelector(`[data-input="draft:${id}"]`).querySelector('.input-row').onclick();
const panel = () => active().querySelector('.input-detail');
const start = async () => { page = renderEmissionAutomation({ ownsPage: () => owned, catalogue: {} }); await page.ready; };
beforeEach(() => { page?.dispose(); activateDetailView({ view: 'overview' }); rows = [draft(1)]; calls.length = reads.length = 0; nextCursor = null; intercept = null; owned = true; dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; dom.location.hash = '#project-automation'; });
afterAll(() => { page?.dispose(); ui.disposeProjectAutomation?.(); dom.restore(); });

test('feature is embeddable, uses server-scoped conditional pagination, and never claims a loaded fragment is the full library', async () => {
  nextCursor = 'server-cursor'; const view = ui.view, detail = dom.node('detail').children.slice();
  await start();
  expect(reads[0].searchParams.get('conditional')).toBe('configured'); expect(reads[0].searchParams.has('status')).toBe(false);
  expect(deepText(active())).toContain('可继续加载');
  rows.push(draft(2)); await button('加载更多').onclick();
  expect(reads.at(-1).searchParams.get('cursor')).toBe('server-cursor');
  expect(active().querySelectorAll('.input-record')).toHaveLength(2); expect(deepText(active())).toContain('已全部加载');
  await open(1);
  expect(panel().querySelector('textarea')).toBeTruthy();
  expect(ui.view).toBe(view); expect(dom.node('detail').children).toEqual(detail); expect(dom.location.hash).toBe('#project-automation');
  await button('← 返回条件输入列表').onclick();
  await page.setSubpage('history'); expect(reads.at(-1).searchParams.get('conditional')).toBe('mounted');
  expect(deepText(active())).toContain('没有符合条件');
  await page.setSubpage('invalid'); expect(reads.at(-1).searchParams.get('conditional')).toBe('configured');
});

test('shared editor saves revision/body/parent/conditions/exclusivity and consumes reliable ACK without leaving the feature', async () => {
  await start(); await open(1);
  const content = panel().querySelector('textarea'); content.value = 'edited'; content.oninput();
  const parent = panel().querySelector('[aria-label="草稿父 Worker"]'); parent.value = '2'; parent.onchange();
  const conditions = panel().querySelector('.emission-conditions'); expect(conditions.hidden).toBe(true);
  await button('执行条件设置 · 1 项').onclick(); expect(conditions.hidden).toBe(false);
  const checks = conditions.querySelectorAll('input').filter(node => node.type === 'checkbox');
  checks[1].checked = true; checks[1].onchange();
  await button('保存').onclick();
  expect(calls[0]).toMatchObject({ method: 'draft.update', params: { id: 1, content: 'edited', branch: 'feature', expected_revision: 2, exclusive: true, conditions: [{ kind: 'parent_quiet' }] } });
  const emit = button('按条件提交'); expect(emit.classList.contains('agent-call')).toBe(true); expect(emit.getAttribute('data-help')).toContain('token');
  await emit.onclick();
  expect(calls[1]).toMatchObject({ method: 'input.emit', params: { draft_id: 1, expected_revision: 3 } });
  expect(calls[1].params.client_request_id).toBeTruthy(); expect(panel().querySelector('textarea')).toBeNull();
  expect(deepText(panel())).toContain('不代表 Worker 已创建'); expect(dom.location.hash).toBe('#project-automation');
  rows[0].dispatch = { state: 'succeeded', input_id: 42, worker_id: 90, worker_number: 'W42' };
  await button('刷新提交状态').onclick();
  expect(reads.at(-2).pathname).toBe('/api/input/draft/1');
  expect(deepText(panel())).toContain('查看已创建原文 O42'); expect(deepText(panel())).toContain('W42');
  expect(dom.location.hash).toBe('#project-automation');
});

test('history shows exact waiting/dispatching/failed/unknown and append Message/A receipts, without generating Order identity', async () => {
  rows = ['waiting_conditions','dispatching','failed','unknown','succeeded'].map((state, index) => draft(index + 1, { mode: 'append', target_id: 10, target_worker_number: 'W9',
    dispatch: { state, ...(state === 'succeeded' ? { message_id: 55, append_number: 'A9-1' } : {}) } }));
  await start(); await page.setSubpage('history');
  for (let index = 0; index < rows.length; index++) {
    await open(index + 1); expect(panel().querySelector('textarea')).toBeNull();
    expect(button('提交指令')).toBeUndefined(); expect(button('撤销提交')).toBeUndefined();
    if (index === 4) { expect(deepText(panel())).toContain('追加消息 #55 · A9-1'); expect(deepText(panel())).not.toContain('O55'); expect(deepText(panel())).not.toContain('O9'); }
    await button('← 返回条件输入列表').onclick();
  }
  expect(calls).toHaveLength(0);
});

test('append settings edit the explicit target and retain the same retry identity; unknown receipt never auto-replays', async () => {
  rows = [draft(1, { mode: 'append', target_id: 10, target_worker_number: 'W9' })]; await start(); await open(1);
  const picker = panel().querySelector('.emission-worker-picker'); await button('加载 Worker', picker).onclick();
  picker.querySelector('select').value = '20'; picker.querySelector('select').onchange();
  await button('保存').onclick(); expect(calls[0].params).toMatchObject({ mode: 'append', target_id: 20, expected_revision: 2 });
  const failedRequests = [];
  intercept = (route, body) => {
    if (body?.method !== 'input.emit') return null;
    failedRequests.push(body);
    return failedRequests.length === 1 ? Promise.resolve({ ok: false, json: async () => ({ error: 'network uncertain' }) })
      : Promise.resolve(json({ emitted: true, draft_id: 1, revision: 3, dispatch: { state: 'unknown', reason: 'inspect before replay' } }));
  };
  await button('按条件提交').onclick(); expect(panel().querySelector('textarea')).toBeTruthy();
  await button('按条件提交').onclick();
  expect(failedRequests[1].params.client_request_id).toBe(failedRequests[0].params.client_request_id);
  expect(panel().querySelector('textarea')).toBeNull(); expect(button('按条件提交')).toBeUndefined();
  expect(deepText(panel())).toContain('不会自动重放'); expect(deepText(panel())).not.toContain('O20');
  expect(failedRequests).toHaveLength(2);
});

test('tab switches retain local draft and in-flight saving does not strand the editor busy', async () => {
  await start(); await open(1); const content = panel().querySelector('textarea'); content.value = 'retained'; content.oninput();
  const delayed = deferred(); intercept = (route, body) => body?.method === 'draft.update' ? delayed.promise : null;
  const saving = button('保存').onclick();
  await page.setSubpage('history');
  delayed.resolve(json(draft(1, { content: 'retained', revision: 3 }))); await saving;
  await page.setSubpage('settings');
  expect(panel().querySelector('textarea')).toBe(content); expect(content.value).toBe('retained'); expect(content.disabled).toBe(false);
});

for (const subpage of ['settings', 'history']) test(`retired conditional feature ${subpage} route opens input browser, never project automation or history`, async () => {
  ui.inputsPage = null;
  await openProjectAutomation({ feature: 'emission', subpage });
  expect(dom.location.hash).toBe('#inputs');
  expect(dom.node('detail').querySelector('.inputs-page')).toBeTruthy();
  expect(dom.node('detail').querySelector('.automation-emission')).toBeNull();
  expect(reads.filter(route => route.pathname === '/api/inputs')).toHaveLength(1);
  expect(calls).toHaveLength(0);
});

test('failed refresh retains records; disposed, lost ownership or cross-project late responses never repaint or issue follow-up writes', async () => {
  await start();
  intercept = route => route.pathname === '/api/inputs' ? Promise.resolve({ ok: false, json: async () => ({ error: 'offline' }) }) : null;
  await button('刷新列表').onclick(); expect(active().querySelectorAll('.input-record')).toHaveLength(1); expect(deepText(active())).toContain('读取失败');
  for (const leave of ['dispose','owner','project']) {
    page.dispose(); intercept = null; owned = true; dom.location.pathname = '/p/aaaaaaaaaaaaaaaa/'; await start();
    const delayed = deferred(); intercept = route => route.pathname === '/api/input/draft/1' ? delayed.promise : null;
    const opening = open(1); const before = deepText(panel());
    if (leave === 'dispose') page.dispose(); else if (leave === 'owner') owned = false; else dom.location.pathname = '/p/bbbbbbbbbbbbbbbb/';
    delayed.resolve(json(draft(1, { content: 'late from old project' }))); await opening;
    expect(deepText(panel())).toBe(before); expect(panel().querySelector('textarea')).toBeNull();
  }
  expect(calls).toHaveLength(0);
});
