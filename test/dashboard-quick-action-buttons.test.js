import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.js';
import { readDashboardSettings, saveDashboardSettings } from '../src/core/dashboard-settings.js';
import { readDashboardConfig } from '../src/ui/web/assets/dashboard-cards.js';
import { createUserServices } from '../src/host/user-services.js';
import { QUICK_ACTIONS, DEFAULT_QUICK_ACTION_BUTTONS, normalizeQuickActionButtons } from '../src/shared/dashboard-quick-actions.js';

test('button catalogue validates enums, deduplicates in fixed order, preserves empty and rejects invalid current reads', async () => {
  expect(DEFAULT_QUICK_ACTION_BUTTONS).toEqual(['safe_restart', 'auto_select']);
  expect(normalizeQuickActionButtons(['restart_all', 'resume_all', 'safe_restart', 'resume_all'])).toEqual(['safe_restart', 'resume_all', 'restart_all']);
  expect(normalizeQuickActionButtons([])).toEqual([]);
  for (const value of [null, {}, 'safe_restart', [null], [1], ['host_restart'], ['__proto__'], ['safe_restart', 'invalid']]) expect(() => normalizeQuickActionButtons(value)).toThrow();
  const root = temp(), config = { deviceHome: path.join(root, 'shared') };
  try {
    const initial = readDashboardSettings(config);
    await expect(readDashboardConfig({ value: { ...initial, quick_action_buttons: ['invalid'] } })).rejects.toThrow();
    const { quick_action_buttons, ...missing } = initial;
    await expect(readDashboardConfig({ value: missing })).rejects.toThrow();
    expect((await readDashboardConfig({ value: { ...missing, version: 6, quick_actions: false } })).quick_action_buttons).toEqual(DEFAULT_QUICK_ACTION_BUTTONS);
    expect(fs.existsSync(config.deviceHome)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Host saves button selection as strict partial revisioned settings, separate from device automation', async () => {
  const root = temp(), config = { deviceHome: path.join(root, 'shared') };
  let automationCalls = 0;
  const services = createUserServices({}, { dashboardService: { get: () => readDashboardSettings(config), save: (p, r) => saveDashboardSettings(config, p, r) },
    automationService: { get() { automationCalls++; }, save() { automationCalls++; } } });
  try {
    const before = await services.readDashboard();
    const layout = [{ id: 'widget:quick-actions', x: 6, y: 4, w: 6, h: 10 }];
    const picked = await services.saveDashboard({ quick_actions: false, quick_action_buttons: ['restart_all', 'auto_select', 'restart_all'], layout, expected_revision: before.revision });
    expect(picked.quick_action_buttons).toEqual(['auto_select', 'restart_all']); expect(picked.quick_actions).toBe(false);
    expect(picked.layout).toEqual(layout); expect(picked.widgets).toBeNull();
    await expect(services.saveDashboard({ quick_action_buttons: [], expected_revision: before.revision })).rejects.toThrow();
    const empty = await services.saveDashboard({ quick_action_buttons: [], expected_revision: picked.revision });
    expect(empty.quick_action_buttons).toEqual([]); expect(empty.layout).toEqual(layout); expect(empty.quick_actions).toBe(false);
    const all = await services.saveDashboard({ quick_action_buttons: QUICK_ACTIONS.map(item => item.id).reverse(), expected_revision: empty.revision });
    expect(all.quick_action_buttons).toEqual(QUICK_ACTIONS.map(item => item.id)); expect(all.cards).toEqual(before.cards);
    expect(automationCalls).toBe(0); expect(fs.readdirSync(config.deviceHome)).toEqual(['dashboard.json']);
    expect(await readDashboardConfig({ value: all })).toEqual(all);
  } finally { await services.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
