import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { createProjectBoard, PROJECT_BOARD_ORDER_KEY } from '../../src/ui/web/assets/project-board.js';

const ids = Array.from({ length: 5 }, (_, index) => String(index + 1).repeat(16));
const rows = ids.map((id, index) => ({ id, name: `项目 ${index + 1}`, running: index === 0 }));
let dom;
beforeEach(() => { dom = installDom(); });
afterEach(() => dom.restore());
function renderCard(row) {
  const item = document.createElement('li'), link = document.createElement('a');
  link.textContent = row.name; link.href = `/p/${row.id}/`; link.target = '_blank';
  link.className = 'project-open'; item.append(link); return item;
}
function board(options = {}) {
  return createProjectBoard({ renderCard, request: async url => ({ id: url.split('/')[4], appearance: null }), ...options });
}
const order = component => component.root.children.map(item => item.dataset.projectId);
const handle = item => item.querySelector('.project-board-handle');
function key(item, value, extras = {}) {
  let prevented = false;
  handle(item).onkeydown({ key: value, preventDefault() { prevented = true; }, ...extras });
  return prevented;
}
function pointer(item, type, extras = {}) {
  let prevented = false;
  handle(item)[`onpointer${type}`]({ pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 20, clientY: 20,
    preventDefault() { prevented = true; }, ...extras });
  return prevented;
}
function dropTarget(item) {
  item.closest = () => item; item.getBoundingClientRect = () => ({ top: 40, height: 100 });
  document.elementFromPoint = () => item;
}

test('pure ul displays caller links and GETs only existing colors without storage writes', async () => {
  const calls = [];
  const component = board({ request: async (url, options) => {
    calls.push({ url, options });
    return { id: url.split('/')[4], appearance: calls.length === 1 ? { version: 1, color: 'rose', revision: 'r1' } : null };
  } });
  await component.update(rows.slice(0, 2));
  expect(component.root.tagName).toBe('UL'); expect(component.root.className).toBe('project-board');
  expect(order(component)).toEqual(ids.slice(0, 2));
  expect(component.root.children[0].dataset.boardColor).toBe('rose');
  expect(component.root.children[1].dataset.boardColor).toBeUndefined();
  expect(deepText(component.root)).toContain('尚未设置辨识色');
  expect(calls).toEqual(ids.slice(0, 2).map(id => ({ url: `/api/host/projects/${id}/appearance`, options: { method: 'GET' } })));
  expect(localStorage.getItem(PROJECT_BOARD_ORDER_KEY)).toBeNull();
  expect(component.root.querySelector('a').onclick).toBeUndefined();
  expect(component.root.querySelector('a').target).toBe('_blank');
  for (const item of component.root.children) {
    expect(handle(item).getAttribute('data-help')).toContain('不修改项目');
    expect(handle(item).getAttribute('aria-describedby')).toBeTruthy();
    expect(item.getAttribute('aria-setsize')).toBe('2');
  }
});

test('mixed stable card ids share saved order and only genuine project rows request appearance', async () => {
  const accountId = 'account:01234567-89ab-cdef-0123-456789abcdef';
  const account = { id: accountId, type: 'account', name: '账户余额' };
  const note = { id: 'note:release-1', type: 'note', name: '发布提示' };
  const explicitAccount = { id: ids[2], type: 'account', name: '使用十六进制身份的账户' };
  const calls = [];
  const options = { request: async url => { calls.push(url); return { id: url.split('/')[4], appearance: { version: 1, color: 'teal' } }; } };
  const component = board(options);
  await component.update([rows[0], account, rows[1], explicitAccount, note]);
  expect(order(component)).toEqual([ids[0], accountId, ids[1], ids[2], note.id]);
  expect(calls).toEqual(ids.slice(0, 2).map(id => `/api/host/projects/${id}/appearance`));
  const accountItem = component.root.children[1];
  expect(accountItem.querySelector('.project-board-palette').hidden).toBe(true);
  expect(accountItem.dataset.boardColor).toBeUndefined();
  key(accountItem, 'Home');
  expect(order(component)[0]).toBe(accountId);
  expect(document.activeElement).toBe(handle(accountItem));
  expect(deepText(accountItem)).toContain('第 1 / 5 项');
  expect(JSON.parse(localStorage.getItem(PROJECT_BOARD_ORDER_KEY))[0]).toBe(accountId);
  const restored = board(options);
  await restored.update([note, explicitAccount, rows[1], account, rows[0]]);
  expect(order(restored)).toEqual(order(component));
  await restored.update([rows[1], account, { id: 'account:new', type: 'account', name: '新账户' }]);
  expect(order(restored)).toEqual([accountId, ids[1], 'account:new']);
  const item = restored.root.children[0]; dropTarget(restored.root.children[1]);
  pointer(item, 'down'); pointer(item, 'move', { clientX: 80, clientY: 100 }); pointer(item, 'up');
  expect(order(restored)).toEqual([ids[1], accountId, 'account:new']);
  expect(item.querySelector('a').onclick).toBeUndefined();
});

test('fixed parent account renderer preserves content and supplies readable account sorting labels', async () => {
  const { renderAccountCard } = await import('../../src/ui/web/assets/dashboard-cards.js');
  const connectionId = '01234567-89ab-cdef-0123-456789abcdef';
  const account = { id: `account:${connectionId}`, type: 'account', connection_id: connectionId,
    connection: { label: '真实账户名称', provider: 'deepseek', observation: { status: 'available', source: 'usage_api',
      resources: [{ id: 'cash', kind: 'balance', scope: 'account', label: '账户现金', unit: 'USD', remaining: 12.5 }] } } };
  const component = board({ renderCard: renderAccountCard, request() { throw new Error('no project reads'); } });
  await component.update([account]);
  const item = component.root.children[0];
  expect(deepText(item)).toContain('12.5 USD');
  expect(handle(item).getAttribute('aria-label')).toContain('真实账户名称');
  expect(item.querySelector('.project-board-palette').hidden).toBe(true);
  expect(item.querySelectorAll('button')).toHaveLength(1);
  await component.update([{ ...account, connection: null }]);
  expect(handle(component.root.children[0]).getAttribute('aria-label')).toContain('账户来源已删除或不可用');
});

test('fixed parent overview composes mixed cards with GET-only reads and no management controls', async () => {
  const connectionId = '01234567-89ab-cdef-0123-456789abcdef', requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url === '/api/host/projects') return Response.json({ projects: [rows[0]] });
    if (url === '/api/host/dashboard') return Response.json({ version: 1, revision: 'fixture', cards: [{ type: 'account', connection_id: connectionId }] });
    if (url === '/api/host/settings/agent/connections?scope=device') return Response.json({ connections: [{ id: connectionId, label: '组合账户', provider: 'deepseek' }],
      configuration_scope: { selected: 'device', source: 'device', project_override: false } });
    if (url === `/api/host/projects/${ids[0]}/appearance`) return Response.json({ id: ids[0], appearance: { version: 1, color: 'rose' } });
    throw new Error(`unexpected request ${url}`);
  };
  const { openProjectOverview } = await import('../../src/ui/web/assets/project-picker.js');
  await openProjectOverview({ push: false });
  const root = dom.node('detail').querySelector('.project-board');
  expect(root.children.map(item => item.dataset.projectId)).toEqual([ids[0], `account:${connectionId}`]);
  expect(root.children[0].dataset.boardColor).toBe('rose');
  expect(root.children[1].querySelector('.project-board-palette').hidden).toBe(true);
  expect(root.querySelectorAll('button')).toHaveLength(2);
  expect(root.querySelector('.project-item-actions')).toBeNull();
  expect(root.querySelector('.project-order')).toBeNull();
  expect(dom.node('detail').querySelector('.dashboard-card-settings')).toBeNull();
  expect(requests.every(({ options }) => !options?.method || options.method === 'GET')).toBe(true);
  expect(requests.map(({ url }) => url).sort()).toEqual(['/api/host/projects', '/api/host/dashboard',
    '/api/host/settings/agent/connections?scope=device', `/api/host/projects/${ids[0]}/appearance`].sort());
});

test('non-project-only boards perform no reads, filter unsafe keys and survive unavailable storage', async () => {
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const component = board({ request() { throw new Error('must not be called'); } });
  await component.update([{ id: 'account:a', type: 'account', name: '账户 A' }, { id: 'account:b', name: '账户 B' },
    { id: 'account:a' }, { id: '../unsafe' }, { id: '' }, { id: 'with spaces' }, { id: 'a'.repeat(257) }, { id: 123 }]);
  expect(order(component)).toEqual(['account:a', 'account:b']);
  key(component.root.children[0], 'End');
  expect(order(component)).toEqual(['account:b', 'account:a']);
  expect(deepText(component.root)).not.toContain('确认配色');
  expect(deepText(component.root)).toContain('无法记住布局');
});

test('switching a project key to an explicit account type isolates its late appearance response', async () => {
  let resolve, reads = 0;
  const component = board({ request: () => { reads++; return new Promise(done => { resolve = done; }); } });
  const pending = component.update(rows.slice(0, 1));
  await component.update([{ id: ids[0], type: 'account', name: '账户' }]);
  resolve({ id: ids[0], appearance: { version: 1, color: 'blue' } }); await pending;
  expect(reads).toBe(1);
  expect(component.root.children[0].dataset.boardColor).toBeUndefined();
  expect(component.root.children[0].querySelector('.project-board-palette').hidden).toBe(true);
});

test('default requester remains read-only and failed reads explicitly show unconfirmed palette', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return Response.json({ error: 'offline' }, { status: 503 }); };
  const component = createProjectBoard({ renderCard }); await component.update(rows.slice(0, 1));
  expect(calls[0].options.method).toBe('GET');
  expect(deepText(component.root)).toContain('配色未确认');
  expect(component.root.children[0].dataset.boardColor).toBeUndefined();
});

test('keyboard order survives remount/refresh and handles added, removed, duplicate and invalid projects', async () => {
  const component = board(); await component.update(rows.slice(0, 3));
  const first = component.root.children[0];
  expect(key(first, 'End')).toBe(true);
  expect(order(component)).toEqual([ids[1], ids[2], ids[0]]);
  expect(document.activeElement).toBe(handle(first));
  expect(deepText(first)).toContain('第 3 / 3 项');
  expect(JSON.parse(localStorage.getItem(PROJECT_BOARD_ORDER_KEY))).toEqual(order(component));
  const restored = board(); await restored.update(rows.slice(0, 3).reverse());
  expect(order(restored)).toEqual(order(component));
  expect(key(restored.root.children[2], 'ArrowUp')).toBe(true);
  expect(order(restored)).toEqual([ids[1], ids[0], ids[2]]);
  await restored.update([rows[2], rows[0], rows[3], rows[3], { id: '../unsafe' }]);
  expect(order(restored)).toEqual([ids[0], ids[2], ids[3]]);
  expect(document.activeElement).toBe(handle(restored.root.children[0]));
  key(restored.root.children[2], 'Home');
  expect(order(restored)).toEqual([ids[3], ids[0], ids[2]]);
  key(restored.root.children[0], 'ArrowRight');
  key(restored.root.children[1], 'ArrowLeft');
  expect(order(restored)).toEqual([ids[3], ids[0], ids[2]]);
  expect(key(restored.root.children[0], 'End', { ctrlKey: true })).toBe(false);
  await restored.update([]); expect(restored.root.children).toHaveLength(0);
});

test('malformed/duplicate order data falls back without rewriting it; storage read/write denial cannot break reorder', async () => {
  for (const raw of ['bad json', '{}', '[1]', JSON.stringify([ids[0], ids[0]]), JSON.stringify(['../unsafe'])]) {
    localStorage.setItem(PROJECT_BOARD_ORDER_KEY, raw);
    const component = board(); await component.update(rows.slice(0, 2));
    expect(order(component)).toEqual(ids.slice(0, 2));
    expect(localStorage.getItem(PROJECT_BOARD_ORDER_KEY)).toBe(raw);
  }
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  const component = board(); await component.update(rows.slice(0, 2));
  expect(deepText(component.root)).toContain('布局记录不可用');
  key(component.root.children[0], 'End'); expect(order(component)).toEqual([ids[1], ids[0]]);
  expect(deepText(component.root)).toContain('无法记住布局');
});

test('palette identity/version/color validation rejects wrong responses and clears old colors on refresh failure', async () => {
  let result = { id: ids[0], appearance: { version: 1, color: 'blue' } };
  const component = board({ request: async () => result });
  await component.update(rows.slice(0, 1)); expect(component.root.children[0].dataset.boardColor).toBe('blue');
  for (const bad of [{ id: ids[1], appearance: null }, { id: ids[0] }, { id: ids[0], appearance: { version: 2, color: 'blue' } }, { id: ids[0], appearance: { version: 1, color: '#bad' } }]) {
    result = bad; await component.update(rows.slice(0, 1));
    expect(component.root.children[0].dataset.boardColor).toBeUndefined();
    expect(deepText(component.root)).toContain('配色未确认');
  }
});

test('late responses cannot repaint a newer generation, removed project or abandoned page', async () => {
  const pending = []; let owns = true;
  const component = board({ ownsPage: () => owns, request: () => new Promise(resolve => pending.push(resolve)) });
  const first = component.update(rows.slice(0, 2));
  const old = [...component.root.children];
  const next = component.update(rows.slice(0, 1));
  pending[2]({ id: ids[0], appearance: { version: 1, color: 'teal' } }); await next;
  pending[0]({ id: ids[0], appearance: { version: 1, color: 'rose' } });
  pending[1]({ id: ids[1], appearance: { version: 1, color: 'blue' } }); await first;
  expect(component.root.children[0].dataset.boardColor).toBe('teal');
  expect(old[0].dataset.boardColor).toBeUndefined(); expect(old[1].dataset.boardColor).toBeUndefined();
  const abandoned = component.update(rows.slice(0, 1)); owns = false;
  pending[3]({ id: ids[0], appearance: { version: 1, color: 'rose' } }); await abandoned;
  expect(component.root.children[0].dataset.boardColor).toBeUndefined();
  await component.update(rows); expect(pending).toHaveLength(4);
  key(component.root.children[0], 'End'); expect(localStorage.getItem(PROJECT_BOARD_ORDER_KEY)).toBeNull();
});

test('reused caller cards do not retain stale decorations/colors, and document replacement guards late results', async () => {
  const item = renderCard(rows[0]); let response = { id: ids[0], appearance: { version: 1, color: 'amber' } };
  const component = board({ renderCard: () => item, request: async () => response });
  await component.update(rows.slice(0, 1)); expect(item.dataset.boardColor).toBe('amber');
  response = { id: ids[0], appearance: null };
  await component.update(rows.slice(0, 1));
  expect(item.querySelectorAll('button')).toHaveLength(1);
  expect(item.querySelectorAll('.project-board-palette')).toHaveLength(1);
  expect(item.dataset.boardColor).toBeUndefined();
  let resolve;
  const late = board({ request: () => new Promise(done => { resolve = done; }) });
  const pending = late.update(rows.slice(0, 1));
  globalThis.document = {};
  resolve({ id: ids[0], appearance: { version: 1, color: 'rose' } }); await pending;
  expect(late.root.children[0].dataset.boardColor).toBeUndefined();
});

test('palette CSS matches all existing identity colors without overriding semantic globals', async () => {
  const css = await Bun.file(new URL('../../src/ui/web/assets/styles-project-board.css', import.meta.url)).text();
  const existing = await Bun.file(new URL('../../src/ui/web/assets/styles-appearance.css', import.meta.url)).text();
  for (const color of ['green', 'blue', 'teal', 'amber', 'rose', 'slate']) {
    const original = existing.split(`.project-color-choice[data-color="${color}"]{`)[1]?.match(/--project-light:(#[a-f0-9]+);--project-dark:(#[a-f0-9]+)/);
    expect(original).not.toBeNull();
    expect(css).toContain(`data-board-color="${color}"]{--board-light:${original[1]};--board-dark:${original[2]}}`);
  }
  expect(css).not.toMatch(/--(?:accent|violet|running|waiting|completed|failed)\s*:/);
  expect(css).toContain('columns:280px'); expect(css).toContain('break-inside:avoid');
  expect(css).toContain('prefers-reduced-motion:reduce'); expect(css).toContain('data-reduced-motion="true"');
  expect(css).toContain('touch-action:pan-y');
});

test('handle-only pointer drop, short gesture, cancellation and vertical touch intent preserve native scrolling/links', async () => {
  const component = board(); await component.update(rows.slice(0, 3));
  let first = component.root.children[0], last = component.root.children[2]; dropTarget(last);
  expect(pointer(first, 'down')).toBe(false);
  expect(pointer(first, 'move', { clientX: 22, clientY: 21 })).toBe(false);
  pointer(first, 'up'); expect(order(component)).toEqual(ids.slice(0, 3));
  pointer(first, 'down'); pointer(first, 'move', { clientX: 80, clientY: 100 });
  expect(last.classList.contains('project-board-drop-after')).toBe(true);
  pointer(first, 'cancel'); pointer(first, 'up'); expect(order(component)).toEqual(ids.slice(0, 3));
  pointer(first, 'down', { pointerType: 'touch' });
  expect(pointer(first, 'move', { pointerType: 'touch', clientX: 22, clientY: 150 })).toBe(false);
  expect(first.classList.contains('project-board-dragging')).toBe(false);
  pointer(first, 'cancel');
  pointer(first, 'down', { pointerType: 'touch' });
  expect(pointer(first, 'move', { pointerType: 'touch', clientX: 140, clientY: 100 })).toBe(true);
  pointer(first, 'up', { pointerType: 'touch' }); expect(order(component)).toEqual([ids[1], ids[2], ids[0]]);
  first = component.root.children[2]; last = component.root.children[0]; dropTarget(last);
  pointer(first, 'down'); pointer(first, 'move', { clientX: 80, clientY: 50 }); pointer(first, 'up');
  expect(order(component)).toEqual(ids.slice(0, 3));
  expect(first.querySelector('a').onpointerdown).toBeUndefined();
  // A refresh cancels the gesture, and stale handlers cannot reorder the new tree.
  pointer(first, 'down'); pointer(first, 'move', { clientX: 80, clientY: 100 });
  await component.update(rows.slice(0, 3)); pointer(first, 'up'); key(first, 'End');
  expect(order(component)).toEqual(ids.slice(0, 3));
});
