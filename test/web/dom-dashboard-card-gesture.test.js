import { afterAll, beforeEach, expect, test } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { createCardSettingsGesture } from '../../src/ui/web/assets/dashboard-card-gesture.js';

const dom = installDom();
afterAll(() => dom.restore());
let board, card, host, control, gesture, callbacks, live, allowed;
const fire = (type, extra = {}) => {
  const event = { type, target: card, pointerId: 1, button: 0, clientX: 10, clientY: 10,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
  for (const handler of board.listeners[type] || []) handler(event);
  return event;
};
const hold = () => { fire('pointerdown'); for (const callback of [...callbacks.values()]) callback(); callbacks.clear(); };
beforeEach(() => {
  gesture?.dispose(); dom.setSelection('');
  live = allowed = true; callbacks = new Map();
  board = dom.document.createElement('ul'); card = dom.document.createElement('li'); card.className = 'project-board-card';
  host = dom.document.createElement('span'); host.className = 'dashboard-card-settings-host'; host.hidden = true;
  control = dom.document.createElement('button'); host.append(control); card.append(host); board.append(card);
  gesture = createCardSettingsGesture(board, { active: () => live, canReveal: () => allowed,
    timers: { setTimeout(callback, ms) { expect(ms).toBe(650); const id = Symbol(); callbacks.set(id, () => { callbacks.delete(id); callback(); }); return id; }, clearTimeout(id) { callbacks.delete(id); } } });
});

test('short press stays native; long press reveals only the local entry and suppresses release click/menu', () => {
  fire('pointerdown'); fire('pointerup'); expect(callbacks.size).toBe(0); expect(host.hidden).toBe(true);
  hold(); expect(host.hidden).toBe(false); expect(dom.document.activeElement).toBe(control);
  expect(fire('contextmenu').prevented).toBe(true); expect(fire('click').prevented).toBe(true);
  fire('pointerdown', { target: control }); expect(fire('click', { target: control }).prevented).toBeUndefined();
});

test('movement, pointer cancellation, pointer exit and scroll cancel pending presses', async () => {
  for (const [type, extra] of [['pointermove', { clientY: 40 }], ['pointercancel', {}], ['pointerleave', {}]]) {
    fire('pointerdown'); fire(type, extra); expect(callbacks.size).toBe(0); expect(host.hidden).toBe(true);
  }
  fire('pointerdown'); await dom.fire('scroll'); expect(callbacks.size).toBe(0);
  hold(); await dom.fire('scroll'); expect(host.hidden).toBe(true);
});

test('links, buttons, editable content and selected text retain their own long press behavior', () => {
  for (const tag of ['a', 'button', 'input', 'select', 'textarea', 'summary']) {
    const target = dom.document.createElement(tag); card.append(target); fire('pointerdown', { target }); expect(callbacks.size).toBe(0);
  }
  const target = dom.document.createElement('div'); target.isContentEditable = true; card.append(target);
  fire('pointerdown', { target }); expect(callbacks.size).toBe(0);
  dom.setSelection('selected'); fire('pointerdown'); expect(callbacks.size).toBe(0);
  dom.setSelection(''); fire('pointerdown'); dom.setSelection('selected during hold');
  for (const callback of callbacks.values()) callback(); expect(host.hidden).toBe(true);
});

test('keyboard equivalent, Escape, outside click and blur dismiss without opening a dialog', async () => {
  expect(fire('keydown', { key: 'F10', shiftKey: true }).prevented).toBe(true); expect(host.hidden).toBe(false);
  await dom.fire('blur', { target: card }); expect(host.hidden).toBe(false);
  fire('keydown', { key: 'Escape', target: control }); expect(host.hidden).toBe(true); expect(dom.document.activeElement).toBe(card);
  fire('keydown', { key: 'ContextMenu' }); await dom.fire('pointerdown', { target: board }); expect(host.hidden).toBe(true);
  hold(); await dom.fire('blur'); expect(host.hidden).toBe(true);
});

test('busy/editing, navigation and stale removed cards cannot reveal; disposal releases global listeners', async () => {
  allowed = false; hold(); expect(host.hidden).toBe(true);
  allowed = true; fire('pointerdown'); live = false;
  for (const callback of callbacks.values()) callback(); expect(host.hidden).toBe(true);
  live = true; fire('pointerdown'); card.remove();
  for (const callback of callbacks.values()) callback(); expect(host.hidden).toBe(true);
  const before = dom.listeners.scroll.length; gesture.dispose(); expect(dom.listeners.scroll.length).toBe(before - 1);
  expect(callbacks.size).toBe(0);
});
