import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { createProjectBoard } from '../../src/ui/web/assets/project-board.js';

const ids = Array.from({ length: 5 }, (_, index) => String(index + 1).repeat(16));
const rows = ids.map((id, index) => ({ id, name: `项目 ${index + 1}` }));
const accountId = 'account:01234567-89ab-cdef-0123-456789abcdef';
let dom;
beforeEach(() => { dom = installDom(); });
afterEach(() => dom.restore());
function renderCard(row) {
  const item = document.createElement('li'), link = document.createElement('a');
  link.textContent = row.name; link.href = `/p/${row.id}/`; link.target = '_blank'; link.className = 'project-open';
  item.className = 'project-item'; item.append(link); return item;
}
function board(options = {}) {
  return createProjectBoard({ renderCard, request: async url => ({ id: url.split('/')[4], appearance: null }), ...options });
}
const handle = item => item.querySelector('.project-board-handle');
const resize = item => item.querySelector('.project-board-resize');
function key(control, value, extras = {}) {
  let prevented = false;
  control.onkeydown({ key: value, preventDefault() { prevented = true; }, ...extras }); return prevented;
}
function pointer(control, type, extras = {}) {
  let prevented = false;
  control[`onpointer${type}`]({ pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 20, clientY: 20,
    preventDefault() { prevented = true; }, ...extras }); return prevented;
}
const cell = (id, x = 0, y = 0, w = 6, h = 24) => ({ id, x, y, w, h });
function assertLayout(layout) {
  expect(layout.length).toBeLessThanOrEqual(300);
  for (const a of layout) {
    for (const key of ['x', 'y', 'w', 'h']) expect(Number.isInteger(a[key])).toBe(true);
    expect(a.x).toBeGreaterThanOrEqual(0); expect(a.x + a.w).toBeLessThanOrEqual(12);
    expect(a.y).toBeGreaterThanOrEqual(0); expect(a.y).toBeLessThanOrEqual(4095);
    expect(a.w).toBeGreaterThanOrEqual(1); expect(a.h).toBeGreaterThanOrEqual(6); expect(a.h).toBeLessThanOrEqual(80);
    for (const b of layout) if (a !== b) expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false);
  }
}

test('device layout contract, normal display and GET-only project appearance preserve native links', async () => {
  const calls = [], edits = [];
  const component = board({ onLayoutChange: value => edits.push(value), request: async (url, options) => {
    calls.push({ url, options }); return { id: url.split('/')[4], appearance: { version: 1, color: 'rose' } };
  } });
  const layout = [cell(ids[0], 4, 2, 8, 20)]; await component.update([rows[0]], { layout });
  expect(Object.keys(component).sort()).toEqual(['getLayout', 'root', 'setEditing', 'update']);
  expect(component.root.tagName).toBe('UL'); expect(component.getLayout()).toEqual(layout);
  const item = component.root.children[0]; expect(item.style['grid-column']).toBe('5 / span 8'); expect(item.style['grid-row']).toBe('3 / span 20');
  expect(item.dataset.boardColor).toBe('rose'); expect(item.querySelector('a').onclick).toBeUndefined();
  expect(item.querySelector('a').target).toBe('_blank'); expect(handle(item).hidden).toBe(true); expect(handle(item).disabled).toBe(true);
  expect(key(handle(item), 'ArrowRight')).toBe(false); expect(edits).toHaveLength(0);
  expect(calls).toEqual([{ url: `/api/host/projects/${ids[0]}/appearance`, options: { method: 'GET' } }]);
  component.setEditing(true); expect(handle(item).hidden).toBe(false); expect(resize(item).hidden).toBe(false);
  expect(handle(item).getAttribute('data-help')).toContain('方向键'); expect(handle(item).getAttribute('aria-describedby')).toBeTruthy();
  expect(resize(item).getAttribute('data-help')).toContain('固定宽度和高度');
});

test('reserved accounts identity defaults to 6x16, never aliases project colors and retains legacy cards', async () => {
  const reads = [], component = board({ request: async url => {
    reads.push(url); return { id: url.split('/')[4], appearance: { version: 1, color: 'rose' } };
  } });
  await component.update([rows[0], { id: 'accounts', type: 'accounts' }, { id: accountId, type: 'account' },
    { id: 'accounts', type: 'accounts' }, { id: 'accounts:extra', type: 'accounts' }, { id: 'ACCOUNTS', type: 'accounts' }]);
  expect(component.getLayout()).toEqual([cell(ids[0]), cell('accounts', 6, 0, 6, 16), cell(accountId, 6, 16, 4, 10)]);
  expect(reads).toEqual([`/api/host/projects/${ids[0]}/appearance`]);
  const group = component.root.children[1]; expect(group.dataset.projectId).toBe('accounts'); expect(group.dataset.boardId).toBe('accounts');
  expect(group.dataset.boardColor).toBeUndefined(); expect(group.querySelector('.project-board-palette').hidden).toBe(true);
  expect(handle(group).getAttribute('aria-label')).toContain('账户额度');
  for (const control of group.querySelectorAll('button')) { expect(control.hidden).toBe(true); expect(control.disabled).toBe(true); }
  component.setEditing(true); expect(handle(group).hidden).toBe(false); expect(resize(group).disabled).toBe(false);
  component.setEditing(false); expect(handle(group).hidden).toBe(true); expect(resize(group).disabled).toBe(true);
  // Even misleading caller types cannot turn the reserved non-project identity
  // into /projects/accounts/appearance, nor revive a previous project response.
  await component.update([{ id: 'accounts', type: 'project', name: '统一额度' }]); expect(reads).toHaveLength(1);
  expect(component.root.children[0].dataset.boardColor).toBeUndefined();
});

test('accounts group shares canonical reconciliation, collision edits, resize bounds and responsive projection', async () => {
  const edits = [], component = board({ onLayoutChange: value => edits.push(value) });
  const mixed = [{ id: 'accounts', type: 'accounts', name: '所有账号' }, rows[0]];
  component.root.getBoundingClientRect = () => ({ width: 1188 });
  const device = [cell('accounts', 0, 0, 6, 6), cell(ids[0], 6, 0, 6, 6)];
  await component.update(mixed, { layout: device }); component.setEditing(true);
  const group = component.root.children[0]; key(handle(group), 'ArrowRight');
  expect(component.getLayout()).toEqual([cell('accounts', 1, 0, 6, 6), cell(ids[0], 6, 6, 6, 6)]);
  expect(edits[0]).toEqual(component.getLayout()); expect(edits[0]).toHaveLength(2);
  pointer(resize(group), 'down'); pointer(resize(group), 'move', { clientX: 10000, clientY: 10000 }); pointer(resize(group), 'up');
  expect(component.getLayout()[0]).toEqual(cell('accounts', 1, 0, 11, 80)); assertLayout(component.getLayout());
  await component.update(mixed, { layout: device }); expect(component.getLayout()).toEqual(device);
  component.root.getBoundingClientRect = () => ({ width: 390 }); await component.update(mixed);
  expect(component.root.style['--board-columns']).toBe('1'); expect(component.root.children[0].style['grid-column']).toBe('1 / span 1');
  expect(component.getLayout()).toEqual(device); expect(edits).toHaveLength(2);
  const many = Array.from({ length: 300 }, (_, index) => ({ id: (index + 1).toString(16).padStart(16, '0') }));
  await component.update([mixed[0], ...many], { layout: [] });
  expect(component.getLayout()).toHaveLength(300); expect(component.getLayout()[0].id).toBe('accounts');
  expect(component.getLayout().filter(value => value.id === 'accounts')).toHaveLength(1);
});

test('widgets use fixed defaults, source identities, safe ids, model geometry and cached GET-only appearance', async () => {
  const calls = [], rendered = [], geometries = [];
  const component = board({ renderCard: (row, { geometry }) => {
    expect(row.geometry).toEqual(geometry); rendered.push({ ...geometry }); return renderCard(row);
  }, request: async (url, options) => { calls.push({ url, options }); return { id: ids[0], appearance: { version: 1, color: 'blue' } }; },
  onGeometryChange: (row, geometry, item) => { expect(row.geometry).toEqual(geometry); expect(item.tagName).toBe('LI'); geometries.push(geometry); } });
  const widgets = ['status', 'messages', 'workers', 'accounts', 'shortcuts'].map((type, i) => ({ id: `widget:${type}`, widget_type: type, project_id: i === 0 ? ids[0] : null }));
  await component.update([...widgets, { id: 'widget:Bad' }, { id: 'widget:a/b' }, { id: 'widget:' + 'a'.repeat(81) }]);
  expect(rendered.map(({ w, h }) => [w, h])).toEqual([[4, 10], [4, 10], [4, 10], [6, 14], [4, 8]]);
  expect(calls).toEqual([{ url: `/api/host/projects/${ids[0]}/appearance`, options: { method: 'GET' } }]);
  expect(component.root.children[0].dataset.projectId).toBe(ids[0]); expect(component.root.children[1].dataset.projectId).toBeUndefined();
  expect(geometries).toHaveLength(0); component.setEditing(false); expect(geometries).toHaveLength(0);
  await component.update(widgets); expect(calls).toHaveLength(1); expect(geometries).toHaveLength(0);
  component.setEditing(true); key(resize(component.root.children[1]), 'ArrowDown'); expect(geometries.length).toBeGreaterThan(0);
  const count = geometries.length; component.setEditing(false); expect(geometries).toHaveLength(count);
  component.root.getBoundingClientRect = () => ({ width: 390 }); component.setEditing(false);
  // Resize observation (not content) drives responsive projection.
  await component.update(widgets); expect(component.root.style['--board-columns']).toBe('1');
  expect(component.getLayout()[0].w).toBe(4); expect(widgets[0].geometry.w).toBe(1);
  const model = board(); await model.update([{ id: 'widget:model', widget: { type: 'workers' }, geometry: cell('widget:model', 2, 3, 5, 12) }]);
  expect(model.getLayout()).toEqual([cell('widget:model', 2, 3, 5, 12)]);
  await model.update([{ id: 'widget:tiny', type: 'messages' }], { layout: [cell('widget:tiny', 0, 0, 1, 6)] });
  expect(model.getLayout()).toEqual([cell('widget:tiny', 0, 0, 4, 10)]);
  const unknown = board(); await unknown.update([{ id: 'widget:unknown', type: '__proto__' }]);
  expect(unknown.getLayout()).toEqual([cell('widget:unknown', 0, 0, 4, 8)]);
  const many = Array.from({ length: 300 }, (_, i) => ({ id: `widget:w-${i}`, type: 'messages' }));
  await model.update(many, { layout: many.map(row => cell(row.id, 0, 0, 12, 80)) });
  assertLayout(model.getLayout()); expect(model.getLayout().every(cell => cell.h === 10 && cell.w >= 4)).toBe(true);
});

test('same-source widgets coalesce the initial appearance GET and reuse the confirmed cache', async () => {
  const calls = [], component = board({ request: async url => { calls.push(url); return { id: ids[0], appearance: { version: 1, color: 'blue' } }; } });
  const widgets = ['status', 'messages', 'workers'].map(type => ({ id: `widget:shared-${type}`, type, project_id: ids[0] }));
  await component.update(widgets);
  expect(calls).toEqual([`/api/host/projects/${ids[0]}/appearance`]);
  expect(component.root.children.every(item => item.dataset.boardColor === 'blue')).toBe(true);
  await component.update(widgets); expect(calls).toHaveLength(1);
});

test('parent v4 widget schema and fixed board geometry round-trip through the layout-only patch contract', async () => {
  const { normalizeDashboardPatch } = await import('../../src/core/dashboard-settings.js');
  const reads = [], edits = [];
  const widgets = ['status', 'messages', 'workers', 'accounts', 'shortcuts'].map(type => ({
    id: `widget:${type}`, type, project_id: ['status', 'messages', 'workers'].includes(type) ? ids[0] : null,
    connection_ids: [], links: [], sections: [],
  }));
  const settings = normalizeDashboardPatch({ widgets, layout: widgets.map(row => cell(row.id, 0, 0, 12, 6)) });
  const component = board({ onLayoutChange: value => edits.push(value), request: async url => {
    reads.push(url); return { id: ids[0], appearance: null };
  } });
  await component.update(settings.widgets, { layout: settings.layout });
  expect(component.getLayout().map(({ h }) => h)).toEqual([10, 10, 8, 10, 8]);
  expect(edits).toHaveLength(0); expect(reads.every(url => url === `/api/host/projects/${ids[0]}/appearance`)).toBe(true);
  const unchanged = component.getLayout(); await component.update(settings.widgets); expect(component.getLayout()).toEqual(unchanged);
  component.setEditing(true); key(handle(component.root.children[0]), 'ArrowDown'); expect(edits).toHaveLength(1);
  expect(normalizeDashboardPatch({ layout: edits[0] })).toEqual({ layout: component.getLayout() });
  const idsBefore = component.getLayout().map(row => row.id);
  expect(idsBefore).toEqual(widgets.map(row => row.id));
  await component.update(normalizeDashboardPatch({ widgets: [] }).widgets); expect(component.getLayout()).toEqual([]);
  expect(edits).toHaveLength(1); // Explicit empty board does not write layout while rendering.
});

test('account widgets reserve a complete fixed source slot; board preserves mounted renderer hooks and li identity', async () => {
  const item = renderCard({ id: 'widget:accounts', name: '账户' });
  const ready = async () => 'ready', geometryChanged = () => {};
  item.dashboardReady = ready; item.dashboardGeometryChanged = geometryChanged;
  const component = board({ renderCard: () => item }); document.body.append(component.root);
  const row = { id: 'widget:accounts', type: 'accounts' };
  await component.update([row], { layout: [cell(row.id, 0, 0, 4, 8)] });
  expect(component.getLayout()).toEqual([cell(row.id, 0, 0, 4, 10)]);
  expect(component.root.children[0]).toBe(item); expect(item.dashboardReady).toBe(ready);
  expect(item.dashboardGeometryChanged).toBe(geometryChanged); expect(await item.dashboardReady()).toBe('ready');
  await component.update([row]); expect(component.root.children[0]).toBe(item);
  expect(item.querySelectorAll('.project-board-content')).toHaveLength(1); expect(item.dashboardReady).toBe(ready);
});

test('legacy project and unified account defaults stay fixed; tiny saved geometry gets a state-independent display floor without writes', async () => {
  const edits = [], rendered = [], component = board({ onLayoutChange: value => edits.push(value), renderCard: (row, { geometry }) => {
    rendered.push({ ...geometry }); return renderCard(row);
  } });
  const aggregate = [{ ...rows[0], type: 'project' }, { id: 'accounts', type: 'accounts' }];
  await component.update(aggregate); expect(component.getLayout()).toEqual([cell(ids[0]), cell('accounts', 6, 0, 6, 16)]);
  const tiny = [cell(ids[0], 0, 0, 1, 6), cell('accounts', 1, 0, 1, 6)];
  await component.update(aggregate, { layout: tiny }); expect(component.getLayout()).toEqual(tiny);
  expect(rendered.slice(-2)).toEqual([cell(ids[0], 0, 0, 4, 10), cell('accounts', 1, 10, 4, 10)]);
  component.root.getBoundingClientRect = () => ({ width: 390 }); await component.update(aggregate);
  expect(component.getLayout()).toEqual(tiny); expect(edits).toHaveLength(0);
  expect(component.root.children.every(item => item.style['grid-column'] === '1 / span 1')).toBe(true);
  expect(aggregate.map(row => row.geometry.h)).toEqual([10, 10]);
  component.root.getBoundingClientRect = () => ({ width: 640 }); await component.update(aggregate);
  expect(aggregate.map(row => row.geometry.w)).toEqual([3, 3]); expect(component.getLayout()).toEqual(tiny);
  component.setEditing(true); key(handle(component.root.children[0]), 'ArrowDown');
  expect(component.getLayout()[0]).toEqual(cell(ids[0], 0, 1, 1, 6)); expect(edits).toHaveLength(1);
  expect(handle(component.root.children[0]).getAttribute('aria-label')).toContain('显示投影');
  key(resize(component.root.children[0]), 'ArrowDown');
  expect(component.getLayout()[0]).toEqual(cell(ids[0], 0, 1, 4, 11)); expect(edits).toHaveLength(2);
});

test('same source initial appearance is single-flight; later render epochs cannot inherit the old pending response', async () => {
  const reads = [], pending = [], component = board({ request: url => { reads.push(url); return new Promise(resolve => pending.push(resolve)); } });
  const same = ['status', 'messages'].map(type => ({ id: `widget:${type}`, type, project_id: ids[0] }));
  const old = component.update(same); expect(reads).toHaveLength(1);
  const newer = component.update(same); expect(reads).toHaveLength(2);
  pending[1]({ id: ids[0], appearance: { version: 1, color: 'blue' } }); await newer;
  pending[0]({ id: ids[0], appearance: { version: 1, color: 'rose' } }); await old;
  expect(component.root.children.every(item => item.dataset.boardColor === 'blue')).toBe(true);
  await component.update(same); expect(reads).toHaveLength(2);
});

test('legacy browser order is never read, imported or written, even with denied storage', async () => {
  globalThis.localStorage = { getItem() { throw new Error('must not read'); }, setItem() { throw new Error('must not write'); } };
  const component = board(); await component.update(rows); component.setEditing(true);
  key(handle(component.root.children[0]), 'ArrowDown'); assertLayout(component.getLayout());
  const remount = board(); await remount.update(rows); expect(remount.getLayout()[0]).toEqual(cell(ids[0]));
});

test('reasonable deterministic defaults, additions, removals, duplicate/unsafe ids and 300 limit', async () => {
  const account = { id: accountId, type: 'account', name: '账户' };
  const component = board(); await component.update([rows[0], rows[1], account, rows[0], { id: '../bad' }, { id: 'account:a' }]);
  expect(component.getLayout().map(value => value.id)).toEqual([ids[0], ids[1], accountId]);
  expect(component.getLayout().slice(0, 2)).toEqual([cell(ids[0]), cell(ids[1], 6)]);
  expect(component.getLayout()[2]).toEqual(cell(accountId, 0, 24, 4, 10)); assertLayout(component.getLayout());
  const original = component.getLayout(); await component.update([rows[1], account, rows[2]]);
  expect(component.getLayout()[0]).toEqual(original[1]); expect(component.getLayout()[1]).toEqual(original[2]); assertLayout(component.getLayout());
  const many = Array.from({ length: 301 }, (_, index) => ({ id: (index + 1).toString(16).padStart(16, '0') }));
  await component.update(many, { layout: [] }); expect(component.getLayout()).toHaveLength(300); assertLayout(component.getLayout());
});

test('bad numbers, out-of-range dimensions and collisions normalize safely without callback', async () => {
  const edits = [], component = board({ onLayoutChange: value => edits.push(value) });
  await component.update(rows, { layout: [cell(ids[0], -10, -1, 99, 1), cell(ids[1], NaN, Infinity, 0, 999),
    cell(ids[2], 10.8, 4096, 2.2, 7.5), { id: ids[3], x: '1; color:red', h: 'bad' }, cell(ids[0], 2, 100), { id: '../unsafe' }] });
  assertLayout(component.getLayout()); expect(component.getLayout()[0]).toEqual(cell(ids[0], 0, 0, 12, 6));
  expect(component.getLayout()[1]).toEqual(cell(ids[1], 0, 6, 1, 80)); expect(edits).toHaveLength(0);
  expect(JSON.stringify(component.root.children.map(item => item.style))).not.toContain('color:red');
});

test('fully occupied oversized saved layouts compact safely within the finite coordinate domain', async () => {
  const many = Array.from({ length: 300 }, (_, index) => ({ id: (index + 1).toString(16).padStart(16, '0') }));
  const component = board(); await component.update(many, { layout: many.map(row => cell(row.id, 0, 0, 12, 80)) });
  assertLayout(component.getLayout()); expect(component.getLayout().every(value => value.h === 6)).toBe(true);
});

test('keyboard moves and resizes with collision avoidance, boundary clamping and full-array callbacks', async () => {
  const edits = [], component = board({ onLayoutChange: value => edits.push(value) });
  await component.update(rows.slice(0, 2), { layout: [cell(ids[0], 0, 0, 6, 6), cell(ids[1], 6, 0, 6, 6)] }); component.setEditing(true);
  const item = component.root.children[0]; expect(key(handle(item), 'ArrowRight')).toBe(true);
  expect(component.getLayout()).toEqual([cell(ids[0], 1, 0, 6, 6), cell(ids[1], 6, 6, 6, 6)]);
  expect(edits).toHaveLength(1); expect(edits[0]).toEqual(component.getLayout());
  key(handle(item), 'ArrowDown', { shiftKey: true }); expect(component.getLayout()[0].h).toBe(11);
  key(resize(item), 'ArrowRight'); expect(component.getLayout()[0].w).toBe(7);
  expect(deepText(item)).toContain('宽 7，高 11');
  expect(key(handle(item), 'ArrowRight', { ctrlKey: true })).toBe(false);
  expect(key(handle(item), 'ArrowRight', { isComposing: true })).toBe(false);
  await component.update([rows[0]], { layout: [cell(ids[0], 0, 4095, 12, 80)] });
  const control = handle(component.root.children[0]), count = edits.length;
  key(control, 'ArrowDown'); key(control, 'ArrowLeft'); key(control, 'ArrowRight', { shiftKey: true }); key(control, 'ArrowDown', { shiftKey: true });
  expect(edits).toHaveLength(count); assertLayout(component.getLayout());
});

test('mouse preview snaps to 12-column/24px grid and commits once, not during pointermove', async () => {
  const edits = [], component = board({ onLayoutChange: value => edits.push(value) });
  await component.update([rows[0]], { layout: [cell(ids[0], 0, 0, 3, 6)] }); component.setEditing(true);
  component.root.getBoundingClientRect = () => ({ width: 1188 }); const control = handle(component.root.children[0]);
  pointer(control, 'down'); expect(pointer(control, 'move', { clientX: 169, clientY: 56 })).toBe(true);
  expect(component.root.children[0].style['grid-column']).toBe('2 / span 4'); expect(component.root.children[0].style['grid-row']).toBe('3 / span 10');
  expect(component.getLayout()[0]).toEqual(cell(ids[0], 0, 0, 3, 6)); expect(edits).toHaveLength(0);
  pointer(control, 'up'); expect(edits).toEqual([[cell(ids[0], 1, 2, 3, 6)]]);
  pointer(control, 'up'); expect(edits).toHaveLength(1);
});

test('both bottom corners resize from the visible legacy minimum, bounded at 4..12/10..80', async () => {
  const component = board(); await component.update(rows.slice(0, 2), { layout: [cell(ids[0], 2, 0, 3, 8), cell(ids[1], 6, 0, 6, 6)] });
  component.setEditing(true); component.root.getBoundingClientRect = () => ({ width: 1188 });
  let control = resize(component.root.children[0]); pointer(control, 'down'); pointer(control, 'move', { clientX: 10000, clientY: 10000 }); pointer(control, 'up');
  expect(component.getLayout()[0]).toEqual(cell(ids[0], 2, 0, 10, 80)); assertLayout(component.getLayout());
  await component.update([rows[0]], { layout: [cell(ids[0], 2, 0, 3, 8)] });
  control = component.root.children[0].querySelectorAll('.project-board-resize')[1]; pointer(control, 'down'); pointer(control, 'move', { clientX: -180, clientY: 68 }); pointer(control, 'up');
  expect(component.getLayout()[0]).toEqual(cell(ids[0], 0, 0, 6, 12));
});

test('short pointer, secondary pointer, vertical touch, cancellation, lost capture and blur never save', async () => {
  const edits = [], component = board({ onLayoutChange: value => edits.push(value) }); await component.update([rows[0]]); component.setEditing(true);
  const control = handle(component.root.children[0]), original = component.getLayout();
  pointer(control, 'down', { isPrimary: false }); pointer(control, 'move', { clientX: 200 }); pointer(control, 'up');
  pointer(control, 'down'); pointer(control, 'move', { clientX: 22 }); pointer(control, 'up');
  pointer(control, 'down', { pointerType: 'touch' }); expect(pointer(control, 'move', { pointerType: 'touch', clientX: 22, clientY: 150 })).toBe(false); pointer(control, 'up');
  for (const cancel of ['cancel', 'lost', 'escape', 'blur', 'disabled']) {
    component.setEditing(true); pointer(control, 'down'); pointer(control, 'move', { clientX: 220, clientY: 68 });
    if (cancel === 'lost') control.onlostpointercapture({ pointerId: 1 });
    else if (cancel === 'escape') key(control, 'Escape');
    else if (cancel === 'blur' || cancel === 'pagehide') await dom.fire(cancel);
    else if (cancel === 'disabled') component.setEditing(false);
    else pointer(control, 'cancel');
    pointer(control, 'up'); expect(component.getLayout()).toEqual(original);
    expect(component.root.children[0].style['grid-column']).toBe('1 / span 6');
  }
  expect(edits).toHaveLength(0); expect(component.root.querySelector('a').onpointerdown).toBeUndefined();
});

test('horizontal touch activates drag; stale generation and abandoned-page commits are blocked', async () => {
  const edits = []; let owns = true;
  const component = board({ ownsPage: () => owns, onLayoutChange: value => edits.push(value) }); await component.update([rows[0]]); component.setEditing(true);
  let control = handle(component.root.children[0]); pointer(control, 'down', { pointerType: 'touch' });
  expect(pointer(control, 'move', { pointerType: 'touch', clientX: 230, clientY: 40 })).toBe(true); pointer(control, 'up'); expect(edits).toHaveLength(1);
  pointer(control, 'down'); pointer(control, 'move', { clientX: 330 }); await component.update([rows[0]]); pointer(control, 'up'); key(control, 'ArrowDown'); expect(edits).toHaveLength(1);
  control = handle(component.root.children[0]); pointer(control, 'down'); pointer(control, 'move', { clientX: 230 }); owns = false; pointer(control, 'up');
  expect(edits).toHaveLength(1); key(control, 'ArrowDown'); expect(edits).toHaveLength(1);
});

test('stale Escape cannot cancel a new gesture and refreshed west-resize control keeps keyboard focus', async () => {
  const edits = [], component = board({ onLayoutChange: value => edits.push(value) }); await component.update([rows[0]]); component.setEditing(true);
  const stale = handle(component.root.children[0]), west = component.root.children[0].querySelectorAll('.project-board-resize')[1]; west.focus();
  await component.update([rows[0]]); expect(document.activeElement).toBe(component.root.children[0].querySelectorAll('.project-board-resize')[1]);
  const current = handle(component.root.children[0]); pointer(current, 'down'); pointer(current, 'move', { clientX: 230, clientY: 68 });
  key(stale, 'Escape'); pointer(current, 'up'); expect(edits).toHaveLength(1);
});

test('explicit device reread replaces local edits; no-layout refresh preserves them; snapshots are defensive', async () => {
  const edits = [], component = board({ onLayoutChange: value => { edits.push(value); value[0].x = 99; } }); await component.update(rows.slice(0, 2)); component.setEditing(true);
  key(handle(component.root.children[0]), 'ArrowDown'); const edited = component.getLayout(); expect(edited[0].x).toBe(0);
  const detached = component.getLayout(); detached[0].y = 99; expect(component.getLayout()).toEqual(edited);
  await component.update(rows.slice(0, 2)); expect(component.getLayout()).toEqual(edited);
  const device = [cell(ids[0], 5, 100, 2, 7), cell(ids[1], 8, 2, 4, 8)]; await component.update(rows.slice(0, 2), { layout: device }); expect(component.getLayout()).toEqual(device);
  const remount = board(); await remount.update(rows.slice(0, 2), { layout: device }); expect(remount.getLayout()).toEqual(device);
  await component.update(rows.slice(0, 2), { layout: null }); expect(component.getLayout()).toEqual([cell(ids[0]), cell(ids[1], 6)]);
  expect(edits).toHaveLength(1); await component.update([]); expect(component.getLayout()).toEqual([]);
});

test('responsive display projection does not mutate or save canonical coordinates, resize cancels gestures', async () => {
  const edits = [], component = board({ onLayoutChange: value => edits.push(value) }); let width = 1200;
  component.root.getBoundingClientRect = () => ({ width }); const device = [cell(ids[0], 0, 0), cell(ids[1], 6, 0)];
  await component.update(rows.slice(0, 2), { layout: device }); width = 390; await component.update(rows.slice(0, 2));
  expect(component.root.style['--board-columns']).toBe('1'); expect(component.root.children[1].style['grid-row']).toBe('25 / span 24');
  expect(component.getLayout()).toEqual(device); width = 720; await component.update(rows.slice(0, 2)); expect(component.root.style['--board-columns']).toBe('6');
  expect(component.root.children[1].style['grid-column']).toBe('4 / span 3'); expect(component.getLayout()).toEqual(device);
  width = 1200; await component.update(rows.slice(0, 2)); expect(component.root.children[1].style['grid-column']).toBe('7 / span 6'); expect(edits).toHaveLength(0);
});

test('content refresh paints spans before DOM replacement so transient scrollbar removal cannot cross a breakpoint', async () => {
  const geometries = [], component = board({ onGeometryChange: (_, geometry) => geometries.push(geometry) });
  component.root.getBoundingClientRect = () => ({ width: component.root.children.length && component.root.children.every(item => item.style['grid-row']) ? 590 : 610 });
  await component.update(rows.slice(0, 2)); expect(component.root.style['--board-columns']).toBe('1');
  const coordinates = () => component.root.children.map(item => [item.style['grid-column'], item.style['grid-row']]);
  const original = coordinates(), count = geometries.length;
  await component.update(rows.slice(0, 2)); expect(component.root.style['--board-columns']).toBe('1');
  expect(coordinates()).toEqual(original); expect(geometries).toHaveLength(count);
});

test('ResizeObserver defers projection writes, cancels resize-time gestures and disconnects abandoned pages', async () => {
  const savedObserver = globalThis.ResizeObserver, savedFrame = globalThis.requestAnimationFrame;
  const frames = []; let observed, disconnected = 0, owns = true, width = 1200;
  globalThis.ResizeObserver = class { constructor(callback) { observed = callback; } observe() {} disconnect() { disconnected++; } };
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  try {
    const edits = [], component = board({ ownsPage: () => owns, onLayoutChange: value => edits.push(value) });
    component.root.getBoundingClientRect = () => ({ width }); await component.update(rows.slice(0, 2)); component.setEditing(true);
    const original = component.getLayout(), control = handle(component.root.children[0]);
    pointer(control, 'down'); pointer(control, 'move', { clientX: 230, clientY: 68 });
    width = 390; observed(); observed(); expect(frames).toHaveLength(1);
    expect(component.root.style['--board-columns']).toBeUndefined(); frames.shift()();
    expect(component.root.style['--board-columns']).toBe('1'); pointer(control, 'up');
    expect(component.getLayout()).toEqual(original); expect(edits).toHaveLength(0);
    const beforeDisconnect = disconnected;
    owns = false; observed(); expect(frames).toHaveLength(0); expect(disconnected).toBe(beforeDisconnect + 1);
  } finally { globalThis.ResizeObserver = savedObserver; globalThis.requestAnimationFrame = savedFrame; }
});

test('content heights never change fixed rows or neighbor coordinates or save', async () => {
  let height = 2400, contentReads = 0;
  const edits = [], component = board({ onLayoutChange: value => edits.push(value) });
  const saved = [cell(ids[0], 0, 0, 6, 6), cell(ids[1], 6, 0, 6, 6), cell(ids[2], 0, 6, 6, 6)];
  await component.update(rows.slice(0, 3), { layout: saved });
  const first = component.root.children[0];
  first.querySelector('.project-board-content').getBoundingClientRect = () => { contentReads++; return { height }; };
  component.setEditing(false);
  expect(first.style['grid-row']).toBe('1 / span 10');
  expect(component.root.children[1].style['grid-row']).toBe('1 / span 10');
  expect(component.root.children[2].style['grid-row']).toBe('11 / span 10');
  height = 40; component.setEditing(false);
  expect(first.style['grid-row']).toBe('1 / span 10');
  expect(component.root.children[2].style['grid-row']).toBe('11 / span 10');
  expect(component.getLayout()).toEqual(saved); expect(edits).toHaveLength(0); expect(contentReads).toBe(0);
});

test('only board resize schedules projection; content mutations do not, pagehide cleans every observer', async () => {
  const originals = { ResizeObserver: globalThis.ResizeObserver, MutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  let resizeCallback, mutationCallback, resizeDisconnects = 0, mutationDisconnects = 0, cancelled = 0;
  const watched = new Set(), frames = [];
  globalThis.ResizeObserver = class {
    constructor(callback) { resizeCallback = callback; }
    observe(node) { watched.add(node); }
    disconnect() { watched.clear(); resizeDisconnects++; }
  };
  globalThis.MutationObserver = class { constructor(callback) { mutationCallback = callback; } observe() {} disconnect() { mutationDisconnects++; } };
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = () => { cancelled++; };
  try {
    const edits = [], component = board({ onLayoutChange: value => edits.push(value) });
    const saved = [cell(ids[0], 0, 0, 12, 6), cell(ids[1], 0, 6, 12, 6)];
    await component.update(rows.slice(0, 2), { layout: saved }); frames.shift()();
    component.root.contains = node => component.root.querySelectorAll('.project-board-content').includes(node);
    const oldContent = component.root.children[0].querySelector('.project-board-content');
    expect(watched.has(oldContent)).toBe(false); expect(watched.has(component.root)).toBe(true);
    oldContent.getBoundingClientRect = () => { throw new Error('content must not be measured'); };
    mutationCallback([{ target: oldContent }]); expect(frames).toHaveLength(0);
    resizeCallback(); mutationCallback([{ target: oldContent }]); resizeCallback();
    expect(frames).toHaveLength(1); frames.shift()();
    expect(component.root.children[1].style['grid-row']).toBe('11 / span 10');
    expect(component.getLayout()).toEqual(saved); expect(edits).toHaveLength(0);
    await component.update([rows[1]]); expect(watched.has(oldContent)).toBe(false);
    resizeCallback([{ target: oldContent }]); expect(frames).toHaveLength(1); frames.shift()();
    expect(component.root.children[0].style['grid-row']).toBe('7 / span 10');
    resizeCallback(); const before = resizeDisconnects;
    await dom.fire('pagehide', { persisted: true });
    expect(resizeDisconnects).toBe(before + 1); expect(mutationDisconnects).toBe(1); expect(cancelled).toBe(1);
    expect(watched.size).toBe(0); frames.shift()(); expect(edits).toHaveLength(0);
    component.root.isConnected = true;
    await dom.fire('pageshow', { persisted: true });
    expect(watched.size).toBe(1); frames.shift()();
    component.setEditing(true); key(handle(component.root.children[0]), 'ArrowDown');
    expect(edits).toHaveLength(1);
    await dom.fire('pagehide'); expect(watched.size).toBe(0); expect(mutationDisconnects).toBe(2);
  } finally { Object.assign(globalThis, originals); }
});

test('accounts skip project colors and caller content remains intact without an inner scroll tab stop', async () => {
  const { renderAccountCard } = await import('../../src/ui/web/assets/dashboard-cards.js'); const requests = [];
  const account = { id: accountId, type: 'account', connection_id: accountId.slice(8), connection: { label: '账户名称', provider: 'deepseek', observation: { status: 'available', resources: [{ kind: 'balance', unit: 'USD', remaining: 12.5 }] } } };
  const component = board({ renderCard: renderAccountCard, request: async url => requests.push(url) }); await component.update([account]);
  const item = component.root.children[0]; expect(deepText(item)).toContain('12.5 USD'); expect(handle(item).getAttribute('aria-label')).toContain('账户名称');
  expect(item.querySelector('.project-board-palette').hidden).toBe(true); expect(item.dataset.boardColor).toBeUndefined(); expect(requests).toHaveLength(0);
  expect(item.querySelector('.project-board-content').getAttribute('tabindex')).toBeNull();
});

test('parent dashboard controller saves committed grid drafts explicitly and cancels to the device snapshot', async () => {
  const { createDashboardPanel } = await import('../../src/ui/web/assets/dashboard-panel.js');
  const widgetId = 'widget:grid-status';
  const widget = { id: widgetId, type: 'status', project_id: ids[0], connection_ids: [], links: [], sections: ['metrics'] };
  const legacy = cell(ids[0], 2, 4, 4, 8);
  let config = { version: 4, revision: 'grid-device', account_view: 'list', widgets: [widget], cards: [], hidden_projects: [], content: [], layout: [legacy, cell(widgetId, 2, 4, 4, 10)] };
  const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/host/dashboard') {
      if (options.method === 'POST') {
        const body = JSON.parse(options.body); writes.push(body);
        expect(body.expected_revision).toBe(config.revision);
        const { expected_revision, ...patch } = body;
        config = { ...config, ...patch, revision: 'grid-saved' };
      }
      return Response.json(config);
    }
    if (url === '/api/host/projects') return Response.json({ projects: [{ ...rows[0], running: false }] });
    if (url === '/api/host/settings/agent/connections?scope=device') return Response.json({ connections: [], configuration_scope: { selected: 'device', source: 'device', project_override: false } });
    if (url === `/api/host/projects/${ids[0]}/appearance`) return Response.json({ id: ids[0], appearance: null });
    throw new Error(`unexpected request ${url}`);
  };
  const panel = createDashboardPanel(); document.body.append(panel.root); await panel.ready();
  const button = label => panel.root.querySelectorAll('button').find(node => node.textContent === label);
  expect(handle(panel.root.querySelector('.project-board-card')).hidden).toBe(true);
  button('编辑布局').onclick(); key(handle(panel.root.querySelector('.project-board-card')), 'ArrowDown');
  expect(writes).toHaveLength(0); expect(panel.state().layoutDirty).toBe(true);
  await button('保存布局').onclick(); expect(writes).toHaveLength(1);
  expect(writes[0].layout).toEqual([cell(widgetId, 2, 4, 4, 10), cell(ids[0], 2, 5, 4, 8)]);
  expect(writes[0]).not.toHaveProperty('widgets'); expect(config.widgets).toEqual([widget]); expect(panel.state().editing).toBe(false);
  button('编辑布局').onclick(); key(handle(panel.root.querySelector('.project-board-card')), 'ArrowDown');
  await button('取消布局').onclick(); expect(writes).toHaveLength(1);
  expect(panel.root.querySelector('.project-board-card').style['grid-row']).toBe('6 / span 10');
});

test('appearance failures remain explicit and reject wrong identities, versions and arbitrary colors', async () => {
  let result = { id: ids[0], appearance: { version: 1, color: 'blue' } }; const component = board({ request: async () => result });
  await component.update([rows[0]]); expect(component.root.children[0].dataset.boardColor).toBe('blue');
  for (const bad of [{ id: ids[1], appearance: null }, { id: ids[0] }, { id: ids[0], appearance: { version: 2, color: 'blue' } }, { id: ids[0], appearance: { version: 1, color: '#bad' } }]) {
    result = bad; const fresh = board({ request: async () => result }); await fresh.update([rows[0]]); expect(fresh.root.children[0].dataset.boardColor).toBeUndefined(); expect(deepText(fresh.root)).toContain('配色未确认');
  }
  const calls = []; globalThis.fetch = async (url, options) => { calls.push(options.method); return Response.json({}, { status: 503 }); };
  const fallback = createProjectBoard({ renderCard }); await fallback.update([rows[0]]); expect(calls).toEqual(['GET']); expect(deepText(fallback.root)).toContain('配色未确认');
});

test('late appearance responses cannot repaint refresh, removed card, account switch or replaced document', async () => {
  const pending = []; let owns = true; const component = board({ ownsPage: () => owns, request: () => new Promise(resolve => pending.push(resolve)) });
  const old = component.update(rows.slice(0, 2)), oldItems = [...component.root.children]; const next = component.update([rows[0]]);
  pending[2]({ id: ids[0], appearance: { version: 1, color: 'teal' } }); await next;
  pending[0]({ id: ids[0], appearance: { version: 1, color: 'rose' } }); pending[1]({ id: ids[1], appearance: { version: 1, color: 'blue' } }); await old;
  expect(component.root.children[0].dataset.boardColor).toBe('teal'); expect(oldItems[0].dataset.boardColor).toBeUndefined(); expect(oldItems[1].dataset.boardColor).toBeUndefined();
  const fresh = board({ ownsPage: () => owns, request: () => new Promise(resolve => pending.push(resolve)) });
  const switched = fresh.update([rows[0]]); await fresh.update([{ id: ids[0], type: 'account' }]); pending[3]({ id: ids[0], appearance: { version: 1, color: 'rose' } }); await switched;
  expect(fresh.root.children[0].dataset.boardColor).toBeUndefined();
  const abandoned = fresh.update([rows[0]]); owns = false; pending[4]({ id: ids[0], appearance: { version: 1, color: 'rose' } }); await abandoned; expect(fresh.root.children[0].dataset.boardColor).toBeUndefined();
  owns = true;
  const replacement = board({ request: () => new Promise(resolve => pending.push(resolve)) });
  const replaced = replacement.update([rows[0]]); globalThis.document = {}; pending[5]({ id: ids[0], appearance: { version: 1, color: 'rose' } }); await replaced;
  expect(replacement.root.children[0].dataset.boardColor).toBeUndefined();
});

test('reused caller card unwraps content and removes only previous board decorations', async () => {
  const item = renderCard(rows[0]); let result = { id: ids[0], appearance: { version: 1, color: 'amber' } };
  const component = board({ renderCard: () => item, request: async () => result }); await component.update([rows[0]]); result = { id: ids[0], appearance: null }; await component.update([rows[0]]);
  expect(item.querySelectorAll('a')).toHaveLength(1); expect(item.querySelectorAll('.project-board-content')).toHaveLength(1);
  expect(item.querySelectorAll('.project-board-palette')).toHaveLength(1); expect(item.querySelectorAll('button')).toHaveLength(3); expect(item.dataset.boardColor).toBe('amber'); // successful appearance is cached
});

test('palette CSS matches identity colors without semantic overrides; fixed shell and motion rules exist', async () => {
  const css = await Bun.file(new URL('../../src/ui/web/assets/styles-project-board.css', import.meta.url)).text();
  const existing = await Bun.file(new URL('../../src/ui/web/assets/styles-appearance.css', import.meta.url)).text();
  for (const color of ['green', 'blue', 'teal', 'amber', 'rose', 'slate']) {
    const original = existing.split(`.project-color-choice[data-color="${color}"]{`)[1]?.match(/--project-light:(#[a-f0-9]+);--project-dark:(#[a-f0-9]+)/);
    expect(css).toContain(`data-board-color="${color}"]{--board-light:${original[1]};--board-dark:${original[2]}}`);
  }
  expect(css).not.toMatch(/--(?:accent|violet|running|waiting|completed|failed)\s*:/);
  for (const original of ['border-top:5px solid var(--board-ink)', 'border-radius:10px', 'background:color-mix(in srgb,var(--board-ink) 8%,var(--panel))', 'box-shadow:0 5px 18px', '.project-board .project-open strong{font-size:14px']) expect(css).toContain(original);
  for (const rule of ['grid-auto-rows:24px', 'overflow:visible', 'right:54px', 'touch-action:pan-y', 'prefers-reduced-motion:reduce', 'data-reduced-motion="true"']) expect(css).toContain(rule);
  // A stub cannot compute layout: protect the real-browser regression's shell
  // reset against .project-item alignment and the later account renderer rules.
  const shell = css.split('.project-board>li.project-board-card{')[1]?.split('}')[0];
  expect(shell).toBeTruthy();
  for (const rule of ['grid-template-columns:minmax(0,1fr)', 'grid-template-rows:minmax(0,1fr)', 'align-items:stretch', 'gap:0', 'overflow:visible', 'padding:0', 'min-height:0']) expect(shell).toContain(rule);
  const viewport = css.split('.project-board-content{')[1]?.split('}')[0];
  for (const rule of ['box-sizing:border-box', 'align-self:stretch', 'overflow:visible', 'min-height:0']) expect(viewport).toContain(rule);
  expect(viewport).not.toContain('max-height');
  const widgetCss = await Bun.file(new URL('../../src/ui/web/assets/styles-dashboard-cards.css', import.meta.url)).text();
  for (const rule of ['.dashboard-widget-slots', '.dashboard-widget-slot', '.dashboard-widget-pagination', '.dashboard-widget-message', '.dashboard-widget-count', '.dashboard-widget-notice-read', '.dashboard-widget-worker', '.dashboard-widget-links', '.dashboard-account-metrics-bounded', '.dashboard-account-metric-slot', 'grid-auto-rows:88px', 'grid-template-rows:44px 38px']) expect(widgetCss).toContain(rule);
  const workspace = await Bun.file(new URL('../../src/ui/web/assets/styles-workbench.css', import.meta.url)).text();
  const overview = workspace.split('.workbench-view.project-overview{')[1].split('}')[0];
  expect(overview).toContain('font-size:11px'); expect(overview).not.toContain('--accent:'); expect(overview).not.toContain('background:');
  const block = selector => workspace.split(`${selector}{`)[1].split('}')[0];
  // D552 aggregate rules must not resize the fixed parent's independent status widget.
  const aggregateRoot = '.project-board>[data-board-id]:not([data-board-id^="widget:"]) .dashboard-widget-body';
  const aggregateMetrics = block(`${aggregateRoot} .project-development-metrics`);
  for (const rule of ['height:92px', 'grid-template-columns:repeat(2,minmax(0,1fr))', 'grid-template-rows:repeat(3,minmax(0,1fr))', 'gap:4px']) expect(aggregateMetrics).toContain(rule);
  expect(block(`${aggregateRoot} .project-development-metric`)).toContain('padding:1px 6px');
  for (const section of ['distribution', 'delivery', 'worker']) expect(block(`${aggregateRoot} .project-development-${section}`)).toContain('height:44px');
  const messages = block(`${aggregateRoot} .project-dashboard-messages`);
  for (const rule of ['height:92px', 'padding-top:0', 'border-top:0']) expect(messages).toContain(rule);
  expect(block(`${aggregateRoot} .project-development-recent`)).toContain('gap:4px');
  for (const rule of ['.project-board .project-development-metric .metric-label{font-size:11px}',
    '.project-board .project-development-distribution .chip{font-size:10px',
    '.project-board .project-development-worker .chip{font-size:10px}']) expect(workspace).toContain(rule);
});
