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
  item.append(link); return item;
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
const cell = (id, x = 0, y = 0, w = 6, h = 16) => ({ id, x, y, w, h });
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
  expect(component.getLayout()[2]).toEqual(cell(accountId, 0, 16, 4, 10)); assertLayout(component.getLayout());
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
  key(handle(item), 'ArrowDown', { shiftKey: true }); expect(component.getLayout()[0].h).toBe(7);
  key(resize(item), 'ArrowRight'); expect(component.getLayout()[0].w).toBe(7);
  expect(deepText(item)).toContain('宽 7，高 7');
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
  expect(component.root.children[0].style['grid-column']).toBe('2 / span 3'); expect(component.root.children[0].style['grid-row']).toBe('3 / span 6');
  expect(component.getLayout()[0]).toEqual(cell(ids[0], 0, 0, 3, 6)); expect(edits).toHaveLength(0);
  pointer(control, 'up'); expect(edits).toEqual([[cell(ids[0], 1, 2, 3, 6)]]);
  pointer(control, 'up'); expect(edits).toHaveLength(1);
});

test('both bottom corners resize, bounded at 1..12/6..80 with collision avoidance', async () => {
  const component = board(); await component.update(rows.slice(0, 2), { layout: [cell(ids[0], 2, 0, 3, 8), cell(ids[1], 6, 0, 6, 6)] });
  component.setEditing(true); component.root.getBoundingClientRect = () => ({ width: 1188 });
  let control = resize(component.root.children[0]); pointer(control, 'down'); pointer(control, 'move', { clientX: 10000, clientY: 10000 }); pointer(control, 'up');
  expect(component.getLayout()[0]).toEqual(cell(ids[0], 2, 0, 10, 80)); assertLayout(component.getLayout());
  await component.update([rows[0]], { layout: [cell(ids[0], 2, 0, 3, 8)] });
  control = component.root.children[0].querySelectorAll('.project-board-resize')[1]; pointer(control, 'down'); pointer(control, 'move', { clientX: -180, clientY: 68 }); pointer(control, 'up');
  expect(component.getLayout()[0]).toEqual(cell(ids[0], 0, 0, 5, 10));
});

test('short pointer, secondary pointer, vertical touch, cancellation, lost capture and blur never save', async () => {
  const edits = [], component = board({ onLayoutChange: value => edits.push(value) }); await component.update([rows[0]]); component.setEditing(true);
  const control = handle(component.root.children[0]), original = component.getLayout();
  pointer(control, 'down', { isPrimary: false }); pointer(control, 'move', { clientX: 200 }); pointer(control, 'up');
  pointer(control, 'down'); pointer(control, 'move', { clientX: 22 }); pointer(control, 'up');
  pointer(control, 'down', { pointerType: 'touch' }); expect(pointer(control, 'move', { pointerType: 'touch', clientX: 22, clientY: 150 })).toBe(false); pointer(control, 'up');
  for (const cancel of ['cancel', 'lost', 'escape', 'blur', 'pagehide', 'disabled']) {
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
  expect(component.root.style['--board-columns']).toBe('1'); expect(component.root.children[1].style['grid-row']).toBe('17 / span 16');
  expect(component.getLayout()).toEqual(device); width = 720; await component.update(rows.slice(0, 2)); expect(component.root.style['--board-columns']).toBe('6');
  expect(component.root.children[1].style['grid-column']).toBe('4 / span 3'); expect(component.getLayout()).toEqual(device);
  width = 1200; await component.update(rows.slice(0, 2)); expect(component.root.children[1].style['grid-column']).toBe('7 / span 6'); expect(edits).toHaveLength(0);
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
    owns = false; observed(); frames.shift()(); expect(disconnected).toBe(1);
  } finally { globalThis.ResizeObserver = savedObserver; globalThis.requestAnimationFrame = savedFrame; }
});

test('accounts skip project colors and caller content remains intact inside a keyboard-scrollable region', async () => {
  const { renderAccountCard } = await import('../../src/ui/web/assets/dashboard-cards.js'); const requests = [];
  const account = { id: accountId, type: 'account', connection_id: accountId.slice(8), connection: { label: '账户名称', provider: 'deepseek', observation: { status: 'available', resources: [{ kind: 'balance', unit: 'USD', remaining: 12.5 }] } } };
  const component = board({ renderCard: renderAccountCard, request: async url => requests.push(url) }); await component.update([account]);
  const item = component.root.children[0]; expect(deepText(item)).toContain('12.5 USD'); expect(handle(item).getAttribute('aria-label')).toContain('账户名称');
  expect(item.querySelector('.project-board-palette').hidden).toBe(true); expect(item.dataset.boardColor).toBeUndefined(); expect(requests).toHaveLength(0);
  expect(item.querySelector('.project-board-content').getAttribute('tabindex')).toBe('0');
});

test('parent dashboard controller saves committed grid drafts explicitly and cancels to the device snapshot', async () => {
  const { createDashboardPanel } = await import('../../src/ui/web/assets/dashboard-panel.js');
  let config = { version: 2, revision: 'grid-device', cards: [], hidden_projects: [], content: [], layout: [cell(ids[0], 2, 4, 4, 8)] };
  const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/host/dashboard') {
      if (options.method === 'POST') {
        const body = JSON.parse(options.body); writes.push(body);
        expect(body.expected_revision).toBe(config.revision);
        config = { ...config, layout: body.layout, revision: 'grid-saved' };
      }
      return Response.json(config);
    }
    if (url === '/api/host/projects') return Response.json({ projects: [{ ...rows[0], running: false }] });
    if (url === '/api/host/settings/agent/connections?scope=device') return Response.json({ connections: [], configuration_scope: { selected: 'device', source: 'device', project_override: false } });
    if (url === `/api/host/projects/${ids[0]}/appearance`) return Response.json({ id: ids[0], appearance: null });
    throw new Error(`unexpected request ${url}`);
  };
  const panel = createDashboardPanel({ renderProject: renderCard }); document.body.append(panel.root); await panel.ready();
  const button = label => panel.root.querySelectorAll('button').find(node => node.textContent === label);
  expect(handle(panel.root.querySelector('.project-board-card')).hidden).toBe(true);
  button('编辑布局').onclick(); key(handle(panel.root.querySelector('.project-board-card')), 'ArrowDown');
  expect(writes).toHaveLength(0); expect(panel.state().layoutDirty).toBe(true);
  await button('保存布局').onclick(); expect(writes).toHaveLength(1);
  expect(writes[0].layout).toEqual([cell(ids[0], 2, 5, 4, 8)]); expect(panel.state().editing).toBe(false);
  button('编辑布局').onclick(); key(handle(panel.root.querySelector('.project-board-card')), 'ArrowDown');
  await button('取消布局').onclick(); expect(writes).toHaveLength(1);
  expect(panel.root.querySelector('.project-board-card').style['grid-row']).toBe('6 / span 8');
});

test('appearance failures remain explicit and reject wrong identities, versions and arbitrary colors', async () => {
  let result = { id: ids[0], appearance: { version: 1, color: 'blue' } }; const component = board({ request: async () => result });
  await component.update([rows[0]]); expect(component.root.children[0].dataset.boardColor).toBe('blue');
  for (const bad of [{ id: ids[1], appearance: null }, { id: ids[0] }, { id: ids[0], appearance: { version: 2, color: 'blue' } }, { id: ids[0], appearance: { version: 1, color: '#bad' } }]) {
    result = bad; await component.update([rows[0]]); expect(component.root.children[0].dataset.boardColor).toBeUndefined(); expect(deepText(component.root)).toContain('配色未确认');
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
  const switched = component.update([rows[0]]); await component.update([{ id: ids[0], type: 'account' }]); pending[3]({ id: ids[0], appearance: { version: 1, color: 'rose' } }); await switched;
  expect(component.root.children[0].dataset.boardColor).toBeUndefined();
  const abandoned = component.update([rows[0]]); owns = false; pending[4]({ id: ids[0], appearance: { version: 1, color: 'rose' } }); await abandoned; expect(component.root.children[0].dataset.boardColor).toBeUndefined();
  owns = true; const replaced = component.update([rows[0]]); globalThis.document = {}; pending[5]({ id: ids[0], appearance: { version: 1, color: 'rose' } }); await replaced;
  expect(component.root.children[0].dataset.boardColor).toBeUndefined();
});

test('reused caller card unwraps content and removes only previous board decorations', async () => {
  const item = renderCard(rows[0]); let result = { id: ids[0], appearance: { version: 1, color: 'amber' } };
  const component = board({ renderCard: () => item, request: async () => result }); await component.update([rows[0]]); result = { id: ids[0], appearance: null }; await component.update([rows[0]]);
  expect(item.querySelectorAll('a')).toHaveLength(1); expect(item.querySelectorAll('.project-board-content')).toHaveLength(1);
  expect(item.querySelectorAll('.project-board-palette')).toHaveLength(1); expect(item.querySelectorAll('button')).toHaveLength(3); expect(item.dataset.boardColor).toBeUndefined();
});

test('palette CSS matches identity colors without semantic overrides; grid, scrolling and motion rules exist', async () => {
  const css = await Bun.file(new URL('../../src/ui/web/assets/styles-project-board.css', import.meta.url)).text();
  const existing = await Bun.file(new URL('../../src/ui/web/assets/styles-appearance.css', import.meta.url)).text();
  for (const color of ['green', 'blue', 'teal', 'amber', 'rose', 'slate']) {
    const original = existing.split(`.project-color-choice[data-color="${color}"]{`)[1]?.match(/--project-light:(#[a-f0-9]+);--project-dark:(#[a-f0-9]+)/);
    expect(css).toContain(`data-board-color="${color}"]{--board-light:${original[1]};--board-dark:${original[2]}}`);
  }
  expect(css).not.toMatch(/--(?:accent|violet|running|waiting|completed|failed)\s*:/);
  for (const rule of ['grid-auto-rows:24px', 'overflow:auto', 'right:54px', 'touch-action:pan-y', 'prefers-reduced-motion:reduce', 'data-reduced-motion="true"']) expect(css).toContain(rule);
});
