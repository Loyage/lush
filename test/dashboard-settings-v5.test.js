import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { readDashboardSettings, saveDashboardSettings, normalizeDashboardPatch } from '../src/core/dashboard-settings.js';
import { temp } from './helpers.js';

const project = '0123456789abcdef', connection_id = '11111111-1111-4111-8111-111111111111';
const legacy = { cards: [{ type: 'account', connection_id }], hidden_projects: [project],
  layout: [{ id: project, x: 1, y: 3, w: 4, h: 6 }], content: [{ id: project, sections: [] }], account_view: 'tiles' };
for (const version of [1, 2, 3, 4]) test(`v${version} diagnostics is read-only/default true; explicit toggle preserves original fields and null/[]`, () => {
  for (const widgets of version === 4 ? [null, []] : [undefined]) {
    const root = temp(), home = path.join(root, 'shared'), file = path.join(home, 'dashboard.json'), config = { home };
    try {
      fs.mkdirSync(home, { mode: 0o700 });
      const data = { version, cards: legacy.cards, ...(version >= 2 ? { hidden_projects: legacy.hidden_projects, layout: legacy.layout, content: legacy.content } : {}),
        ...(version >= 3 ? { account_view: 'tiles' } : {}), ...(version === 4 ? { widgets } : {}) };
      const bytes = JSON.stringify(data, null, 4) + '\n'; fs.writeFileSync(file, bytes, { mode: 0o600 });
      const before = fs.statSync(file), model = readDashboardSettings(config);
      expect(model.version).toBe(5); expect(model.diagnostics).toBe(true); expect(model.widgets).toEqual(widgets ?? null);
      expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
      const after = fs.statSync(file); expect([after.ino, after.mtimeMs, after.ctimeMs]).toEqual([before.ino, before.mtimeMs, before.ctimeMs]);
      const saved = saveDashboardSettings(config, { diagnostics: false }, model.revision);
      expect(saved).toEqual({ ...model, diagnostics: false, revision: saved.revision }); expect(saved.revision).not.toBe(model.revision);
      expect(() => saveDashboardSettings(config, { diagnostics: true }, model.revision)).toThrow('revision changed');
      const layout = [...saved.layout, { id: 'widget:diagnostics', x: 0, y: 24, w: 6, h: 18 }];
      const moved = saveDashboardSettings(config, { layout }, saved.revision);
      expect(moved.diagnostics).toBe(false); expect(moved.widgets).toEqual(widgets ?? null);
      const arraySaved = saveDashboardSettings(config, [], moved.revision);
      expect(arraySaved).toEqual({ ...moved, cards: [], revision: arraySaved.revision });
      expect(readDashboardSettings(config)).toEqual(arraySaved); expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(home)).toEqual(['dashboard.json']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
test('diagnostics patch is strict boolean and never consumes widget membership/limit', () => {
  for (const diagnostics of [null, undefined, 0, 1, 'true', [], {}]) expect(() => normalizeDashboardPatch({ diagnostics })).toThrow('diagnostics');
  expect(() => normalizeDashboardPatch({ diagnostics: true, extra: false })).toThrow('fields');
  const widgets = Array.from({ length: 100 }, (_, i) => ({ id: `widget:member-${i}`, type: 'status', project_id: project, connection_ids: [], links: [], sections: [] }));
  expect(normalizeDashboardPatch({ diagnostics: true, widgets }).widgets).toHaveLength(100);
  expect(() => normalizeDashboardPatch({ diagnostics: true, widgets: [...widgets, { ...widgets[0], id: 'widget:extra' }] })).toThrow('100');
});
test('v5 requires diagnostics; v1-v4 must not smuggle a v5 field and malformed files stay untouched', () => {
  const root = temp(), config = { home: path.join(root, 'shared') }, file = path.join(config.home, 'dashboard.json');
  try {
    fs.mkdirSync(config.home, { mode: 0o700 });
    for (const data of [{ version: 5, ...legacy, widgets: null }, { version: 5, ...legacy, widgets: [], diagnostics: 'false' },
      { version: 4, ...legacy, widgets: [], diagnostics: false }]) {
      const bytes = JSON.stringify(data); fs.writeFileSync(file, bytes, { mode: 0o600 });
      expect(() => readDashboardSettings(config)).toThrow('safely read'); expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
