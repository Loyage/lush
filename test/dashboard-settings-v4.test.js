import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeDashboardPatch, readDashboardSettings, saveDashboardSettings } from '../src/core/dashboard-settings.js';
import { acquireConfigurationLock } from '../src/core/device-config.js';
import { temp } from './helpers.js';

const project = '0123456789abcdef';
const sections = { status: ['metrics', 'distribution', 'delivery'], messages: ['messages'], workers: ['recent'],
  accounts: ['quota', 'balance', 'reset', 'observed', 'details', 'history', 'provenance'], shortcuts: ['shortcuts'] };
const widget = (type = 'status', id = `widget:${type}`) => ({ id, type,
  project_id: ['status', 'messages', 'workers'].includes(type) ? project : null,
  connection_ids: [], links: [], sections: [...(sections[type] || [])] });
const layout = id => ({ id, x: 0, y: 0, w: 12, h: 6 });
function fixture() {
  const root = temp(), home = path.join(root, 'shared');
  return { config: { home }, file: path.join(home, 'dashboard.json'),
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

test('v4 widgets preserve all legacy data and distinguish projection/null from an empty board across patches', () => {
  const f = fixture(), connection_id = randomUUID(), oldId = `account:${connection_id}`;
  try {
    let current = readDashboardSettings(f.config);
    expect(current).toMatchObject({ version: 4, widgets: null });
    expect(fs.existsSync(f.config.home)).toBe(false);
    const legacy = { cards: [{ type: 'account', connection_id }], hidden_projects: [project],
      layout: [layout(project), layout(oldId)], content: [{ id: oldId, sections: ['history'] }], account_view: 'tiles' };
    current = saveDashboardSettings(f.config, legacy, current.revision);
    const cards = [widget(), widget('status', 'widget:second'), widget('accounts')];
    cards[2].connection_ids = [connection_id.toUpperCase(), connection_id];
    cards[0].sections.push('metrics');
    const normalized = normalizeDashboardPatch({ widgets: cards }).widgets;
    expect(normalized[2].connection_ids).toEqual([connection_id]);
    expect(normalized[0].sections).toEqual(sections.status);
    const added = saveDashboardSettings(f.config, { widgets: cards, layout: [...legacy.layout, layout('widget:second')] }, current.revision);
    expect(added).toMatchObject({ ...legacy, widgets: normalized, layout: [...legacy.layout, layout('widget:second')] });
    expect(readDashboardSettings(f.config)).toEqual(added);
    expect(() => saveDashboardSettings(f.config, { widgets: [] }, current.revision)).toThrow('revision changed');
    const changed = saveDashboardSettings(f.config, [], added.revision);
    expect(changed).toMatchObject({ ...added, cards: [], revision: changed.revision });
    const empty = saveDashboardSettings(f.config, { widgets: [] }, changed.revision);
    expect(empty.widgets).toEqual([]); expect(empty.revision).not.toBe(changed.revision);
    expect(readDashboardSettings(f.config)).toEqual(empty);
    const projected = saveDashboardSettings(f.config, { widgets: null }, empty.revision);
    expect(projected.widgets).toBeNull(); expect(projected.revision).not.toBe(empty.revision);
    expect(projected.layout).toEqual(added.layout); expect(projected.content).toEqual(legacy.content);
    expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(f.config.home)).toEqual(['dashboard.json']);
  } finally { f.close(); }
});

test('all widget types and whitelisted shortcuts round-trip without looking up project/account existence', () => {
  const f = fixture();
  try {
    const widgets = Object.keys(sections).map(type => widget(type));
    widgets[3].connection_ids = Array.from({ length: 100 }, () => randomUUID());
    widgets[4].links = [
      ...['notices', 'project-management', 'model-sources', 'settings', 'agent-status', 'automation', 'docs']
        .map(target => ({ scope: 'global', target, project_id: null })),
      ...['workers', 'inputs', 'versions', 'notices'].map(target => ({ scope: 'project', target, project_id: project })),
    ];
    const before = readDashboardSettings(f.config);
    const saved = saveDashboardSettings(f.config, { widgets, layout: widgets.map(card => layout(card.id)) }, before.revision);
    expect(saved.widgets).toEqual(widgets); expect(readDashboardSettings(f.config)).toEqual(saved);
    expect(normalizeDashboardPatch({ widgets: widgets.map(card => ({ ...card, sections: [] })) }).widgets.every(card => !card.sections.length)).toBe(true);
    expect(normalizeDashboardPatch({ widgets: Array.from({ length: 100 }, (_, i) => widget('status', `widget:${i}`)) }).widgets).toHaveLength(100);
    expect(normalizeDashboardPatch({ widgets: [{ ...widget('shortcuts'), links: Array(24).fill(widgets[4].links[0]) }] }).widgets[0].links).toHaveLength(24);
    expect(normalizeDashboardPatch({ widgets: [widget('status', `widget:a${'b'.repeat(79)}`)] }).widgets).toHaveLength(1);
    const lock = acquireConfigurationLock(f.config, 'project');
    try { expect(() => saveDashboardSettings(f.config, { widgets: [] }, saved.revision)).toThrow('busy'); }
    finally { lock.release(); }
    expect(readDashboardSettings(f.config)).toEqual(saved);
  } finally { f.close(); }
});

test('strict widget schemas, limits, identities and per-type field combinations reject before storage', () => {
  const f = fixture(), base = widget(), shortcut = widget('shortcuts');
  const link = { scope: 'global', target: 'docs', project_id: null };
  try {
    const invalidWidgets = [undefined, true, 0, '', {}, [null], Array(1), Array(101).fill(base), [base, base]];
    const badCards = [null, [], { ...base, secret: 'PRIVATE' }, ...Object.keys(base).map(key =>
      Object.fromEntries(Object.entries(base).filter(([name]) => name !== key)))];
    for (const id of ['', 'widget:', 'Widget:a', 'widget:A', 'widget:-a', 'widget:a_b', 'widget:a/b', 'widget:a'.padEnd(88, 'b'), project, null, 1]) badCards.push({ ...base, id });
    for (const type of ['account', 'constructor', '__proto__', 'unknown', null, 1]) badCards.push({ ...base, type });
    for (const project_id of [null, '', '0123456789ABCDEF', 'a'.repeat(15), 'a'.repeat(17), 1]) badCards.push({ ...base, project_id });
    for (const type of Object.keys(sections)) {
      const card = widget(type);
      badCards.push({ ...card, sections: null }, { ...card, sections: Array(1) }, { ...card, sections: [1] }, { ...card, sections: ['unknown'] });
      for (const section of Object.values(sections).flat().filter(section => !sections[type].includes(section))) badCards.push({ ...card, sections: [section] });
      if (type === 'accounts') {
        for (const connection_ids of [null, [null], Array(1), ['not-uuid'], Array(101).fill(randomUUID())]) badCards.push({ ...card, connection_ids });
      } else badCards.push({ ...card, connection_ids: [randomUUID()] });
      if (!['status', 'messages', 'workers'].includes(type)) badCards.push({ ...card, project_id: project });
      if (type !== 'shortcuts') badCards.push({ ...card, links: [link] });
      badCards.push({ ...card, links: null }, { ...card, connection_ids: null });
    }
    const badLinks = [null, [], { ...link, extra: true }, ...Object.keys(link).map(key =>
      Object.fromEntries(Object.entries(link).filter(([name]) => name !== key))),
      { ...link, scope: 'other' }, { ...link, target: 'workers' }, { ...link, target: 'javascript:alert(1)' },
      { ...link, project_id: project }, { scope: 'project', target: 'settings', project_id: project },
      ...[null, '0123456789ABCDEF', 1].map(project_id => ({ scope: 'project', target: 'workers', project_id }))];
    badCards.push(...badLinks.map(bad => ({ ...shortcut, links: [bad] })), { ...shortcut, links: Array(1) },
      { ...shortcut, links: Array(25).fill(link) });
    invalidWidgets.push(...badCards.map(card => [card]));
    const revision = readDashboardSettings(f.config).revision;
    for (const widgets of invalidWidgets) {
      expect(() => normalizeDashboardPatch({ widgets })).toThrow();
      expect(() => saveDashboardSettings(f.config, { widgets }, revision)).toThrow();
    }
    expect(() => normalizeDashboardPatch({ content: [{ id: base.id, sections: ['metrics'] }] })).toThrow();
    expect(() => normalizeDashboardPatch({ layout: [layout(base.id), layout(base.id)] })).toThrow('duplicate');
    expect(fs.existsSync(f.config.home)).toBe(false);
  } finally { f.close(); }
});

test('v4 retains total byte budget and atomic failure protection for full widget documents', () => {
  const f = fixture(), original = fs.renameSync;
  try {
    const saved = saveDashboardSettings(f.config, { widgets: [widget()] }, readDashboardSettings(f.config).revision);
    const source = fs.readFileSync(f.file, 'utf8');
    const widgets = Array.from({ length: 100 }, (_, i) => ({ ...widget('accounts', `widget:${i}`),
      connection_ids: Array.from({ length: 100 }, () => randomUUID()) }));
    expect(normalizeDashboardPatch({ widgets }).widgets).toHaveLength(100);
    expect(() => saveDashboardSettings(f.config, { widgets }, saved.revision)).toThrow('too large');
    expect(fs.readFileSync(f.file, 'utf8')).toBe(source);
    fs.renameSync = function(from, to) { if (to === f.file) throw new Error('PRIVATE'); return original.call(this, from, to); };
    expect(() => saveDashboardSettings(f.config, { widgets: [] }, saved.revision)).toThrow();
    expect(readDashboardSettings(f.config)).toEqual(saved);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(source);
    expect(fs.readdirSync(f.config.home)).toEqual(['dashboard.json']);
  } finally { fs.renameSync = original; f.close(); }
});

test('legacy v3 remains strict and complete; v4 refuses unsafe or malformed widgets without repair', () => {
  const f = fixture();
  try {
    const saved = saveDashboardSettings(f.config, { widgets: [widget()] }, readDashboardSettings(f.config).revision);
    const { revision, ...settings } = saved;
    const { widgets, ...v3 } = settings;
    const legacy = { ...v3, version: 3 };
    fs.writeFileSync(f.file, JSON.stringify(legacy));
    expect(readDashboardSettings(f.config)).toMatchObject({ ...settings, widgets: null });
    const invalid = [{ ...legacy, widgets: null }, { ...legacy, layout: [layout('widget:a')] },
      ...Object.keys(legacy).map(key => Object.fromEntries(Object.entries(legacy).filter(([name]) => name !== key))),
      { ...settings, widgets: undefined }, { ...settings, widgets: [{ ...widget(), connection_ids: ['PRIVATE'] }] }];
    for (const data of invalid) {
      const source = JSON.stringify(data); fs.writeFileSync(f.file, source);
      expect(() => readDashboardSettings(f.config)).toThrow('cannot be safely read');
      expect(() => saveDashboardSettings(f.config, { widgets: [] }, revision)).toThrow('cannot be safely read');
      expect(fs.readFileSync(f.file, 'utf8')).toBe(source);
    }
    fs.writeFileSync(f.file, JSON.stringify(settings)); fs.chmodSync(f.file, 0o644);
    expect(() => readDashboardSettings(f.config)).toThrow('cannot be safely read');
    expect(() => saveDashboardSettings(f.config, { widgets: [] }, revision)).toThrow('cannot be safely read');
  } finally { f.close(); }
});
