import { test, expect, afterAll } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { viewportScrollDelta, attachComposerViewport, usesTouchEnter } from '../../src/ui/web/assets/composer-viewport.js';
const dom = installDom();
afterAll(() => dom.restore());
function fixture() {
  const callbacks = new Map(), events = new Map(), viewportEvents = new Map(); let id = 0;
  const style = () => ({ setProperty(k,v) { this[k]=v; }, removeProperty(k) { delete this[k]; } });
  const listeners = map => ({ addEventListener(k,f) { map.set(k,f); }, removeEventListener(k) { map.delete(k); } });
  const inputEvents = new Map(), shellEvents = new Map();
  const input = { ...listeners(inputEvents), getBoundingClientRect: () => ({ top: 540, bottom: 640, height: 100 }) };
  const shell = { ...listeners(shellEvents), style: style(), contains: node => node === input, getBoundingClientRect: () => ({ top: 500, bottom: 760, height: 260 }) };
  let mobile = true;
  const viewport = { ...listeners(viewportEvents), height: 420, offsetTop: 25, scale: 1 };
  const scrolls = [], win = { ...listeners(events), innerHeight: 800, visualViewport: viewport,
    matchMedia: () => ({ matches: mobile }), requestAnimationFrame(f) { callbacks.set(++id,f); return id; }, cancelAnimationFrame(id) { callbacks.delete(id); }, scrollBy(value) { scrolls.push(value); } };
  document.body.style = style(); document.activeElement = input;
  const flush = () => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(f => f()); };
  return { win, input, shell, callbacks, events, viewportEvents, inputEvents, shellEvents, scrolls, flush, desktop: () => mobile = false };
}
test('viewport geometry respects offset, margin, visibility and tall textarea fallback', () => {
  expect(viewportScrollDelta({ top: 50, bottom: 390 }, { top: 25, height: 400 })).toBe(0);
  expect(viewportScrollDelta({ top: 300, bottom: 600 }, { top: 25, height: 400 })).toBe(183);
  expect(viewportScrollDelta({ top: 5, bottom: 120 }, { top: 25, height: 400 })).toBe(-28);
  expect(usesTouchEnter({ matchMedia: () => ({ matches: true }) })).toBe(true);
  expect(usesTouchEnter({})).toBe(false);
});
test('focus follows viewport animation without polling; keyboard inset and pending frame clean up', () => {
  const f = fixture(), dispose = attachComposerViewport(f.input, f.shell, f.win);
  f.inputEvents.get('focus')(); f.viewportEvents.get('resize')(); expect(f.callbacks.size).toBe(1); f.flush();
  expect(f.scrolls).toEqual([{ top: 323, behavior: 'instant' }]);
  expect(f.shell.style['--composer-keyboard-inset']).toBe('355px');
  expect(document.body.style['--composer-keyboard-inset']).toBe('355px');
  f.win.visualViewport.height = 220; f.viewportEvents.get('resize')(); f.flush();
  expect(f.scrolls.at(-1).top).toBe(403); // shell taller than viewport: use textarea, not entire shell.
  f.viewportEvents.get('scroll')(); dispose();
  expect(f.callbacks.size).toBe(0); expect(f.viewportEvents.size).toBe(0); expect(f.events.size).toBe(0);
  expect(document.body.style['--composer-keyboard-inset']).toBeUndefined(); expect(f.inputEvents.size).toBe(0);
});
test('blur, desktop and pinch zoom stop automatic layout/scroll changes; no viewport uses window height', () => {
  const f = fixture(), dispose = attachComposerViewport(f.input, f.shell, f.win);
  f.inputEvents.get('focus')(); f.flush(); const count = f.scrolls.length;
  document.activeElement = null; f.shellEvents.get('focusout')(); f.flush(); expect(f.scrolls.length).toBe(count);
  expect(f.shell.style['--composer-visible-height']).toBeUndefined();
  document.activeElement = f.input; f.win.visualViewport.scale = 2; f.viewportEvents.get('resize')(); f.flush(); expect(f.scrolls.length).toBe(count);
  f.win.visualViewport.scale = 1; f.desktop(); f.events.get('resize')(); f.flush(); expect(f.scrolls.length).toBe(count); dispose();
  const g = fixture(); delete g.win.visualViewport; const done = attachComposerViewport(g.input,g.shell,g.win);
  g.inputEvents.get('focus')(); g.flush(); expect(g.shell.style['--composer-visible-height']).toBe('800px'); expect(g.scrolls).toHaveLength(0); done();
});
