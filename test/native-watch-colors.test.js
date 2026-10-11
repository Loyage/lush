import { test, expect } from 'bun:test';
import { fallbackTerminalColors, watchTerminalColors } from '../src/cli/native-pi.js';

function fixture() {
  const input = new Set(), schemes = new Set(), pending = new Map(), applied = [], writes = [], notifications = [];
  let next = 0, changes = 0;
  const timers = { setTimeout(fn, ms) { expect(ms).toBe(100); pending.set(++next, fn); return next; }, clearTimeout(id) { pending.delete(id); } };
  const ui = {
    terminal: { write(value) { writes.push(value); } },
    addInputListener(fn) { input.add(fn); return () => input.delete(fn); },
    onTerminalColorSchemeChange(fn) { schemes.add(fn); return () => schemes.delete(fn); },
    setTerminalColorSchemeNotifications(value) { notifications.push(value); },
  };
  const runtime = { appearance: { apply(colors, scheme) { applied.push({ colors, scheme }); } } };
  return { ui, runtime, applied, writes, input, schemes, pending, notifications, timers,
    start() { return watchTerminalColors(runtime, ui, () => changes++, error => { throw error; }, timers); },
    emit(data) { return [...input].map(fn => fn(data)); },
    timeout() { for (const [id, fn] of pending) { pending.delete(id); fn(); } },
    get changes() { return changes; },
  };
}

test('100ms startup query budget is bounded; no reply fallback applies and late colors invalidate', async () => {
  const f = fixture(), colors = f.start();
  expect(f.writes[0]).toContain('\x1b]10;?'); expect(f.writes[0]).toContain('\x1b]11;?'); expect(f.writes[0]).toContain('\x1b]4;15;?');
  expect(f.writes[0].endsWith('\x1b[c')).toBe(true);
  f.timeout(); await colors.ready;
  expect(f.applied).toEqual([{ colors: {}, scheme: undefined }]);
  expect(f.emit('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')).toEqual([{ consume: true }]);
  expect(f.applied.at(-1).colors.background).toEqual({ r: 255, g: 255, b: 255 });
  expect(f.changes).toBe(2); colors.dispose();
  expect(f.input.size).toBe(0); expect(f.schemes.size).toBe(0); expect(f.pending.size).toBe(0);
  expect(f.notifications).toEqual([true, false]);
});

test('only complete and valid protocol replies are consumed; RGB/hex/variable channel precision work', async () => {
  const f = fixture(), colors = f.start();
  expect(f.emit('q')).toEqual([undefined]); expect(f.emit('\x1b')).toEqual([undefined]);
  expect(f.emit('\x1b]11;rgb:ffff/0000/zzzz\x07')).toEqual([{ consume: true }]); expect(f.applied).toEqual([]);
  f.emit('\x1b]10;#010203\x07'); expect(f.applied.at(-1).colors.foreground).toEqual({ r: 1, g: 2, b: 3 });
  f.emit('\x1b]11;rgb:f/80/0000\x07'); expect(f.applied.at(-1).colors.background).toEqual({ r: 255, g: 128, b: 0 });
  f.emit('\x1b]11;#ffffffffffff\x07'); expect(f.applied.at(-1).colors.background).toEqual({ r: 255, g: 255, b: 255 });
  // A sparse array's every() would wrongly accept just the last palette slot.
  f.emit('\x1b]4;15;rgb:aa/bb/cc\x07'); expect(f.applied.at(-1).colors.palette).toBeUndefined();
  for (let i = 0; i < 15; i++) f.emit(`\x1b]4;${i};rgb:aa/bb/cc\x07`);
  expect(f.applied.at(-1).colors.palette).toHaveLength(16);
  f.emit('\x1b[?1;2c'); await colors.ready; expect(f.pending.size).toBe(0);
  colors.dispose();
});

test('appearance change requeries, replaces stale palette and cleans an in-flight timer on exit', async () => {
  const f = fixture(), colors = f.start();
  f.emit('\x1b]11;rgb:00/00/00\x07');
  [...f.schemes][0]('light');
  expect(f.applied.at(-1)).toEqual({ colors: {}, scheme: 'light' }); expect(f.writes).toHaveLength(2);
  expect(f.pending.size).toBe(1);
  const changes = f.changes;
  colors.dispose(); colors.dispose(); await colors.ready;
  f.emit('\x1b]11;rgb:ff/ff/ff\x07'); f.timeout();
  expect(f.changes).toBe(changes); expect(f.pending.size).toBe(0); expect(f.input.size).toBe(0); expect(f.schemes.size).toBe(0);
  expect(f.notifications).toEqual([true, false]);
});

test('query write failure removes listeners, timer and appearance notification mode', () => {
  const f = fixture(); f.ui.terminal.write = () => { throw Error('terminal write failed'); };
  expect(() => f.start()).toThrow('terminal write failed');
  expect(f.pending.size).toBe(0); expect(f.input.size).toBe(0); expect(f.schemes.size).toBe(0); expect(f.notifications).toEqual([true, false]);
});

test('fallback has real contrasting panel input, defaults dark and honors safe appearance hints', () => {
  expect(fallbackTerminalColors({}).background).toEqual({ r: 0, g: 0, b: 0 });
  expect(fallbackTerminalColors({ COLORFGBG: '0;15' }).background).toEqual({ r: 255, g: 255, b: 255 });
  for (const value of ['15;0', '15;8', '0;999', 'invalid']) expect(fallbackTerminalColors({ COLORFGBG: value }).background.r).toBe(0);
  expect(fallbackTerminalColors({ COLORFGBG: '15;0' }, 'light').background.r).toBe(255);
  expect(fallbackTerminalColors({ COLORFGBG: '0;15' }, 'dark').background.r).toBe(0);
});
