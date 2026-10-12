import { test, expect } from 'bun:test';
import { newWidget, validateWidgets, dashboardWidgets, widgetRows, placedAccountIds, widgetSlots } from '../../src/ui/web/assets/dashboard-widget-model.js';
import { dashboardWidgetLayout } from '../../src/ui/web/assets/dashboard-layout-model.js';
const P = 'aaaaaaaaaaaaaaaa', Q = 'bbbbbbbbbbbbbbbb', A = '11111111-1111-4111-8111-111111111111';
const config = { version: 4, widgets: null, cards: [{ type: 'account', connection_id: A }], hidden_projects: [Q], layout: [], content: [{ id: P, sections: ['messages', 'recent'] }, { id: 'accounts', sections: [] }] };
test('legacy projection inherits visibility/content/sources with stable ids, null differs from empty, does not migrate old fields', () => {
  const copy = structuredClone(config), projects = [{ id: P }, { id: Q }];
  const widgets = dashboardWidgets(config, projects);
  expect(widgets.map(row => row.id)).toEqual([`widget:${P}-messages`, `widget:${P}-workers`, 'widget:accounts', 'widget:shortcuts']);
  expect(widgets.find(row => row.type === 'accounts').sections).toEqual([]);
  expect(placedAccountIds(widgets)).toEqual([A]); expect(dashboardWidgets({ ...config, widgets: [] }, projects)).toEqual([]);
  expect(validateWidgets(widgets)).toEqual(widgets); expect(config).toEqual(copy);
});
test('strict full widgets: id/type/source/sections/links/count and cross-source fields cannot be smuggled', () => {
  const widget = newWidget('status', 'widget:status-1', P);
  expect(validateWidgets([widget, { ...widget, id: 'widget:status-2' }])).toHaveLength(2);
  for (const patch of [{ id: 'widget:UPPER' }, { id: 'widget:a'.padEnd(89, 'a') }, { type: 'unknown' }, { project_id: null }, { connection_ids: [A] }, { links: [{ scope: 'global', target: 'settings', project_id: null }] }, { sections: ['recent'] }, { extra: true }]) expect(() => validateWidgets([{ ...widget, ...patch }])).toThrow();
  const missing = { ...widget }; delete missing.links; expect(() => validateWidgets([missing])).toThrow();
  expect(() => validateWidgets([widget, widget])).toThrow();
  expect(() => validateWidgets(Array.from({ length: 101 }, (_, i) => ({ ...widget, id: `widget:${i}` })))).toThrow();
  const shortcut = newWidget('shortcuts', 'widget:links');
  for (const item of [{ scope: 'global', target: 'settings', project_id: P }, { scope: 'project', target: 'settings', project_id: P }, { scope: 'global', target: 'restart', project_id: null }]) expect(() => validateWidgets([{ ...shortcut, links: [item] }])).toThrow();
  const account = newWidget('accounts', 'widget:accounts'); account.connection_ids = [A]; expect(validateWidgets([account])).toHaveLength(1);
});
test('source rows preserve unavailable references and per-widget accounts, source identity never derives from widget id', () => {
  const status = newWidget('status', 'widget:one', Q), account = newWidget('accounts', 'widget:two'); account.connection_ids = [A];
  const rows = widgetRows([status, account], [{ id: P }], []);
  expect(rows[0].source.id).toBe(Q); expect(rows[0].source.running).toBe(false); expect(rows[1].accounts[0].connection).toBeNull();
  expect(rows[1].project_id).toBeNull();
});
test('geometry is read-only legacy projection, explicit widget geometry wins, slots depend only on saved size', () => {
  const widgets = ['status', 'messages', 'workers'].map(type => newWidget(type, `widget:${type}`, P));
  const saved = [{ id: P, x: 10, y: 9, w: 2, h: 80 }], copy = structuredClone(saved);
  expect(dashboardWidgetLayout(saved, widgets)).toEqual(widgets.map(row => ({ id: row.id, x: 8, y: 9, w: 4, h: 10 })));
  expect(saved).toEqual(copy);
  expect(dashboardWidgetLayout([{ id: widgets[0].id, x: 1, y: 2, w: 3, h: 6 }], widgets)[0]).toEqual({ id: widgets[0].id, x: 1, y: 2, w: 3, h: 6 });
  expect(widgetSlots('accounts')).toBe(2); expect(widgetSlots('workers')).toBe(2); expect(widgetSlots('shortcuts')).toBe(1);
  for (const type of ['accounts', 'workers', 'shortcuts']) expect(widgetSlots(type, { h: 80 })).toBeLessThanOrEqual(12);
  expect(widgetSlots('accounts', { h: 8 })).toBe(0); expect(widgetSlots('accounts', { h: 10 })).toBe(1);
  expect(widgetSlots('accounts', { h: 16 })).toBe(2); expect(widgetSlots('accounts', { h: 17 })).toBe(2);
  expect(widgetSlots('accounts', { h: 18 })).toBe(3);
  expect(widgetSlots('workers', { h: 8 })).toBe(1); expect(widgetSlots('shortcuts', { h: 8 })).toBe(1);
});
