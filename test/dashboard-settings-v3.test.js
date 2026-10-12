import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeDashboardPatch, readDashboardSettings, saveDashboardSettings } from '../src/core/dashboard-settings.js';
import { createUserServices } from '../src/host/user-services.js';
import { temp } from './helpers.js';

const project = '0123456789abcdef';
const row = (id = 'accounts') => ({ id, x: 0, y: 4095, w: 12, h: 80 });
const sections = ['quota', 'balance', 'reset', 'observed', 'details', 'history', 'provenance'];
const card = () => ({ type: 'account', connection_id: randomUUID() });
function fixture() {
  const root = temp(), home = path.join(root, 'shared');
  return { root, config: { home }, file: path.join(home, 'dashboard.json'),
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

for (const version of [1, 2, 3]) test(`v${version} maps to a complete v4 model without altering bytes, then explicit save preserves legacy data`, () => {
  const f = fixture(), selected = card(), legacyId = `account:${selected.connection_id}`;
  try {
    const data = version === 1 ? { version, cards: [selected] } : { version, cards: [selected], hidden_projects: [project],
      layout: [row(legacyId), { ...row(project), x: 1, w: 11 }],
      content: [{ id: legacyId, sections: ['history', 'provenance'] }, { id: project, sections: ['messages'] }],
      ...(version === 3 ? { account_view: 'tiles' } : {}) };
    fs.mkdirSync(f.config.home, { mode: 0o700 });
    const source = JSON.stringify(data, null, 4) + '\n';
    fs.writeFileSync(f.file, source, { mode: 0o600 });
    const stat = fs.statSync(f.file), current = readDashboardSettings(f.config);
    const expected = { version: 4, cards: data.cards, hidden_projects: data.hidden_projects || [],
      layout: data.layout || [], content: data.content || [], account_view: version === 3 ? 'tiles' : 'list', widgets: null };
    expect(current).toMatchObject(expected);
    expect(Object.keys(current).sort()).toEqual(['version', 'revision', 'cards', 'hidden_projects', 'layout', 'content', 'account_view', 'widgets'].sort());
    expect(readDashboardSettings(f.config)).toEqual(current);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(source);
    const after = fs.statSync(f.file);
    expect([after.ino, after.size, after.mtimeMs, after.ctimeMs]).toEqual([stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
    const nextView = current.account_view === 'list' ? 'tiles' : 'list';
    const saved = saveDashboardSettings(f.config, { account_view: nextView }, current.revision);
    expect(saved).toMatchObject({ ...expected, account_view: nextView });
    expect(saved.revision).not.toBe(current.revision);
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ ...expected, account_view: nextView });
    expect(readDashboardSettings(f.config)).toEqual(saved);
    // No automatic legacy-to-reserved-ID layout/content migration.
    expect(saved.layout.some(item => item.id === 'accounts')).toBe(false);
    expect(saved.content.some(item => item.id === 'accounts')).toBe(false);
  } finally { f.close(); }
});

test('account_view participates in revision and all patches and legacy cards arrays preserve omitted v3 fields', () => {
  const f = fixture(), selected = card(), oldId = `account:${selected.connection_id}`;
  try {
    const initial = readDashboardSettings(f.config);
    expect(initial.account_view).toBe('list'); expect(fs.existsSync(f.config.home)).toBe(false);
    const layout = [row(), row(oldId), row(project)], content = [{ id: 'accounts', sections }, { id: oldId, sections: [] }];
    let current = saveDashboardSettings(f.config, { cards: [selected], hidden_projects: [project], layout, content }, initial.revision);
    const stable = current;
    for (const patch of [{ account_view: 'tiles' }, { cards: [] }, { hidden_projects: [] },
      { layout: [...layout, row('aaaaaaaaaaaaaaaa')] }, { content: [...content, { id: project, sections: ['shortcuts'] }] },
      { account_view: 'list' }]) {
      const before = current;
      current = saveDashboardSettings(f.config, patch, before.revision);
      expect(current.revision).not.toBe(before.revision);
      for (const key of ['cards', 'hidden_projects', 'layout', 'content', 'account_view']) {
        expect(current[key]).toEqual(Object.hasOwn(patch, key) ? patch[key] : before[key]);
      }
      expect(() => saveDashboardSettings(f.config, { account_view: 'tiles' }, before.revision)).toThrow('revision changed');
    }
    current = saveDashboardSettings(f.config, [selected], current.revision);
    expect(current).toMatchObject({ cards: stable.cards, account_view: 'list', hidden_projects: [],
      layout: [...layout, row('aaaaaaaaaaaaaaaa')], content: [...content, { id: project, sections: ['shortcuts'] }] });
    expect(readDashboardSettings(f.config)).toEqual(current);
    expect(fs.readdirSync(f.config.home)).toEqual(['dashboard.json']);
  } finally { f.close(); }
});

test('reserved accounts ID uses account sections and strict uniqueness, geometry and list/tiles whitelist', () => {
  const f = fixture();
  try {
    expect(normalizeDashboardPatch({ account_view: 'list', layout: [row()], content: [{ id: 'accounts', sections }] }))
      .toEqual({ layout: [row()], content: [{ id: 'accounts', sections }], account_view: 'list' });
    expect(normalizeDashboardPatch({ account_view: 'tiles', content: [{ id: 'accounts', sections: [] }] }))
      .toEqual({ content: [{ id: 'accounts', sections: [] }], account_view: 'tiles' });
    const invalid = [null, true, 0, '', 'LIST', 'Tiles', 'grid', [], {}].map(account_view => ({ account_view }));
    invalid.push({ account_view: 'list', version: 3 }, { hidden_projects: ['accounts'] },
      { layout: [row(), row()] }, { content: [{ id: 'accounts', sections: [] }, { id: 'accounts', sections: [] }] },
      ...['Accounts', 'ACCOUNTS', 'account', 'accounts:', 'accounts:private', '/accounts'].map(id => ({ layout: [row(id)] })),
      ...['metrics', 'distribution', 'delivery', 'recent', 'messages', 'shortcuts', 'PRIVATE'].map(section =>
        ({ content: [{ id: 'accounts', sections: [section] }] })),
      { layout: [{ ...row(), h: 81 }] }, { layout: [{ ...row(), x: 1 }] },
      { content: [{ id: 'accounts', sections: null }] }, { content: [{ id: 'accounts', sections: [null] }] },
      { content: [{ id: 'accounts', sections: [], credential: 'PRIVATE' }] });
    const revision = readDashboardSettings(f.config).revision;
    for (const patch of invalid) {
      expect(() => normalizeDashboardPatch(patch)).toThrow();
      expect(() => saveDashboardSettings(f.config, patch, revision)).toThrow();
    }
    expect(fs.existsSync(f.config.home)).toBe(false);
    const ids = Array.from({ length: 300 }, (_, i) => i.toString(16).padStart(16, '0'));
    expect(() => normalizeDashboardPatch({ layout: [row(), ...ids.map(row)] })).toThrow('300');
    expect(() => normalizeDashboardPatch({ content: [{ id: 'accounts', sections: [] }, ...ids.map(id => ({ id, sections: [] }))] })).toThrow('300');
    expect(normalizeDashboardPatch({ layout: [row(), ...ids.slice(1).map(row)] }).layout).toHaveLength(300);
    expect(normalizeDashboardPatch({ content: [{ id: 'accounts', sections }, ...ids.slice(1).map(id => ({ id, sections: [] }))] }).content).toHaveLength(300);
  } finally { f.close(); }
});

test('v4 files must contain all fields and reject invalid versions/views without rewriting or exposing contents', () => {
  const f = fixture();
  try {
    const current = saveDashboardSettings(f.config, { account_view: 'tiles', layout: [row()] }, readDashboardSettings(f.config).revision);
    const { revision, ...settings } = current;
    const invalid = [null, [], { ...settings, version: 5 }, { ...settings, version: 2 },
      { ...settings, account_view: 'PRIVATE' }, { ...settings, account_view: null }, { ...settings, revision: 'PRIVATE' },
      ...Object.keys(settings).map(key => Object.fromEntries(Object.entries(settings).filter(([name]) => name !== key)))];
    for (const data of invalid) {
      const source = JSON.stringify(data); fs.writeFileSync(f.file, source);
      expect(() => readDashboardSettings(f.config)).toThrow('dashboard settings cannot be safely read');
      expect(() => saveDashboardSettings(f.config, { account_view: 'list' }, revision)).toThrow('cannot be safely read');
      expect(fs.readFileSync(f.file, 'utf8')).toBe(source);
    }
  } finally { f.close(); }
});

test('v3 publication failure leaves prior full settings and revision intact and removes only its temporary file', () => {
  const f = fixture(), original = fs.renameSync;
  try {
    const current = saveDashboardSettings(f.config, { account_view: 'tiles', layout: [row()], content: [{ id: 'accounts', sections }] },
      readDashboardSettings(f.config).revision);
    const source = fs.readFileSync(f.file, 'utf8');
    fs.renameSync = function(from, to) {
      if (to === f.file) throw new Error('PRIVATE filesystem response');
      return original.call(this, from, to);
    };
    expect(() => saveDashboardSettings(f.config, { account_view: 'list', cards: [card()] }, current.revision)).toThrow();
    expect(fs.readFileSync(f.file, 'utf8')).toBe(source);
    expect(readDashboardSettings(f.config)).toEqual(current);
    expect(fs.readdirSync(f.config.home)).toEqual(['dashboard.json']);
  } finally { fs.renameSync = original; f.close(); }
});

test('two lazy Host clients share v3 settings and preserve legacy source identities without daemon or account reads', async () => {
  const root = temp(), env = { LUSH_GLOBAL_CONFIG: root }, home = path.join(root, 'shared');
  const host = { require() { throw new Error('must not start a daemon'); }, openRoute() { throw new Error('must not start a daemon'); } };
  const a = createUserServices(host, { env }), b = createUserServices(host, { env }), selected = card();
  try {
    fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(path.join(home, 'credentials'), { mode: 0o700 });
    const credentials = path.join(home, 'credentials', 'agent-connections.json');
    fs.writeFileSync(credentials, 'PRIVATE INVALID CREDENTIALS', { mode: 0o600 });
    const oldId = `account:${selected.connection_id}`, data = { version: 2, cards: [selected], hidden_projects: [project],
      layout: [row(oldId)], content: [{ id: oldId, sections: ['history'] }] };
    const file = path.join(home, 'dashboard.json'), source = JSON.stringify(data); fs.writeFileSync(file, source, { mode: 0o600 });
    const first = await a.readDashboard(); expect(first).toEqual(await b.readDashboard());
    expect(first).toMatchObject({ ...data, version: 4, account_view: 'list', widgets: null });
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
    const next = await a.saveDashboard({ account_view: 'tiles', expected_revision: first.revision });
    expect(await b.readDashboard()).toEqual(next);
    await expect(b.saveDashboard({ account_view: 'list', expected_revision: first.revision })).rejects.toThrow('可能版本已变更');
    const updated = await b.saveDashboard({ content: [...next.content, { id: 'accounts', sections }], expected_revision: next.revision });
    expect(updated).toMatchObject({ ...next, revision: updated.revision, content: [...next.content, { id: 'accounts', sections }] });
    expect(await a.readDashboard()).toEqual(updated);
    expect(fs.readFileSync(credentials, 'utf8')).toBe('PRIVATE INVALID CREDENTIALS');
  } finally { await Promise.all([a.close(), b.close()]); fs.rmSync(root, { recursive: true, force: true }); }
});
