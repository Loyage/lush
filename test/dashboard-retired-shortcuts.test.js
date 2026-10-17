import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.js';
import { readDashboardSettings, saveDashboardSettings } from '../src/core/dashboard-settings.js';

const widget = links => ({ id: 'widget:shortcuts', type: 'shortcuts', project_id: null,
  connection_ids: [], links, sections: ['shortcuts'] });
const retiredLink = { scope: 'global', target: 'runners', project_id: null };

test('retired node shortcuts remain read-only compatible without allowing new node navigation configuration', () => {
  const root = temp(), config = { deviceHome: path.join(root, 'shared') };
  try {
    const initial = readDashboardSettings(config);
    expect(() => saveDashboardSettings(config, { widgets: [widget([retiredLink])] }, initial.revision))
      .toThrow('invalid dashboard shortcut target');
    expect(fs.existsSync(config.deviceHome)).toBe(false);
    const saved = saveDashboardSettings(config, { widgets: [widget([])] }, initial.revision);
    const file = path.join(config.deviceHome, 'dashboard.json');
    const { revision, ...legacy } = saved;
    legacy.widgets[0].links.push(retiredLink);
    fs.writeFileSync(file, JSON.stringify(legacy) + '\n', { mode: 0o600 });
    const source = fs.readFileSync(file, 'utf8');
    const before = readDashboardSettings(config);
    expect(before.widgets[0].links).toEqual([retiredLink]);
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
    expect(() => saveDashboardSettings(config, { widgets: before.widgets }, before.revision))
      .toThrow('invalid dashboard shortcut target');
    const changed = saveDashboardSettings(config, { diagnostics: false }, before.revision);
    expect(changed.widgets[0].links).toEqual([retiredLink]);
    expect(changed.diagnostics).toBe(false);
    expect(readDashboardSettings(config)).toEqual(changed);
    const cleaned = saveDashboardSettings(config, { widgets: [widget([])] }, changed.revision);
    expect(cleaned.widgets[0].links).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
