import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { ui, resetUiState, transcriptCache, transcriptOpen } from '../../src/ui/web/assets/state.js';
import { renderTree, refreshTreeTimes } from '../../src/ui/web/assets/render-tree.js';
import { refresh, liveRefresh, initRefreshPolling } from '../../src/ui/web/assets/refresh.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { action } from '../../src/ui/web/assets/api.js';
import { initContextReferences } from '../../src/ui/web/assets/context-references.js';
import { readPref, setPref } from '../../src/ui/web/assets/prefs.js';
import { resetNoticeNotifier } from '../../src/ui/web/assets/notice-notifications.js';

const world = makeWorld();
let intercept, calls, cleanup, restoreNavigation;
const dom = installDom({ fetch: (url, options) => { calls.push(String(url)); return intercept?.(url, options) ?? world.fetchImpl(url, options); } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const row = id => dom.node('tasks').querySelector(`[data-id="${id}"]`);
const task = (id, extra = {}) => ({ id, worker_number: `W42-${id}`, role: 'agent', goal: `goal ${id}`, status: 'running', integration: 'none',
  updated_at: new Date(Date.now() - 10000).toISOString(), ...extra });
const data = tasks => ({ tasks, notices: [], status: { project: '/tmp/demo', concurrency: 2 } });
const paint = snapshot => { ui.lastSnapshot = snapshot; renderTree(snapshot); };
const open = (id, status = 'running') => {
  ui.selected = id; ui.view = { id: 'worker', key: id }; ui.transcriptView = { taskId: id };
  ui.lastSnapshot = data([task(id, { status })]);
  const cache = { steps: [{ seq: 1 }], next: 1, order: 'asc', settled: false };
  transcriptCache.set(id, cache); transcriptOpen.add(id); return cache;
};

beforeEach(() => {
  resetUiState(); dom.node('tasks').replaceChildren(); dom.node('detail').replaceChildren();
  dom.document.hidden = false; dom.document.activeElement = null; dom.setSelection(''); intercept = null; calls = [];
  cleanup = initRefreshPolling();
  restoreNavigation = registerNavigation({ refresh: () => refresh({ force: true }), detail: async () => true, overview: async () => {} });
});
afterEach(() => { cleanup(); restoreNavigation(); });
afterAll(() => {
  // Leave the cached module usable for older boot fixtures that do not yet wire the lifecycle seam.
  initRefreshPolling(); dom.restore();
});

test('keyed rows retain all reading nodes, focus, selection and reference target on unrelated changes', () => {
  const first = task(1), second = task(2);
  paint(data([first, second]));
  const node = row(1), children = [...node.children], rowChildren = [...node.children[0].children];
  node.focus(); dom.setSelection('goal 1');
  paint(data([{ ...first }, { ...second, display_title: 'changed elsewhere', status: 'completed' }]));
  expect(row(1)).toBe(node); expect(node.children).toEqual(children); expect(node.children[0].children).toEqual(rowChildren);
  expect(dom.document.activeElement).toBe(node); expect(dom.window.getSelection().toString()).toBe('goal 1');
  expect(node.dataset.ref).toContain('task-1'); expect(node.dataset.id).toBe(1);
  expect(deepText(row(2))).toContain('changed elsewhere');
});

test('status/title/role/route/dependency/progress/reference fields patch despite unchanged updated_at', () => {
  const first = task(1, { status: 'paused', agent_wakes: 0 }); paint(data([first]));
  const node = row(1), goal = node.querySelector('.goal'), when = node.querySelector('.when');
  expect(deepText(node)).toContain('待开始');
  paint(data([{ ...first, agent_wakes: 1 }])); expect(deepText(node)).toContain('已暂停');
  const next = { ...first, status: 'running', display_title: 'renamed', role: 'research', route: true,
    goal: 'new source goal', integration: 'conflict', interrupt_state: 'requested',
    deps: [{ id: 2, worker_number: 'W42-2', kind: 'code', status: 'running' }],
    progress: { completed: 1, total: 2, current: { key: 'test', label: 'test label', work_ms: 7000, active_since: new Date().toISOString() } } };
  paint(data([next]));
  expect(row(1)).toBe(node); expect(node.querySelector('.goal')).toBe(goal); expect(node.querySelector('.when')).toBe(when);
  for (const text of ['renamed', '中断请求中', '调研', '快速路由', 'W42-2', 'test label', '1/2', '冲突待处理']) expect(deepText(node)).toContain(text);
  expect(node.title).toContain('new source goal'); expect(node.dataset.ref).toContain('task-1');
  const progress = node.querySelector('.task-progress-compact');
  paint(data([{ ...next, updated_at: new Date().toISOString() }]));
  expect(node.querySelector('.task-progress-compact')).toBe(progress);
  ui.lastSnapshot.status.settings = { progress_reporting: { value: false } }; renderTree(ui.lastSnapshot);
  expect(node.querySelector('.task-progress-compact')).toBeNull();
});

test('waiting parent derives all child statuses; concurrency and parent number changes are dependencies', () => {
  const parent = task(1, { status: 'waiting' }), child = task(2, { parent_id: 1 });
  ui.filters.tasks.text = 'goal 1'; paint(data([parent, child]));
  const node = row(1), goal = node.querySelector('.goal');
  expect(deepText(node)).toContain('1 个在跑 · 1 个未结束');
  paint(data([parent, { ...child, status: 'completed' }]));
  expect(deepText(node)).toContain('0 个在跑 · 0 个未结束'); expect(node.querySelector('.goal')).toBe(goal);
  paint({ ...data([{ ...parent, status: 'queued' }]), status: { concurrency: 9 } });
  expect(deepText(node)).toContain('上限 9');
  paint(data([{ ...parent, status: 'awaiting_acceptance', task_kind: 'child', parent_id: 99, parent_worker_number: 'W42' }]));
  expect(deepText(node)).toContain('W42 确认');
});

test('sort/filter/context updates reorder only keyed rows and selected class, independent clocks reuse nodes', () => {
  const a = task(1), b = task(2); paint(data([a, b]));
  const node = row(1), goal = node.querySelector('.goal'), when = node.querySelector('.when');
  ui.selected = 1; ui.sidebarSortMode = 'id'; paint(data([a, b]));
  expect(row(1)).toBe(node); expect(node.classList.contains('selected')).toBe(true); expect(node.querySelector('.goal')).toBe(goal);
  const oldNow = Date.now; Date.now = () => oldNow() + 70000;
  try { refreshTreeTimes(); expect(when.textContent).toContain('分钟前'); expect(node.querySelector('.when')).toBe(when); }
  finally { Date.now = oldNow; }
  ui.filters.tasks.text = 'goal 1'; paint(data([a, b])); expect(row(1)).toBe(node); expect(row(2)).toBeNull();
});

test('hidden polling stops reads; visibility resumes promptly, duplicate setup and cleanup are safe', async () => {
  await refresh(); const cache = open(1); const before = calls.length;
  dom.document.hidden = true; await refresh(); await liveRefresh(); expect(calls.length).toBe(before);
  cleanup = initRefreshPolling(); cleanup = initRefreshPolling();
  expect(dom.listeners.visibilitychange).toHaveLength(1);
  dom.document.hidden = false; await dom.fire('visibilitychange'); expect(calls.length).toBeGreaterThan(before);
  expect(cache.next).toBeGreaterThan(1);
  cleanup(); expect(dom.listeners.visibilitychange).toHaveLength(0);
  const stopped = calls.length; await dom.fire('visibilitychange'); await refresh(); expect(calls.length).toBe(stopped);
});

test('hidden tabs preserve enabled system notices, without detail, Git or transcript reads', async () => {
  const original = globalThis.Notification, secure = globalThis.isSecureContext;
  const preference = readPref('noticeNotifications'), delivered = [];
  globalThis.Notification = class {
    static permission = 'granted';
    constructor(title, options) { delivered.push(options.body); }
    close() {}
  };
  globalThis.isSecureContext = true;
  setPref('noticeNotifications', true); resetNoticeNotifier();
  try {
    await refresh();
    const snapshot = ui.lastSnapshot;
    intercept = url => String(url).startsWith('/api/overview') ? Response.json({ ...snapshot, revision: 'background-new',
      notices: [...snapshot.notices, { id: 10001, task_id: 1, kind: 'question', status: 'open',
        title: 'background notice', created_at: new Date().toISOString() }] }) : null;
    ui.selected = 1; ui.selectedRevision = null; ui.detailRenderedAt = 0;
    dom.document.hidden = true;
    const before = calls.length;
    await refresh(); await liveRefresh();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(calls.slice(before)).toHaveLength(1);
    expect(calls.at(-1)).toContain('/api/overview');
    expect(delivered).toContain('background notice');
    setPref('noticeNotifications', false);
    const stopped = calls.length; await refresh(); expect(calls.length).toBe(stopped);
  } finally {
    setPref('noticeNotifications', preference); resetNoticeNotifier();
    globalThis.Notification = original; globalThis.isSecureContext = secure;
    dom.document.hidden = false;
  }
});

test('visibility resume starts log reading without waiting for a slow overview', async () => {
  const cache = open(1), overview = deferred(), logStarted = deferred();
  intercept = url => String(url).startsWith('/api/overview') ? overview.promise
    : /\/transcript(?:-latest)?\?/.test(String(url)) ? (logStarted.resolve(), Response.json({ steps: [{ seq: 2, kind: 'text', body: 'resumed' }], next: 2 }))
    : String(url).endsWith('/usage') ? Response.json({ last: null }) : null;
  const resuming = dom.fire('visibilitychange'); await logStarted.promise;
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(cache.next).toBe(2); expect(ui.busy).toBe(true);
  overview.resolve(Response.json({ unchanged: true })); await resuming;
});

test('overview revision unchanged preserves rows but patches relative times', async () => {
  await refresh(); ui.lastSnapshot.revision = 'r1'; const node = row(1), goal = node.querySelector('.goal'), when = node.querySelector('.when');
  const oldNow = Date.now; Date.now = () => oldNow() + 70000;
  intercept = url => { expect(url).toContain('revision=r1'); return Response.json({ unchanged: true, revision: 'r1' }); };
  try { await refresh(); expect(row(1)).toBe(node); expect(node.querySelector('.goal')).toBe(goal); expect(when.textContent).toContain('分钟前'); }
  finally { Date.now = oldNow; }
});

test('failure backoff skips automatic retry but explicit hidden action ACK refresh bypasses it', async () => {
  await refresh(); ui.lastSnapshot.revision = 'r1';
  let fail = true;
  intercept = url => String(url).startsWith('/api/overview') ? (fail ? Promise.reject(new Error('offline fixture')) : Response.json({ unchanged: true })) : null;
  await refresh(); expect(ui.offline).toBe(true); const failedCalls = calls.length;
  await refresh(); expect(calls.length).toBe(failedCalls);
  fail = false; dom.document.hidden = true; await action('fixture.noop', {});
  expect(calls.length).toBeGreaterThan(failedCalls); expect(ui.offline).toBe(false);
  dom.document.hidden = false; await refresh(); expect(calls.length).toBeGreaterThan(failedCalls + 2);
});

test('automatic overview polling retries once the failure backoff expires and keeps normal cadence after success', async () => {
  await refresh(); ui.lastSnapshot.revision = 'r1'; let fail = true;
  intercept = url => String(url).startsWith('/api/overview') ? (fail ? Promise.reject(new Error('offline fixture')) : Response.json({ unchanged: true })) : null;
  await refresh(); const count = calls.length; fail = false;
  await refresh(); expect(calls.length).toBe(count);
  const oldNow = Date.now; Date.now = () => oldNow() + 30001;
  try { await refresh(); expect(calls.length).toBe(count + 1); expect(ui.offline).toBe(false);
    await refresh(); expect(calls.length).toBe(count + 2); }
  finally { Date.now = oldNow; }
});

test('reference descriptors update original goal/status/number without rebuilding the source row', async () => {
  initContextReferences();
  const a = task(1); paint(data([a])); const node = row(1);
  paint(data([{ ...a, worker_number: 'W71-8', goal: 'changed original goal', status: 'waiting' }]));
  await dom.fire('contextmenu', { target: node, clientX: 1, clientY: 1, preventDefault() {} });
  await findByText(dom.node('context-menu'), '引用：Worker W71-8').onclick();
  expect(ui.composerReferences[0]).toMatchObject({ label: 'Worker W71-8', target: { task_id: 1 }, location: { view: 'task-tree', task_id: 1 } });
  expect(ui.composerReferences[0].quote).toContain('changed original goal'); expect(ui.composerReferences[0].quote).toContain('状态：等子 Worker');
  expect(row(1)).toBe(node);
});

test('explicit refresh/visibility event queues behind an in-flight auto read rather than being swallowed', async () => {
  await refresh(); ui.lastSnapshot.revision = 'r1'; const pending = deferred(); let reads = 0;
  intercept = url => String(url).startsWith('/api/overview') ? (++reads === 1 ? pending.promise : Response.json({ unchanged: true })) : null;
  const auto = refresh(); const explicit = refresh({ force: true }); const resumed = dom.fire('visibilitychange');
  pending.resolve(Response.json({ unchanged: true })); await Promise.all([auto, explicit, resumed]); expect(reads).toBe(2);
});

test('slow stats do not hold subsequent cursor ticks and same-Worker usage remains single-flight', async () => {
  const cache = open(1), usage = deferred(); let sequence = 1, stats = 0;
  intercept = url => {
    if (String(url).endsWith('/usage')) { stats++; return usage.promise; }
    if (/\/transcript(?:-latest)?\?/.test(String(url))) return Response.json({ steps: [{ seq: ++sequence, kind: 'text', body: 'fresh log' }], next: sequence });
  };
  await liveRefresh(); expect(cache.next).toBe(2); expect(ui.liveBusy).toBe(false);
  await liveRefresh(); expect(cache.next).toBe(3); expect(stats).toBe(1);
  usage.resolve(Response.json({ last: null })); await usage.promise; await Promise.resolve();
});

test('switching Worker invalidates late transcript/usage and does not block the new Worker', async () => {
  const oldCache = open(1), page = deferred(), usage = deferred();
  intercept = url => {
    if (String(url).includes('/worker/1/usage')) return usage.promise;
    if (/\/worker\/1\/transcript(?:-latest)?\?/.test(String(url))) return page.promise;
    if (String(url).includes('/usage')) return Response.json({ last: null });
    if (/\/transcript(?:-latest)?\?/.test(String(url))) return Response.json({ steps: [{ seq: 2, kind: 'text', body: 'worker 2' }], next: 2 });
  };
  const old = liveRefresh(); await Promise.resolve(); const next = open(2); await liveRefresh(); expect(next.next).toBe(2);
  page.resolve(Response.json({ steps: [{ seq: 2 }], next: 2 })); usage.resolve(Response.json({ last: null }));
  await old; expect(oldCache.next).toBe(1); expect(next.next).toBe(2);
});

test('terminal reader retries failures, does not settle a losing cursor, and drains final partial page', async () => {
  const cache = open(1, 'completed'); let fail = true, partial = true;
  intercept = url => {
    if (String(url).startsWith('/api/overview')) return Response.json({ unchanged: true });
    if (String(url).endsWith('/usage')) return Promise.reject(new Error('stats failure'));
    if (/\/transcript(?:-latest)?\?/.test(String(url))) {
      if (fail) return Promise.reject(new Error('tail offline'));
      return Response.json({ steps: [{ seq: cache.next + 1, kind: 'text', body: 'tail' }], next: cache.next + 1, has_more: partial });
    }
  };
  await liveRefresh(); expect(cache.settled).toBe(false); const count = calls.length;
  await liveRefresh(); expect(calls.length).toBe(count);
  fail = false; await dom.fire('visibilitychange'); expect(cache.next).toBe(2); expect(cache.settled).toBe(false);
  partial = false; await liveRefresh(); expect(cache.next).toBe(3); expect(cache.settled).toBe(true);
  const settledCalls = calls.length; await liveRefresh(); expect(calls.length).toBe(settledCalls);
});

test('terminal live/manual cursor race leaves settlement pending until a successful non-competing tail', async () => {
  const cache = open(1, 'completed'), page = deferred();
  intercept = url => /\/transcript(?:-latest)?\?/.test(String(url)) ? page.promise
    : String(url).endsWith('/usage') ? Response.json({ last: null }) : null;
  const tick = liveRefresh(); cache.steps.push({ seq: 2 }); cache.next = 2;
  page.resolve(Response.json({ steps: [{ seq: 2 }], next: 2 })); await tick;
  expect(cache.steps.map(step => step.seq)).toEqual([1, 2]); expect(cache.settled).toBe(false);
  intercept = url => /\/transcript(?:-latest)?\?/.test(String(url)) ? Response.json({ steps: [], next: 2 })
    : String(url).endsWith('/usage') ? Response.json({ last: null }) : null;
  await liveRefresh(); expect(cache.settled).toBe(true);
});

test('unchanged render allocates no new nodes, including pagination; projection timestamps do not rebuild compact progress', () => {
  const a = task(1, { progress: { completed: 1, total: 2, updated_at: 'old', current: { label: 'step', work_ms: 4000 } } });
  const snapshot = { ...data([a]), task_page: { total: 20, active: 1, shown: 10, historical: 19, has_more: true, cursor: 10 } };
  paint(snapshot); const node = row(1), progress = node.querySelector('.task-progress-compact'), paging = dom.node('tasks').querySelector('.task-pagination');
  const createElement = dom.document.createElement; let created = 0;
  dom.document.createElement = tag => { created++; return createElement(tag); };
  try { paint({ ...snapshot, tasks: [{ ...a, progress: { ...a.progress, updated_at: 'new' } }] }); }
  finally { dom.document.createElement = createElement; }
  expect(created).toBe(0); expect(node.querySelector('.task-progress-compact')).toBe(progress);
  expect(dom.node('tasks').querySelector('.task-pagination')).toBe(paging);
});

test('pagination uses the newest snapshot and discards responses from a previous boot/project scope', async () => {
  const page = { total: 20, active: 1, shown: 10, historical: 19, has_more: true, cursor: 10 };
  paint({ ...data([task(1)]), task_page: page }); const pending = deferred();
  intercept = url => String(url).startsWith('/api/workers?') ? pending.promise : null;
  const loading = findByText(dom.node('tasks'), '加载更早 50 个').onclick();
  paint({ ...data([task(1, { display_title: 'latest snapshot' })]), task_page: page });
  pending.resolve(Response.json({ tasks: [task(9)], cursor: 9, has_more: false })); await loading;
  expect(deepText(row(1))).toContain('latest snapshot'); expect(row(9)).toBeTruthy();
  paint({ ...data([task(1)]), task_page: page }); const stale = deferred();
  intercept = url => String(url).startsWith('/api/workers?') ? stale.promise : null;
  const old = findByText(dom.node('tasks'), '加载更早 50 个').onclick();
  resetUiState(); paint(data([task(2)]));
  stale.resolve(Response.json({ tasks: [task(99)], cursor: 99, has_more: false })); await old;
  expect(row(99)).toBeNull(); expect(row(2)).toBeTruthy(); expect(ui.taskHistory).toEqual([]);
});

test('reorder restores surviving keyboard focus and directional selection when native insertion drops them', () => {
  const a = task(1), b = task(2); ui.sidebarSortMode = 'id'; paint(data([a, b]));
  const node = row(1), goal = node.querySelector('.goal'); node.focus();
  const selection = { anchorNode: goal, anchorOffset: 1, focusNode: goal, focusOffset: 3,
    setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) { Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset }); } };
  const getSelection = dom.window.getSelection; dom.window.getSelection = () => selection;
  const container = dom.node('tasks'), insert = container.insertBefore;
  container.insertBefore = function (...args) {
    dom.document.activeElement = null; selection.anchorNode = null; selection.focusNode = null;
    return insert.apply(this, args);
  };
  try {
    ui.sidebarSortMode = 'smart'; paint(data([{ ...a, status: 'running' }, { ...b, status: 'failed' }]));
    expect(dom.document.activeElement).toBe(node); expect(selection.anchorNode).toBe(goal); expect(selection.focusNode).toBe(goal);
    expect(selection.anchorOffset).toBe(1); expect(selection.focusOffset).toBe(3);
  } finally { container.insertBefore = insert; dom.window.getSelection = getSelection; }
});

test('compact progress signatures cover runtime work/wait projections and unknown timing without losing the goal', () => {
  const a = task(1), goalText = 'step'; let current = { label: goalText, work_ms: 1000, active_since: new Date().toISOString() };
  const render = () => paint(data([{ ...a, progress: { completed: 0, total: 2, current } }]));
  render(); const node = row(1), goal = node.querySelector('.goal');
  for (const patch of [{ work_ms: 9000 }, { active_since: null }, { kind: 'wait', wait_ms: 12000, waiting_since: new Date().toISOString() },
    { waiting_since: null }, { timing_unknown: true }, { label: 'new step' }]) {
    const previous = node.querySelector('.task-progress-compact'); current = { ...current, ...patch }; render();
    expect(node.querySelector('.task-progress-compact')).not.toBe(previous); expect(node.querySelector('.goal')).toBe(goal);
  }
  expect(deepText(node)).toContain('用时未知'); expect(deepText(node)).toContain('new step');
});

test('boot lifecycle discards a delayed old snapshot and never releases a newer refresh lock', async () => {
  const oldPage = deferred(); intercept = url => String(url).startsWith('/api/overview') ? oldPage.promise : null;
  const old = refresh(); resetUiState(); cleanup = initRefreshPolling();
  const nextPage = deferred(); intercept = url => String(url).startsWith('/api/overview') ? nextPage.promise : null;
  const next = refresh(); oldPage.resolve(Response.json({ tasks: [task(99)], notices: [], status: { project: '/tmp/old' } }));
  await old; expect(ui.lastSnapshot).toBeNull(); expect(ui.busy).toBe(true);
  nextPage.resolve(await world.fetchImpl('/api/snapshot')); await next; expect(ui.busy).toBe(false); expect(row(99)).toBeNull();
});
