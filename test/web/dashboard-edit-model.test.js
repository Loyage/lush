import { test, expect } from 'bun:test';
import { createDashboardHistory, dashboardPatch } from '../../src/ui/web/assets/dashboard-edit-model.js';
import { registerPageLeaveGuard, requestPageLeave, resetPageLeaveGuard } from '../../src/ui/web/assets/page-leave-guard.js';

test('partial patch compares raw fields, not projections or revision, and does not alias draft arrays', () => {
  const base = { revision: 'one', widgets: null, cards: [], layout: [{ id: 'accounts', x: 0, y: 0, w: 1, h: 6 }], content: [] };
  const next = structuredClone(base); next.revision = 'two';
  expect(dashboardPatch(base, next)).toEqual({});
  next.layout[0].x = 1; const patch = dashboardPatch(base, next); expect(Object.keys(patch)).toEqual(['layout']);
  patch.layout[0].x = 2; expect(next.layout[0].x).toBe(1); expect(base.layout[0].x).toBe(0);
  next.widgets = []; expect(dashboardPatch(base, next).widgets).toEqual([]);
});

test('history takes isolated full snapshots, suppresses no-ops, restores geometry/config and drops branched redo', () => {
  const initial = { config: { widgets: null, diagnostics: true }, layoutDraft: [], layoutDirty: false };
  const history = createDashboardHistory(initial); expect(history.canUndo).toBe(false); expect(history.push(initial)).toBe(false);
  const next = structuredClone(initial); next.config.diagnostics = false; history.push(next); next.config.widgets = [];
  expect(history.undo()).toEqual(initial); expect(history.canRedo).toBe(true);
  expect(history.redo().config.widgets).toBeNull(); history.undo();
  const branch = { ...initial, layoutDirty: true, layoutDraft: [{ id: 'accounts', x: 1 }] }; history.push(branch);
  expect(history.canRedo).toBe(false); const result = history.undo(); result.config.widgets = ['not shared'];
  expect(history.redo()).toEqual(branch); expect(history.undo()).toEqual(initial);
});

test('page guard keeps synchronous decisions and continuations synchronous', () => {
  resetPageLeaveGuard(); let opened = 0, stayed = 0;
  const actions = { leave: () => ++opened, stay: () => ++stayed };
  expect(requestPageLeave('#docs', actions)).toBe(1); expect(opened).toBe(1);
  const unregister = registerPageLeaveGuard(target => target === '#docs');
  try {
    expect(requestPageLeave('#docs', actions)).toBe(2); expect(opened).toBe(2);
    expect(requestPageLeave('#settings', actions)).toBe(1); expect(stayed).toBe(1);
  } finally { unregister(); }
});

test('older asynchronous acceptance or rejection cannot run either continuation after a newer attempt or boot', async () => {
  const pending = []; let opened = 0, restored = 0;
  const unregister = registerPageLeaveGuard(() => new Promise(resolve => pending.push(resolve)));
  const actions = { leave: () => ++opened, stay: () => ++restored };
  try {
    const first = requestPageLeave('#docs', actions), second = requestPageLeave('#settings', actions);
    pending[1](true); await second; pending[0](false); await first;
    expect(opened).toBe(1); expect(restored).toBe(0);
    const beforeBoot = requestPageLeave('#docs', actions); resetPageLeaveGuard(); pending[2](true); await beforeBoot;
    expect(opened).toBe(1); expect(restored).toBe(0);
  } finally { unregister(); }
});

test('page guard disposal/replacement/competing requests cannot accept a stale navigation', async () => {
  let release; const unregister = registerPageLeaveGuard(() => new Promise(resolve => { release = resolve; }));
  const pending = requestPageLeave('#settings'); const newer = registerPageLeaveGuard(() => false);
  unregister(); release(true); expect(await pending).toBe(false); expect(await requestPageLeave('#docs')).toBe(false);
  newer(); expect(await requestPageLeave('#docs')).toBe(true);
});
