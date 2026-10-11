import { PROJECT_COLORS } from './project-colors.js';

const validId = id => typeof id === 'string' && /^(?:accounts|[a-f0-9]{16}|account:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(id);
const isProjectRow = row => /^[a-f0-9]{16}$/.test(row.id) && (row.type == null || row.type === 'project');
const colors = new Set(PROJECT_COLORS.map(color => color.id));
const copy = layout => layout.map(cell => ({ ...cell }));
const clamp = (value, min, max, fallback) => Math.max(min, Math.min(max, Number.isFinite(value) ? Math.round(value) : fallback));
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
let boardNumber = 0;
async function readAppearance(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error('配色读取失败');
  return response.json();
}
function bounded(cell, defaults) {
  const w = clamp(cell?.w, 1, 12, defaults.w), h = clamp(cell?.h, 6, 80, defaults.h);
  return { id: defaults.id, x: clamp(cell?.x, 0, 12 - w, 0), y: clamp(cell?.y, 0, 4095, 0), w, h };
}
// Deterministic downward collision avoidance. Keep the requested column first;
// only an exhausted grid falls back to another column, then a compact 1x6 cell.
function place(cell, occupied, columns = 12, maxY = 4095) {
  const search = (value, x, start) => {
    let y = start;
    while (y <= maxY) {
      const candidate = { ...value, x, y };
      const blockers = occupied.filter(other => overlaps(candidate, other));
      if (!blockers.length) return candidate;
      y = Math.max(...blockers.map(other => other.y + other.h));
    }
    return null;
  };
  for (const x of [cell.x, ...Array.from({ length: columns - cell.w + 1 }, (_, x) => x).filter(x => x !== cell.x)]) {
    const found = search(cell, x, cell.y) || search(cell, x, 0);
    if (found) return found;
  }
  if (cell.w !== 1 || cell.h !== 6) return place({ ...cell, x: 0, y: 0, w: 1, h: 6 }, occupied, columns, maxY);
  throw new RangeError('卡片网格已满');
}
function reconcile(rows, saved, compact = false) {
  const known = new Map();
  for (const cell of Array.isArray(saved) ? saved.slice(0, 300) : []) if (validId(cell?.id) && !known.has(cell.id)) known.set(cell.id, cell);
  const result = [], byId = new Map();
  const defaultsFor = row => ({ id: row.id, w: row.type === 'account' ? 4 : 6, h: row.type === 'account' ? 10 : 16 });
  for (const row of rows) if (known.has(row.id)) {
    const desired = bounded(known.get(row.id), defaultsFor(row));
    let cell;
    try { cell = place(compact ? { ...desired, y: 0, h: 6 } : desired, result); }
    catch (error) {
      if (!(error instanceof RangeError) || compact) throw error;
      // 300 full-width 80-row cells cannot fit the finite y domain. Compact
      // heights deterministically rather than overlap, drop cards, or exceed it.
      return reconcile(rows, saved, true);
    }
    result.push(cell); byId.set(row.id, cell);
  }
  for (const row of rows) if (!byId.has(row.id)) {
    const initial = bounded(null, defaultsFor(row));
    if (compact) initial.h = 6;
    let candidates;
    try { candidates = Array.from({ length: 13 - initial.w }, (_, x) => place({ ...initial, x }, result)); }
    catch (error) {
      if (!(error instanceof RangeError) || compact) throw error;
      return reconcile(rows, saved, true);
    }
    const cell = candidates.sort((a, b) => a.y - b.y || a.x - b.x)[0];
    result.push(cell); byId.set(row.id, cell);
  }
  return rows.map(row => byId.get(row.id));
}

/**
 * Caller-owned content, device-owned 12-column layout; no browser persistence.
 * The reserved accounts id/type represents the unified quota card (default 6x16)
 * and never requests project appearance; legacy account:<UUID> cards still work.
 * update(rows,{layout}) replaces the device snapshot (including []/null reset).
 * update(rows) preserves this page's layout and reconciles added/removed ids.
 * Only committed pointer/keyboard edits call onLayoutChange with the full array.
 * Intrinsic content heights only expand the display projection and push collisions;
 * they never mutate getLayout() or invoke onLayoutChange. Saved h is a minimum.
 * CSSOM writes below contain numeric grid coordinates only, never CSS text
 * from rows/settings. Individual style properties work under the existing CSP.
 */
export function createProjectBoard({ ownsPage = () => true, request = readAppearance, renderCard, onLayoutChange }) {
  const owner = document, number = ++boardNumber;
  const node = (tag, text, className) => {
    const element = owner.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const root = node('ul', undefined, 'project-board');
  root.setAttribute('aria-label', '工作台卡片');
  let generation = 0, layout = [], entries = new Map(), gesture = null, editing = false, columns = 12, disposed = false;
  const active = () => !disposed && owner === globalThis.document && ownsPage();
  const getLayout = () => copy(layout);
  const setStyle = (item, key, value) => {
    if (item.style.getPropertyValue?.(key) === value || item.style[key] === value) return;
    item.style.setProperty(key, value);
  };
  function projection(source) {
    return [...source].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id)).map(cell => {
      const w = columns === 12 ? cell.w : columns === 1 ? 1 : Math.max(1, Math.round(cell.w * columns / 12));
      return { ...cell, x: Math.min(columns - w, Math.floor(cell.x * columns / 12)), y: columns === 12 ? cell.y : 0, w };
    });
  }
  function paint(source = layout) {
    const projected = projection(source);
    // Apply every width before reading intrinsic content heights. Content is not
    // stretched to the grid row: shrinking/closing details can shrink it again.
    for (const cell of projected) {
      const entry = entries.get(cell.id);
      if (entry) setStyle(entry.item, 'grid-column', `${cell.x + 1} / span ${cell.w}`);
    }
    const occupied = [];
    for (const cell of projected) {
      const entry = entries.get(cell.id);
      if (!entry) continue;
      const height = entry.content.getBoundingClientRect?.().height;
      // 6px shell borders + 12px inter-card clearance. Runtime heights are not
      // bounded by the persisted h<=80/y<=4095 editing contract.
      cell.h = Math.max(cell.h, Number.isFinite(height) && height > 0 ? Math.ceil((height + 18) / 24) : 0);
      const placed = place(cell, occupied, columns, Infinity);
      occupied.push(placed);
    }
    for (const cell of occupied) {
      const entry = entries.get(cell.id);
      setStyle(entry.item, 'grid-row', `${cell.y + 1} / span ${cell.h}`);
    }
    for (const [id, entry] of entries) {
      const cell = source.find(value => value.id === id);
      const label = `${entry.name}：列 ${cell.x + 1}，行 ${cell.y + 1}，宽 ${cell.w}，高 ${cell.h}`;
      for (const control of entry.controls) {
        if (control.hidden !== !editing) control.hidden = !editing;
        if (control.disabled !== !editing) control.disabled = !editing;
        control.setAttribute('aria-label', `${control === entry.handle ? '移动' : '缩放'} ${label}`);
      }
    }
  }
  function measure() {
    if (!active()) { dispose(); return; }
    const width = root.getBoundingClientRect?.().width;
    const next = Number.isFinite(width) && width > 0 ? width >= 1000 ? 12 : width >= 600 ? 6 : 1 : 12;
    if (columns !== next) {
      clearGesture(); columns = next;
      setStyle(root, '--board-columns', String(columns));
    }
    paint(gesture?.candidate || layout);
  }
  // Read/write outside observer delivery, coalescing content/width/theme changes.
  // Idempotent CSSOM writes and intrinsic (not stretched) content prevent loops.
  let resizeFrame = null, mounted = false;
  function scheduleMeasure() {
    if (!active()) { if (mounted || generation > 0) dispose(); return; }
    if (root.isConnected) mounted = true;
    else if (mounted) { dispose(); return; }
    if (resizeFrame !== null || typeof globalThis.requestAnimationFrame !== 'function') return;
    resizeFrame = globalThis.requestAnimationFrame(() => { resizeFrame = null; measure(); });
  }
  const observer = typeof globalThis.ResizeObserver === 'function' ? new ResizeObserver(scheduleMeasure) : null;
  // Also detect content mutations, details toggles, theme changes and removal.
  // Ignore our grid style attributes, which must never feed back into measuring.
  const mutations = typeof globalThis.MutationObserver === 'function' ? new MutationObserver(records => {
    if (!active() || (mounted && !root.isConnected)) { dispose(); return; }
    if (root.isConnected) mounted = true;
    if (records.some(record => record.target === owner.documentElement || root.contains(record.target))) scheduleMeasure();
  }) : null;
  observer?.observe(root);
  function observeDocument() {
    if (owner.documentElement) mutations?.observe(owner.documentElement, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['open', 'hidden', 'data-theme', 'data-reduced-motion'] });
  }
  observeDocument();
  function dispose() {
    if (disposed) return;
    disposed = true;
    observer?.disconnect(); mutations?.disconnect();
    if (resizeFrame !== null) globalThis.cancelAnimationFrame?.(resizeFrame);
    resizeFrame = null;
    globalThis.removeEventListener?.('pagehide', pagehide);
    clearGesture();
  }
  function pagehide(event) {
    dispose();
    // A restored back/forward-cache page keeps the same DOM and controller.
    // Reattach only that live board, never a removed/replaced page.
    if (!event?.persisted) return;
    const restore = () => {
      globalThis.removeEventListener?.('pageshow', restore);
      if (owner !== globalThis.document || !ownsPage() || !root.isConnected) return;
      disposed = false;
      observer?.observe(root);
      for (const entry of entries.values()) observer?.observe(entry.content);
      observeDocument();
      globalThis.addEventListener?.('pagehide', pagehide);
      scheduleMeasure();
    };
    globalThis.addEventListener?.('pageshow', restore);
  }
  globalThis.addEventListener?.('pagehide', pagehide);
  function clearGesture() {
    if (!gesture) return;
    const { control, pointerId, cancel } = gesture;
    gesture = null;
    globalThis.removeEventListener?.('pagehide', cancel);
    globalThis.removeEventListener?.('blur', cancel);
    for (const entry of entries.values()) entry.item.classList.remove('project-board-dragging');
    try { if (control.hasPointerCapture?.(pointerId)) control.releasePointerCapture(pointerId); } catch {}
    paint();
  }
  function changed(candidate, baseline = layout) {
    return candidate.some((cell, at) => ['id', 'x', 'y', 'w', 'h'].some(key => cell[key] !== baseline[at]?.[key]));
  }
  function adjust(id, desired) {
    const target = bounded(desired, layout.find(cell => cell.id === id));
    let result = [target];
    try { for (const cell of layout) if (cell.id !== id) result.push(place(cell, result)); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      result = [target];
      for (const cell of layout) if (cell.id !== id) result.push(place({ ...cell, y: 0, h: 6 }, result));
    }
    const byId = new Map(result.map(cell => [cell.id, cell]));
    return layout.map(cell => byId.get(cell.id));
  }
  function commit(candidate, entry) {
    if (!active() || !editing || !changed(candidate)) return;
    layout = candidate; paint();
    const cell = layout.find(cell => cell.id === entry.id);
    entry.feedback.textContent = `${entry.name}：列 ${cell.x + 1}，行 ${cell.y + 1}，宽 ${cell.w}，高 ${cell.h}。`;
    onLayoutChange?.(getLayout());
  }
  function attach(entry, epoch) {
    const { id, item } = entry;
    const current = () => active() && editing && epoch === generation && entries.get(id) === entry;
    for (const control of entry.controls) {
      const resize = control !== entry.handle, west = control.dataset.corner === 'west';
      control.onkeydown = event => {
        if (!current()) return;
        if (event.key === 'Escape') { clearGesture(); return; }
        if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!delta) return;
        event.preventDefault(); clearGesture();
        const cell = layout.find(value => value.id === id), desired = { ...cell };
        if (resize || event.shiftKey) { desired.w = clamp(cell.w + delta[0], 1, 12 - cell.x, cell.w); desired.h += delta[1]; }
        else { desired.x += delta[0]; desired.y += delta[1]; }
        commit(adjust(id, desired), entry);
      };
      control.onpointerdown = event => {
        if (!current() || event.isPrimary === false || event.button !== 0 || gesture) return;
        measure();
        const cancel = () => clearGesture();
        gesture = { id, control, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
          cell: { ...layout.find(cell => cell.id === id) }, dragging: false, candidate: null, cancel };
        globalThis.addEventListener?.('pagehide', cancel); globalThis.addEventListener?.('blur', cancel);
        try { control.setPointerCapture(event.pointerId); } catch {}
      };
      control.onpointermove = event => {
        const state = gesture;
        if (!state || state.control !== control || state.pointerId !== event.pointerId) return;
        if (!current()) { clearGesture(); return; }
        const dx = event.clientX - state.x, dy = event.clientY - state.y;
        // Vertical touch intent stays native pan-y, including on resize handles.
        if (!state.dragging && (event.pointerType === 'touch' ? Math.abs(dx) < 12 || Math.abs(dx) <= Math.abs(dy) : Math.hypot(dx, dy) < 6)) return;
        state.dragging = true; event.preventDefault(); item.classList.add('project-board-dragging');
        const width = root.getBoundingClientRect?.().width || 1200;
        const step = (width + 12) / columns;
        const horizontal = Math.round(dx / step) * (12 / columns), vertical = Math.round(dy / 24);
        const desired = { ...state.cell };
        if (resize) {
          desired.w = clamp(state.cell.w + (west ? -horizontal : horizontal), 1, west ? state.cell.x + state.cell.w : 12 - state.cell.x, state.cell.w);
          desired.h += vertical;
          if (west) desired.x = state.cell.x + state.cell.w - desired.w;
        } else { desired.x += horizontal; desired.y += vertical; }
        state.candidate = adjust(id, desired); paint(state.candidate);
      };
      control.onpointerup = event => {
        const state = gesture;
        if (!state || state.control !== control || state.pointerId !== event.pointerId) return;
        const candidate = state.dragging && state.candidate;
        clearGesture(); if (current() && candidate) commit(candidate, entry);
      };
      control.onpointercancel = control.onlostpointercapture = event => {
        if (gesture?.control === control && gesture.pointerId === event.pointerId) clearGesture();
      };
      control.onclick = event => event.preventDefault();
    }
  }
  function setEditing(value) {
    clearGesture(); editing = Boolean(value); root.classList.toggle('project-board-editing', editing);
    root.setAttribute('aria-label', editing ? '工作台卡片布局编辑' : '工作台卡片'); paint(); scheduleMeasure();
  }
  async function update(rows, options = {}) {
    if (!active()) return;
    const epoch = ++generation;
    clearGesture();
    const focused = [...entries.values()].find(entry => entry.controls.includes(owner.activeElement));
    const focusedControl = focused?.controls.indexOf(owner.activeElement);
    const unique = new Map();
    for (const row of rows || []) if (unique.size < 300 && validId(row?.id) && !unique.has(row.id)) unique.set(row.id, row);
    layout = reconcile([...unique.values()], Object.hasOwn(options, 'layout') ? options.layout : layout);
    const next = new Map();
    for (const [id, row] of unique) {
      const item = renderCard(row);
      if (item?.tagName !== 'LI') throw new TypeError('renderCard must return a li');
      const previous = entries.get(id);
      if (previous?.item === item) {
        for (const child of [...previous.content.childNodes]) item.insertBefore(child, previous.content);
        for (const decoration of [...previous.controls, previous.hint, previous.content, previous.feedback]) decoration.remove();
        previous.palette.remove();
      }
      item.removeAttribute('data-board-color'); item.setAttribute('data-project-id', id); item.classList.add('project-board-card');
      const project = isProjectRow(row);
      const name = row.name || (row.type === 'accounts' ? '账户额度'
        : row.type === 'account' ? row.connection?.label || '账户来源已删除或不可用' : '未命名项目');
      const content = node('div', undefined, 'project-board-content');
      content.setAttribute('role', 'region'); content.setAttribute('aria-label', `${name}卡片内容`);
      for (const child of [...item.childNodes]) { child.remove(); content.append(child); }
      const handle = node('button', '⠿', 'project-board-handle'); handle.type = 'button';
      handle.setAttribute('data-help', '拖动以移动卡片，位置吸附网格并避让其他卡片；方向键移动，Shift 加方向键缩放。触屏先横拖，纵向仍可滚动。');
      const controls = [handle];
      for (const corner of ['east', 'west']) {
        const control = node('button', corner === 'east' ? '↘' : '↙', 'project-board-resize'); control.type = 'button'; control.setAttribute('data-corner', corner);
        control.setAttribute('data-help', '拖动边角调整卡片宽度和最小高度并避让其他卡片；方向键调整，内容多时自动撑高。触屏先横拖，纵向仍可滚动。'); controls.push(control);
      }
      const hint = node('span', '方向键移动；Shift 加方向键或缩放手柄调整宽度和最小高度；Esc 取消拖动。内容多时自动撑高，设备布局始终使用十二列，小屏仅改变显示。', 'project-board-sr');
      hint.id = `project-board-${number}-${id}-hint`; for (const control of controls) control.setAttribute('aria-describedby', hint.id);
      const feedback = node('span', '', 'project-board-sr'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); feedback.setAttribute('aria-atomic', 'true');
      const palette = node('small', project ? '正在确认配色…' : '', 'project-board-palette'); palette.setAttribute('role', 'status'); palette.hidden = !project;
      content.append(palette); item.append(content, ...controls, hint, feedback);
      const entry = { id, item, content, handle, controls, hint, palette, feedback, name, project };
      next.set(id, entry); attach(entry, epoch);
    }
    observer?.disconnect();
    entries = next; root.replaceChildren(...[...entries.values()].map(entry => entry.item));
    observer?.observe(root);
    for (const entry of entries.values()) observer?.observe(entry.content);
    measure(); scheduleMeasure();
    if (editing && focused && entries.has(focused.id)) entries.get(focused.id).controls[focusedControl].focus({ preventScroll: true });
    await Promise.all([...entries].map(async ([id, entry]) => {
      if (!entry.project) return;
      try {
        const result = await request(`/api/host/projects/${id}/appearance`, { method: 'GET' });
        if (!active() || epoch !== generation || entries.get(id) !== entry) return;
        if (result?.id !== id || !Object.hasOwn(result, 'appearance')) throw new Error('配色身份未确认');
        const appearance = result.appearance;
        if (appearance === null) entry.palette.textContent = '尚未设置辨识色';
        else if (appearance?.version === 1 && colors.has(appearance.color)) {
          entry.item.setAttribute('data-board-color', appearance.color); entry.palette.textContent = ''; entry.palette.hidden = true;
        } else throw new Error('配色数据未确认');
      } catch {
        if (!active() || epoch !== generation || entries.get(id) !== entry) return;
        entry.item.removeAttribute('data-board-color'); entry.palette.textContent = '配色未确认'; entry.palette.hidden = false;
      }
    }));
    if (active() && epoch === generation) measure();
    else if (!active()) dispose();
  }
  return { root, update, setEditing, getLayout };
}
