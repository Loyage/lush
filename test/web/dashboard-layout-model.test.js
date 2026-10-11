import { test, expect } from 'bun:test';
import { dashboardAccountLayout } from '../../src/ui/web/assets/dashboard-layout-model.js';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const project = { id: 'aaaaaaaaaaaaaaaa', x: 0, y: 0, w: 6, h: 16 };
test('legacy topmost selected source seeds a bounded 6x16 window without mutating stored geometry', () => {
  const layout = [project, { id: `account:${A}`, x: 9, y: 12, w: 3, h: 10 }, { id: `account:${B}`, x: 0, y: 6, w: 4, h: 8 }];
  const before = structuredClone(layout);
  expect(dashboardAccountLayout(layout, [A, B])).toEqual([project, { id: 'accounts', x: 0, y: 6, w: 6, h: 16 }]);
  expect(dashboardAccountLayout(layout, [A])).toEqual([project, { id: 'accounts', x: 6, y: 12, w: 6, h: 16 }]);
  expect(layout).toEqual(before);
});
test('explicit group geometry wins; session seed preserves selection-change position; no local persistence', () => {
  const inherited = { id: 'accounts', x: 6, y: 20, w: 6, h: 16 }, saved = { ...inherited, w: 3, h: 6 };
  expect(dashboardAccountLayout([project], [A], inherited)).toEqual([project, inherited]);
  expect(dashboardAccountLayout([project, saved], [B], inherited)).toEqual([project, saved]);
  expect(dashboardAccountLayout([project], [])).toEqual([project]);
  expect(dashboardAccountLayout([], [A])).toEqual([]);
});
test('legacy entries are omitted only from presentation, leaving room within the 300-cell reader limit', () => {
  const projects = Array.from({ length: 299 }, (_, i) => ({ ...project, id: i.toString(16).padStart(16, '0') }));
  const stored = [...projects, { id: `account:${A}`, x: 0, y: 32, w: 4, h: 10 }];
  expect(dashboardAccountLayout(stored, [A])).toHaveLength(300);
  expect(stored).toHaveLength(300); expect(stored.at(-1).id).toBe(`account:${A}`);
});
