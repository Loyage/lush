import { test, expect } from 'bun:test';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDashboardSettings, saveDashboardSettings } from '../../src/core/dashboard-settings.js';
import { readDashboardConfig } from '../../src/ui/web/assets/dashboard-cards.js';
import { newWidget } from '../../src/ui/web/assets/dashboard-widget-model.js';
import { dashboardAggregateLayout } from '../../src/ui/web/assets/dashboard-layout-model.js';
import { aggregateRows, aggregateProjectIds, aggregateAccountIds, aggregateLinks, aggregateSections, aggregateBudget,
  materializeAggregate, selectAggregateProject, selectAggregateAccounts, toggleAggregateSection, toggleAggregateLink } from '../../src/ui/web/assets/dashboard-widget-aggregate-model.js';
const P = 'aaaaaaaaaaaaaaaa', Q = 'bbbbbbbbbbbbbbbb', R = 'cccccccccccccccc', A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const projects = [{ id: P, name: 'A' }, { id: Q, name: 'B' }];
const config = () => ({ version: 4, revision: 'r', account_view: 'tiles', widgets: null, cards: [{ type: 'account', connection_id: A }], hidden_projects: [Q], content: [], layout: [] });
const member = (type, id, source, sections) => ({ ...newWidget(type, id, source), ...(sections ? { sections } : {}) });
const link = (target, project_id = null) => ({ scope: project_id ? 'project' : 'global', target, project_id });

test('v1-4/null inherit project/account preferences read-only; [] is truly empty and stale sources stay explicit', async () => {
  for (const version of [1, 2, 3, 4]) {
    const original = version === 1 ? { version, revision: 'r', cards: config().cards } : { ...config(), version };
    if (version < 4) delete original.widgets;
    const before = structuredClone(original), parsed = await readDashboardConfig({ value: original });
    const rows = aggregateRows(parsed, projects, []);
    expect(rows.filter(row => row.type === 'project').map(row => row.id)).toEqual(version === 1 ? [P, Q] : [P]);
    expect(rows.at(-1).id).toBe('accounts'); expect(rows.at(-1).accounts[0].connection).toBeNull(); expect(original).toEqual(before);
  }
  const value = { ...config(), widgets: [] }; expect(aggregateRows(value, projects, [])).toEqual([]); expect(aggregateLinks(value)).toEqual([]);
  value.widgets = [member('status', 'widget:missing', R, [])];
  const row = aggregateRows(value, projects, [])[0]; expect(row.id).toBe(R); expect(row.sections).toEqual([]); expect(row.running).toBe(false);
});
test('same-source members aggregate without normalizing empty sections, duplicate/custom links or per-account content', () => {
  const value = config(), status = member('status', 'widget:a', P, ['metrics']), disabled = member('status', 'widget:b', P, []);
  const messages = member('messages', 'widget:m', P, []), a = member('accounts', 'widget:x', null, []), b = member('accounts', 'widget:y', null, ['balance']); a.connection_ids = [A]; b.connection_ids = [B];
  const navigation = member('shortcuts', 'widget:nav', null); navigation.links = [link('notices', P), link('notices', P), link('docs'), link('inputs', Q)];
  value.widgets = [status, disabled, messages, a, b, navigation]; const before = structuredClone(value);
  const rows = aggregateRows(value, projects, []);
  expect(rows.map(row => row.id)).toEqual([P, Q, 'accounts']); expect(rows[0].name).toBe('A'); expect(rows[0].sections).toEqual(['metrics', 'shortcuts']); expect(rows[0].links).toHaveLength(2);
  expect(rows.at(-1).accountSections).toEqual({ [`account:${A}`]: [], [`account:${B}`]: ['balance'] }); expect(aggregateLinks(value)).toEqual([link('docs')]); expect(value).toEqual(before);
  toggleAggregateSection(value, P, 'metrics', false); expect(value.widgets[0].sections).toEqual([]); expect(value.widgets[1].sections).toEqual([]);
  for (const i of [2, 3, 4, 5]) expect(value.widgets[i]).toEqual(before.widgets[i]);
});
test('per-project shortcut content splits only its shared links; global/other-project intent and disabled links survive', () => {
  const value = config(), widget = member('shortcuts', 'widget:shared', null); widget.links = [link('inputs', P), link('inputs', P), link('docs'), link('workers', Q)]; value.widgets = [widget];
  toggleAggregateSection(value, P, 'shortcuts', false);
  expect(aggregateSections(value, P)).toEqual([]); expect(aggregateProjectIds(value, projects)).toContain(P);
  expect(aggregateLinks(value, P, { selectedOnly: false })).toEqual([link('inputs', P), link('inputs', P)]);
  expect(aggregateLinks(value)).toEqual([link('docs')]); expect(aggregateLinks(value, Q)).toEqual([link('workers', Q)]);
  const other = structuredClone(value.widgets[0]); toggleAggregateSection(value, P, 'shortcuts', true); expect(value.widgets[0]).toEqual(other); expect(aggregateLinks(value, P)).toHaveLength(2);
});
test('source removal is explicit and local, disabled/deleted accounts and unrelated members are not rewritten', () => {
  const value = config(), a = member('accounts', 'widget:a', null, []), b = member('accounts', 'widget:b', null, ['quota']), empty = member('accounts', 'widget:empty', null, []); a.connection_ids = [A]; b.connection_ids = [B];
  const navigation = member('shortcuts', 'widget:navigation', null); navigation.links = [link('versions', P), link('docs'), link('notices', Q)];
  value.widgets = [member('status', 'widget:p', P, []), member('workers', 'widget:q', Q), a, b, empty, navigation];
  const before = structuredClone(value);
  selectAggregateProject(value, projects, P, false); expect(aggregateProjectIds(value, projects)).toEqual([Q]); expect(aggregateLinks(value)).toEqual([link('docs')]);
  selectAggregateAccounts(value, [A]); expect(aggregateAccountIds(value)).toEqual([A]); expect(value.widgets.find(widget => widget.id === 'widget:a')).toEqual(a); expect(value.widgets.find(widget => widget.id === 'widget:empty')).toEqual(empty);
  for (const field of ['content', 'cards', 'hidden_projects', 'layout', 'account_view']) expect(value[field]).toEqual(before[field]);
});
test('legacy materialization preserves every source/link and individual content; over 100 never truncates or mutates input', () => {
  const value = config(); value.hidden_projects = []; value.content = [{ id: `account:${A}`, sections: [] }];
  materializeAggregate(value, projects); expect(aggregateProjectIds(value, projects)).toEqual([P, Q]); expect(aggregateRows(value, projects, []).at(-1).accountSections[`account:${A}`]).toEqual([]);
  expect(aggregateLinks(value, P)).toHaveLength(3); expect(aggregateLinks(value, Q)).toHaveLength(3); expect(aggregateLinks(value)).toHaveLength(3);
  const many = Array.from({ length: 26 }, (_, i) => ({ id: i.toString(16).padStart(16, '0') })), tooMany = { ...config(), hidden_projects: [] }, before = structuredClone(tooMany);
  expect(() => materializeAggregate(tooMany, many)).toThrow(); expect(tooMany).toEqual(before);
  toggleAggregateLink(tooMany, many, link('settings'), true); expect(aggregateProjectIds(tooMany, many)).toHaveLength(26); expect(aggregateLinks(tooMany)).toContainEqual(link('settings'));
  for (const row of many.slice(0, 3)) selectAggregateProject(tooMany, many, row.id, false);
  expect(tooMany.widgets.length).toBeLessThanOrEqual(100); expect(aggregateLinks(tooMany, many[3].id)).toHaveLength(3);
});
test('compatible source/navigation edits reuse member capacity without deleting empty or unrelated intent at the 100-member limit', () => {
  const value = config(); value.widgets = Array.from({ length: 100 }, (_, i) => member('accounts', `widget:a-${i}`, null));
  const before = structuredClone(value.widgets); selectAggregateAccounts(value, [A]);
  expect(value.widgets).toHaveLength(100); expect(value.widgets[0].connection_ids).toEqual([A]); expect(value.widgets.slice(1)).toEqual(before.slice(1)); expect(value.widgets[0].sections).toEqual(before[0].sections);
  value.widgets = Array.from({ length: 100 }, (_, i) => member('shortcuts', `widget:n-${i}`, null)); const empty = structuredClone(value.widgets.slice(1));
  toggleAggregateLink(value, projects, link('docs'), true); expect(value.widgets).toHaveLength(100); expect(value.widgets[0].links).toEqual([link('docs')]); expect(value.widgets.slice(1)).toEqual(empty);
  toggleAggregateLink(value, projects, link('settings'), true); expect(value.widgets[0].links).toEqual([link('docs'), link('settings')]); expect(value.widgets).toHaveLength(100);
});
test('navigation activation does not activate other disabled global/project entries or drop repeated links', () => {
  const value = config(), widget = member('shortcuts', 'widget:disabled', null, []); widget.links = [link('settings'), link('settings'), link('docs'), link('inputs', P)]; value.widgets = [widget];
  toggleAggregateLink(value, projects, link('settings'), true);
  expect(aggregateLinks(value)).toEqual([link('settings'), link('settings')]); expect(aggregateLinks(value, P)).toEqual([]);
  expect(value.widgets[0].sections).toEqual([]); expect(value.widgets[0].links).toEqual([link('docs'), link('inputs', P)]);
});
test('grouped layout anchors are read-only, native saved cells win, and full/default/minimum slot budgets are exact', () => {
  const value = config(); value.widgets = [member('status', 'widget:a', P), member('messages', 'widget:b', P)];
  value.layout = [{ id: 'widget:a', x: 8, y: 20, w: 4, h: 10 }, { id: 'widget:b', x: 4, y: 10, w: 4, h: 10 }];
  const before = structuredClone(value), rows = aggregateRows(value, projects, []);
  expect(dashboardAggregateLayout(value, rows)).toEqual([{ id: P, x: 4, y: 10, w: 6, h: 24 }]); expect(value).toEqual(before);
  const native = { id: P, x: 0, y: 0, w: 6, h: 16 }; value.layout.push(native); expect(dashboardAggregateLayout(value, rows)).toEqual([native]);
  const sections = ['metrics', 'messages', 'distribution', 'delivery', 'recent'];
  expect(aggregateBudget(sections)).toEqual({ body: 436, visible: ['messages', 'metrics', 'distribution', 'delivery'], workers: 3 });
  expect(aggregateBudget(sections, { h: 10 })).toEqual({ body: 100, visible: ['messages'], workers: 0 });
  expect(aggregateBudget(sections, { h: 6 }).workers).toBe(0); expect(aggregateBudget(sections, { h: 80 }).workers).toBe(12);
});
test('real v4 storage ACK preserves members under layout-only patch, accepts local edits and rejects stale revision', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lush-aggregate-v4-')); chmodSync(home, 0o700);
  try {
    const device = { home }, initial = readDashboardSettings(device), value = config();
    const navigation = member('shortcuts', 'widget:custom', null, []); navigation.links = [link('versions', P), link('docs')];
    const status = member('status', 'widget:status', P, []); value.widgets = [status, navigation];
    const { version, revision, ...patch } = value;
    const stored = await saveDashboardSettings(device, patch, initial.revision), parsed = await readDashboardConfig({ value: stored });
    expect(aggregateRows(parsed, projects, []).map(row => row.id)).toEqual([P]);
    const layout = await saveDashboardSettings(device, { layout: [{ id: P, x: 0, y: 0, w: 6, h: 24 }] }, stored.revision);
    expect((await readDashboardConfig({ value: layout })).widgets).toEqual(stored.widgets);
    const draft = structuredClone(layout); toggleAggregateSection(draft, P, 'messages', true);
    const edited = await saveDashboardSettings(device, { widgets: draft.widgets }, layout.revision); expect(edited.widgets.slice(0, 2)).toEqual(stored.widgets);
    expect(() => saveDashboardSettings(device, { widgets: [] }, layout.revision)).toThrow('revision changed');
    expect(readDashboardSettings(device)).toEqual(edited);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
