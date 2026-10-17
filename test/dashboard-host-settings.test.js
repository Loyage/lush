import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.js';
import { createUserServices } from '../src/host/user-services.js';
import { readDashboardSettings, saveDashboardSettings } from '../src/core/dashboard-settings.js';
import { readDashboardConfig } from '../src/ui/web/assets/dashboard-cards.js';
import { createDashboardHistory, dashboardPatch } from '../src/ui/web/assets/dashboard-edit-model.js';

test('Host dashboard adapter validates quick_actions and returns shared v7 ACK with optimistic revision', async () => {
  const root = temp(), config = { deviceHome: path.join(root, 'shared') };
  const services = createUserServices({}, { dashboardService: {
    get: () => readDashboardSettings(config), save: (patch, revision) => saveDashboardSettings(config, patch, revision),
  } });
  try {
    const before = await readDashboardConfig({ value: await services.readDashboard() });
    expect(before.quick_actions).toBe(true);
    for (const quick_actions of [null, 'false', 0, {}]) await expect(services.saveDashboard({ quick_actions, expected_revision: before.revision })).rejects.toThrow();
    await expect(services.saveDashboard({ quick_actions: false, unexpected: true, expected_revision: before.revision })).rejects.toThrow();
    const next = await readDashboardConfig({ value: await services.saveDashboard({ quick_actions: false, expected_revision: before.revision }) });
    expect(next.version).toBe(7); expect(next.quick_actions).toBe(false);
    await expect(services.saveDashboard({ quick_actions: true, expected_revision: before.revision })).rejects.toThrow();
    expect(await services.readDashboard()).toEqual(next);
    await expect(readDashboardConfig({ value: { ...next, quick_actions: 'false' } })).rejects.toThrow();
    const { quick_actions, ...legacy } = next;
    expect((await readDashboardConfig({ value: { ...legacy, version: 5 } })).quick_actions).toBe(true);
    await expect(readDashboardConfig({ value: { ...legacy, version: 6 } })).rejects.toThrow();
  } finally { await services.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('quick action selection and canonical geometry are a single undoable draft patch', () => {
  const config = { quick_actions: true, widgets: null, cards: [], layout: [], diagnostics: false };
  const history = createDashboardHistory({ config, layoutDraft: [], layoutDirty: false });
  const next = { ...config, quick_actions: false, layout: [{ id: 'widget:quick-actions', x: 6, y: 0, w: 6, h: 12 }] };
  history.push({ config: next, layoutDraft: next.layout, layoutDirty: true });
  expect(dashboardPatch(config, next)).toEqual({ layout: next.layout, quick_actions: false });
  expect(history.undo().config).toEqual(config);
  expect(history.redo().config).toEqual(next);
  expect(config.quick_actions).toBe(true);
});
