import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.js';
import { readDashboardSettings, saveDashboardSettings } from '../src/core/dashboard-settings.js';
import { readDashboardConfig } from '../src/ui/web/assets/dashboard-cards.js';
import { createUserServices } from '../src/host/user-services.js';

test('Host saves button selection as partial revisioned settings, separate from device automation', async () => {
  const root = temp(), config = { deviceHome: path.join(root, 'shared') };
  let automationCalls = 0;
  const services = createUserServices({}, { dashboardService: { get: () => readDashboardSettings(config), save: (p, r) => saveDashboardSettings(config, p, r) },
    automationService: { get() { automationCalls++; }, save() { automationCalls++; } } });
  try {
    const before = await services.readDashboard();
    const layout = [{ id: 'widget:quick-actions', x: 6, y: 4, w: 6, h: 10 }];
    const picked = await services.saveDashboard({ quick_actions: false, quick_action_buttons: ['auto_select', 'restart_all'], layout, expected_revision: before.revision });
    expect(picked.quick_action_buttons).toEqual(['auto_select', 'restart_all']); expect(picked.quick_actions).toBe(false);
    expect(picked.layout).toEqual(layout); expect(picked.cards).toEqual(before.cards);
    expect(automationCalls).toBe(0); expect(fs.readdirSync(config.deviceHome)).toEqual(['dashboard.json']);
    expect(await readDashboardConfig({ value: picked })).toEqual(picked);
  } finally { await services.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
