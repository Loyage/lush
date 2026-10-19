import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readDashboardSettings, saveDashboardSettings } from '../src/core/dashboard-settings.js';
import { temp } from './helpers.js';

test('dashboard selection is device-authoritative and privately published', () => {
  const root = temp(), config = { home: path.join(root, 'project', '.lush'), deviceHome: path.join(root, 'device', 'shared') };
  try {
    const before = readDashboardSettings(config), selected = { type: 'account', connection_id: randomUUID() };
    expect(before).toMatchObject({ version: 7, cards: [], quick_actions: true, quick_action_buttons: ['safe_restart', 'auto_select'] });
    expect(fs.existsSync(config.deviceHome)).toBe(false);
    const next = saveDashboardSettings(config, [selected], before.revision);
    expect(next.cards).toEqual([selected]); expect(next.revision).not.toBe(before.revision);
    expect(readDashboardSettings({ ...config, home: path.join(root, 'other-project') })).toEqual(next);
    expect(fs.existsSync(config.home)).toBe(false);
    expect(fs.statSync(config.deviceHome).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(config.deviceHome, 'dashboard.json')).mode & 0o777).toBe(0o600);
    expect(saveDashboardSettings(config, [], next.revision).cards).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
