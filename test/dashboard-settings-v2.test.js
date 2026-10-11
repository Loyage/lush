import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeDashboardPatch, readDashboardSettings, saveDashboardSettings } from '../src/core/dashboard-settings.js';
import { temp } from './helpers.js';

const project = '0123456789abcdef';
const account = () => ({ type: 'account', connection_id: randomUUID() });
const layout = (id = project) => ({ id, x: 0, y: 0, w: 12, h: 6 });
const projectSections = ['metrics', 'distribution', 'delivery', 'recent', 'messages', 'shortcuts'];
const accountSections = ['quota', 'balance', 'reset', 'observed', 'details', 'history', 'provenance'];
function fixture() {
  const root = temp(), config = { home: path.join(root, 'project'), deviceHome: path.join(root, 'device') };
  return { config, file: path.join(config.deviceHome, 'dashboard.json'),
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

test('v1 reads as complete v2 without rewriting bytes or metadata and only explicit save upgrades it', () => {
  const f = fixture(), selected = account();
  try {
    fs.mkdirSync(f.config.deviceHome, { mode: 0o700 });
    const source = JSON.stringify({ version: 1, cards: [selected] }, null, 4) + '\n';
    fs.writeFileSync(f.file, source, { mode: 0o600 });
    const stat = fs.statSync(f.file), model = readDashboardSettings(f.config);
    expect(model).toMatchObject({ version: 2, cards: [selected], hidden_projects: [], layout: [], content: [] });
    expect(readDashboardSettings(f.config)).toEqual(model);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(source);
    const after = fs.statSync(f.file);
    expect([after.ino, after.mtimeMs, after.ctimeMs]).toEqual([stat.ino, stat.mtimeMs, stat.ctimeMs]);
    const upgraded = saveDashboardSettings(f.config, { hidden_projects: [project] }, model.revision);
    expect(upgraded.cards).toEqual([selected]); expect(upgraded.hidden_projects).toEqual([project]);
    expect(upgraded.revision).not.toBe(model.revision);
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ version: 2, cards: [selected], hidden_projects: [project], layout: [], content: [] });
    expect(fs.existsSync(f.config.home)).toBe(false);
  } finally { f.close(); }
});

test('atomic partial patches and legacy card arrays preserve omitted fields; revision includes every field', () => {
  const f = fixture(), selected = account(), id = `account:${selected.connection_id}`;
  try {
    let current = readDashboardSettings(f.config);
    const patch = { cards: [selected], hidden_projects: [project, project], layout: [layout(), layout(id)],
      content: [{ id: project, sections: projectSections }, { id, sections: accountSections }] };
    current = saveDashboardSettings(f.config, patch, current.revision);
    expect(current.hidden_projects).toEqual([project]);
    const initial = current;
    for (const change of [{ hidden_projects: [] }, { layout: [{ ...layout(), x: 11, y: 4095, w: 1, h: 80 }] },
      { content: [{ id: project, sections: [] }] }, { cards: [] }]) {
      const previous = current;
      current = saveDashboardSettings(f.config, change, previous.revision);
      expect(current.revision).not.toBe(previous.revision);
      for (const key of ['cards', 'hidden_projects', 'layout', 'content']) {
        expect(current[key]).toEqual(Object.hasOwn(change, key) ? change[key] : previous[key]);
      }
      expect(() => saveDashboardSettings(f.config, { layout: [] }, previous.revision)).toThrow('revision changed');
      expect(readDashboardSettings(f.config)).toEqual(current);
    }
    current = saveDashboardSettings(f.config, [selected], current.revision);
    expect(current.cards).toEqual(initial.cards);
    expect(current.layout).toEqual([{ id: project, x: 11, y: 4095, w: 1, h: 80 }]);
    expect(current.content).toEqual([{ id: project, sections: [] }]);
    // IDs need not still be registered or selected: preserve deletion placeholders and their settings.
    current = saveDashboardSettings(f.config, { cards: [], content: [{ id, sections: [] }] }, current.revision);
    expect(current.content).toEqual([{ id, sections: [] }]);
    expect(readDashboardSettings(f.config)).toEqual(current);
    expect(fs.readdirSync(f.config.deviceHome)).toEqual(['dashboard.json']);
  } finally { f.close(); }
});

test('maximum board of 100 accounts and 300 hidden/layout/content entries privately round-trips', () => {
  const f = fixture();
  try {
    const ids = Array.from({ length: 300 }, (_, index) => index.toString(16).padStart(16, '0'));
    const patch = { cards: Array.from({ length: 100 }, account), hidden_projects: ids,
      layout: ids.map((id, index) => ({ id, x: index % 12, y: index * 10, w: 1, h: 80 })),
      content: ids.map(id => ({ id, sections: projectSections })) };
    const current = saveDashboardSettings(f.config, patch, readDashboardSettings(f.config).revision);
    expect(current).toMatchObject(patch);
    expect(readDashboardSettings(f.config)).toEqual(current);
    expect(fs.statSync(f.file).size).toBeGreaterThan(16384);
    expect(fs.statSync(f.file).size).toBeLessThanOrEqual(256 * 1024);
    expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
  } finally { f.close(); }
});

test('strict bounded patch validation rejects invalid geometry, identities and type-specific sections before storage', () => {
  const f = fixture(), id = `account:${randomUUID()}`;
  try {
    const invalid = [null, [], {}, { version: 2 }, { revision: 'x' }, { project: '/tmp' }, { credentials: [] },
      { hidden_projects: null }, { hidden_projects: [null] }, { hidden_projects: ['0123456789ABCDEF'] },
      { hidden_projects: [id] }, { hidden_projects: Array(1) }, { hidden_projects: Array(301).fill(project) },
      { layout: null }, { layout: [null] }, { layout: [layout(), layout()] }, { layout: Array(1) },
      { layout: [layout('0123456789ABCDEF')] }, { layout: [layout('account:not-uuid')] },
      { layout: [{ ...layout(), z: 0 }] }, { layout: [{ id: project, x: 0, y: 0, w: 1 }] },
      { layout: Array.from({ length: 301 }, (_, i) => layout(i.toString(16).padStart(16, '0'))) },
      { content: null }, { content: [null] }, { content: Array(1) }, { content: [{ id: project }] },
      { content: [{ id: project, sections: [], extra: true }] }, { content: [{ id: project, sections: null }] },
      { content: [{ id: project, sections: Array(1) }] }, { content: [{ id: project, sections: [1] }] },
      { content: [{ id: project, sections: ['quota'] }] }, { content: [{ id, sections: ['metrics'] }] },
      { content: [{ id, sections: ['unknown'] }] }, { content: [{ id, sections: [] }, { id, sections: [] }] },
      { content: Array.from({ length: 301 }, (_, i) => ({ id: i.toString(16).padStart(16, '0'), sections: [] })) }];
    for (const [key, values] of Object.entries({ x: [-1, 12, 0.5, '0', null, NaN, Infinity],
      y: [-1, 4096, 1.5], w: [0, 13, 2.5], h: [5, 81, 6.5] })) {
      for (const value of values) invalid.push({ layout: [{ ...layout(), [key]: value }] });
    }
    invalid.push({ layout: [{ ...layout(), x: 11, w: 2 }] });
    const revision = readDashboardSettings(f.config).revision;
    for (const patch of invalid) {
      expect(() => normalizeDashboardPatch(patch)).toThrow();
      // The old array signature intentionally treats [] as a valid cards-only update.
      if (!Array.isArray(patch)) expect(() => saveDashboardSettings(f.config, patch, revision)).toThrow();
    }
    expect(fs.existsSync(f.config.deviceHome)).toBe(false);
    expect(normalizeDashboardPatch({ layout: [layout(id.toUpperCase().replace('ACCOUNT:', 'account:'))],
      content: [{ id, sections: ['quota', 'quota'] }] })).toEqual({ layout: [layout(id)], content: [{ id, sections: ['quota'] }] });
    expect(() => normalizeDashboardPatch({ layout: [layout(id), layout(id.toUpperCase().replace('ACCOUNT:', 'account:'))] })).toThrow('duplicate');
  } finally { f.close(); }
});

test('v2 persisted invalid layouts and content fail closed without rewriting or returning stored secrets', () => {
  const f = fixture();
  try {
    const current = saveDashboardSettings(f.config, { cards: [] }, readDashboardSettings(f.config).revision);
    const { revision, ...settings } = current;
    for (const patch of [{ layout: [{ ...layout(), h: 0 }] }, { content: [{ id: project, sections: ['PRIVATE'] }] },
      { hidden_projects: ['PRIVATE'] }, { secret: 'PRIVATE' }, { layout: [layout(), layout()] }]) {
      const source = JSON.stringify({ ...settings, ...patch });
      fs.writeFileSync(f.file, source);
      expect(() => readDashboardSettings(f.config)).toThrow('dashboard settings cannot be safely read');
      expect(() => saveDashboardSettings(f.config, { cards: [] }, revision)).toThrow('cannot be safely read');
      expect(fs.readFileSync(f.file, 'utf8')).toBe(source);
    }
  } finally { f.close(); }
});
