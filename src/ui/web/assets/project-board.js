import { PROJECT_COLORS } from './project-colors.js';

// Browser-only layout, deliberately separate from authoritative device preferences.
export const PROJECT_BOARD_ORDER_KEY = 'lush.host.project-board.order.v1';
const validId = id => typeof id === 'string' && /^[a-z0-9][a-z0-9:_-]{0,255}$/i.test(id);
const isProjectRow = row => /^[a-f0-9]{16}$/.test(row.id) && (row.type == null || row.type === 'project');
const colors = new Set(PROJECT_COLORS.map(color => color.id));
let boardNumber = 0;
async function readAppearance(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error('配色读取失败');
  return response.json();
}

/**
 * Pure display: the caller owns every card's content and links.
 * row.id is a stable, unique layout key (1–256 ASCII letters/digits/:/_/-,
 * beginning with a letter/digit), e.g. a project id or account:<uuid>.
 * Only 16-char lowercase hex ids with absent/null/project type GET project colors.
 * All other rows (including explicit type:account) skip appearance requests.
 * The legacy data-project-id attribute carries the layout key for every card.
 */
export function createProjectBoard({ ownsPage = () => true, request = readAppearance, renderCard }) {
  const owner = document, number = ++boardNumber;
  const node = (tag, text, className) => {
    const element = owner.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const root = node('ul', undefined, 'project-board');
  root.setAttribute('aria-label', '工作台卡片，可通过排序手柄调整顺序');
  let generation = 0, order = [], entries = new Map(), gesture = null, storageNotice = '';
  const active = () => owner === globalThis.document && ownsPage();
  try {
    const raw = globalThis.localStorage.getItem(PROJECT_BOARD_ORDER_KEY);
    if (raw !== null) {
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved) || saved.length > 10000 || !saved.every(validId) || new Set(saved).size !== saved.length) throw new Error('invalid layout');
      order = saved;
    }
  } catch {
    // Neither corrupt data nor blocked storage can make project navigation fail.
    storageNotice = '布局记录不可用；本次排序仅保留在当前页面。';
  }
  function paintPositions() {
    order.forEach((id, index) => {
      const entry = entries.get(id);
      entry.handle.setAttribute('aria-label', `${entry.name}：排序，第 ${index + 1} / ${order.length} 项`);
      entry.item.setAttribute('aria-posinset', index + 1);
      entry.item.setAttribute('aria-setsize', order.length);
      entry.storage.textContent = storageNotice;
      entry.storage.hidden = !storageNotice;
    });
  }
  function save() {
    try {
      globalThis.localStorage.setItem(PROJECT_BOARD_ORDER_KEY, JSON.stringify(order));
      storageNotice = '';
    } catch { storageNotice = '无法记住布局；本次排序仅保留在当前页面。'; }
    paintPositions();
  }
  function move(id, index) {
    if (!active() || !entries.has(id)) return;
    const from = order.indexOf(id);
    index = Math.max(0, Math.min(order.length - 1, index));
    if (from === index) return;
    order.splice(from, 1); order.splice(index, 0, id);
    // Move existing nodes, preserving native links, selections and keyboard focus.
    order.forEach((key, at) => {
      const item = entries.get(key).item;
      if (root.children[at] !== item) root.insertBefore(item, root.children[at] || null);
    });
    save();
    const entry = entries.get(id);
    entry.handle.focus({ preventScroll: true });
    entry.feedback.textContent = `${entry.name}已移到第 ${index + 1} / ${order.length} 项。${storageNotice || '此浏览器已记住顺序。'}`;
  }
  function clearGesture() {
    if (!gesture) return;
    const { handle, pointerId } = gesture;
    gesture = null;
    for (const entry of entries.values()) entry.item.classList.remove('project-board-dragging', 'project-board-drop-before', 'project-board-drop-after');
    try { if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId); } catch {}
  }
  function attach(entry, id, epoch) {
    const { item, handle } = entry;
    const current = () => active() && epoch === generation && entries.get(id) === entry;
    handle.onkeydown = event => {
      if (!current() || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      if (event.key === 'Escape') { clearGesture(); return; }
      const at = order.indexOf(id);
      const to = { ArrowUp: at - 1, ArrowLeft: at - 1, ArrowDown: at + 1, ArrowRight: at + 1, Home: 0, End: order.length - 1 }[event.key];
      if (to === undefined) return;
      event.preventDefault(); clearGesture(); move(id, to);
    };
    handle.onpointerdown = event => {
      if (!current() || event.isPrimary === false || event.button !== 0 || gesture) return;
      gesture = { id, handle, pointerId: event.pointerId, x: event.clientX, y: event.clientY, dragging: false, target: null };
      // Capture only the handle. Card text and project links retain native gestures.
      try { handle.setPointerCapture(event.pointerId); } catch {}
    };
    handle.onpointermove = event => {
      const state = gesture;
      if (!state || state.id !== id || state.pointerId !== event.pointerId) return;
      if (!current()) { clearGesture(); return; }
      const dx = Math.abs(event.clientX - state.x), dy = Math.abs(event.clientY - state.y);
      // touch-action:pan-y lets vertical swipes scroll; touch drags begin sideways.
      if (!state.dragging && (event.pointerType === 'touch' ? dx < 12 || dx <= dy : Math.hypot(dx, dy) < 6)) return;
      state.dragging = true; event.preventDefault();
      item.classList.add('project-board-dragging');
      for (const value of entries.values()) value.item.classList.remove('project-board-drop-before', 'project-board-drop-after');
      const target = owner.elementFromPoint(event.clientX, event.clientY)?.closest?.('li[data-project-id]');
      state.target = null;
      if (!target || target.parentNode !== root || target === item) return;
      const bounds = target.getBoundingClientRect();
      const after = event.clientY >= bounds.top + bounds.height / 2;
      state.target = { id: target.dataset.projectId, after };
      target.classList.add(after ? 'project-board-drop-after' : 'project-board-drop-before');
    };
    handle.onpointerup = event => {
      const state = gesture;
      if (!state || state.id !== id || state.pointerId !== event.pointerId) return;
      const target = state.dragging && state.target;
      clearGesture();
      if (!current() || !target) return;
      const others = order.filter(key => key !== id);
      const at = others.indexOf(target.id);
      if (at >= 0) move(id, at + (target.after ? 1 : 0));
    };
    handle.onpointercancel = handle.onlostpointercapture = event => {
      if (gesture?.handle === handle && gesture.pointerId === event.pointerId) clearGesture();
    };
    handle.onclick = event => event.preventDefault();
  }
  async function update(rows) {
    if (!active()) return;
    const epoch = ++generation;
    clearGesture();
    const focused = [...entries].find(([, entry]) => entry.handle === owner.activeElement)?.[0];
    const unique = new Map();
    for (const row of rows || []) if (validId(row?.id) && !unique.has(row.id)) unique.set(row.id, row);
    order = [...order.filter(id => unique.has(id)), ...[...unique.keys()].filter(id => !order.includes(id))];
    const next = new Map();
    for (const id of order) {
      const row = unique.get(id), item = renderCard(row);
      if (item?.tagName !== 'LI') throw new TypeError('renderCard must return a li');
      const previous = entries.get(id);
      if (previous?.item === item) {
        for (const decoration of [previous.handle, previous.hint, previous.palette, previous.storage, previous.feedback]) decoration.remove();
      }
      item.removeAttribute('data-board-color');
      item.setAttribute('data-project-id', id);
      item.classList.add('project-board-card');
      const project = isProjectRow(row);
      const name = row.name || (row.type === 'account' ? row.connection?.label || '账户来源已删除或不可用' : project ? '未命名项目' : '未命名卡片');
      const handle = node('button', '⠿', 'project-board-handle'); handle.type = 'button';
      handle.setAttribute('data-help', '拖动此手柄调整卡片顺序，触屏先横向拖动；也可聚焦后用方向键、Home 或 End 重排。顺序只保存在此浏览器，不修改项目或账户设置。');
      const hint = node('span', '方向键前移或后移，Home 置顶，End 置底；触屏纵向滑动仍可滚动页面。', 'project-board-sr');
      hint.id = `project-board-${number}-${id}-hint`; handle.setAttribute('aria-describedby', hint.id);
      const feedback = node('span', '', 'project-board-sr'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); feedback.setAttribute('aria-atomic', 'true');
      const palette = node('small', project ? '正在确认配色…' : '', 'project-board-palette'); palette.setAttribute('role', 'status');
      palette.hidden = !project;
      const storage = node('small', undefined, 'project-board-storage');
      item.prepend(handle, hint); item.append(palette, storage, feedback);
      next.set(id, { item, handle, hint, palette, storage, feedback, name, project });
    }
    entries = next;
    root.replaceChildren(...order.map(id => entries.get(id).item));
    paintPositions();
    if (focused && entries.has(focused)) entries.get(focused).handle.focus({ preventScroll: true });
    await Promise.all(order.map(async id => {
      const entry = entries.get(id);
      attach(entry, id, epoch);
      if (!entry.project) return;
      try {
        const result = await request(`/api/host/projects/${id}/appearance`, { method: 'GET' });
        if (!active() || epoch !== generation || entries.get(id) !== entry) return;
        if (result?.id !== id || !Object.hasOwn(result, 'appearance')) throw new Error('配色身份未确认');
        const appearance = result.appearance;
        if (appearance === null) {
          entry.palette.textContent = '尚未设置辨识色';
        } else if (appearance?.version === 1 && colors.has(appearance.color)) {
          entry.item.setAttribute('data-board-color', appearance.color);
          entry.palette.textContent = '';
          entry.palette.hidden = true;
        } else throw new Error('配色数据未确认');
      } catch {
        if (!active() || epoch !== generation || entries.get(id) !== entry) return;
        entry.item.removeAttribute('data-board-color');
        entry.palette.textContent = '配色未确认';
        entry.palette.hidden = false;
      }
    }));
  }
  return { root, update };
}
