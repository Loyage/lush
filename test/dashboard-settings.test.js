import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readDashboardSettings, saveDashboardSettings } from '../src/core/dashboard-settings.js';
import { acquireConfigurationLock } from '../src/core/device-config.js';
import { readDevicePreferences, saveDevicePreferences } from '../src/core/device-preferences.js';
import { temp } from './helpers.js';

const card = (connection_id = randomUUID()) => ({ type: 'account', connection_id });
function fixture() {
  const root = temp(), config = { home: path.join(root, 'project', '.lush'), deviceHome: path.join(root, 'device', 'shared') };
  return { root, config, file: path.join(config.deviceHome, 'dashboard.json'),
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('dashboard selection is read-only when absent, device-authoritative, deduplicated and privately published', () => {
  const f = fixture();
  try {
    const before = readDashboardSettings(f.config), selected = card();
    expect(before).toMatchObject({ version: 7, cards: [], hidden_projects: [], layout: [], content: [], account_view: 'list', widgets: null, diagnostics: true, quick_actions: true, quick_action_buttons: ['safe_restart', 'auto_select'] }); expect(before.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(f.config.deviceHome)).toBe(false);
    const next = saveDashboardSettings(f.config, [selected, { ...selected, connection_id: selected.connection_id.toUpperCase() }], before.revision);
    expect(next.cards).toEqual([selected]); expect(next.revision).not.toBe(before.revision);
    expect(readDashboardSettings({ home: f.config.deviceHome })).toEqual(next);
    expect(readDashboardSettings({ ...f.config, home: path.join(f.root, 'other-project') })).toEqual(next);
    next.cards[0].connection_id = randomUUID(); expect(readDashboardSettings(f.config).cards).toEqual([selected]);
    expect(fs.existsSync(f.config.home)).toBe(false);
    expect(fs.statSync(f.config.deviceHome).mode & 0o777).toBe(0o700);
    expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ version: 7, cards: [selected], hidden_projects: [], layout: [], content: [], account_view: 'list', widgets: null, diagnostics: true, quick_actions: true, quick_action_buttons: ['safe_restart', 'auto_select'] });
    expect(fs.readdirSync(f.config.deviceHome)).toEqual(['dashboard.json']);
    // No source exists: its identity is still retained for a frontend placeholder, without credential reads.
    const cleared = saveDashboardSettings(f.config, [], readDashboardSettings(f.config).revision);
    expect(cleared.cards).toEqual([]);
  } finally { f.close(); }
});

test('dashboard rejects invalid cards and revisions before creating storage', () => {
  const f = fixture();
  try {
    const before = readDashboardSettings(f.config), selected = card();
    for (const cards of [null, {}, [null], [[]], [{}], [{ type: 'account' }], [{ connection_id: selected.connection_id }],
      [{ ...selected, type: 'project' }], [{ ...selected, connection_id: '/tmp/secret' }], [{ ...selected, connection_id: 1 }],
      [{ ...selected, credential: 'PRIVATE' }], [{ ...selected, balance: 100 }], Array.from({ length: 101 }, () => selected)]) {
      expect(() => saveDashboardSettings(f.config, cards, before.revision)).toThrow();
    }
    for (const revision of [null, 1, '', 'x'.repeat(64)]) expect(() => saveDashboardSettings(f.config, [], revision)).toThrow();
    expect(fs.existsSync(f.config.deviceHome)).toBe(false);
    const cards = Array.from({ length: 100 }, () => card());
    expect(saveDashboardSettings(f.config, cards, before.revision).cards).toEqual(cards);
    expect(fs.statSync(f.file).size).toBeLessThanOrEqual(16384);
  } finally { f.close(); }
});

test('dashboard stale revisions fail and its shared settings-write lock coordinates other device settings', () => {
  const f = fixture();
  try {
    const before = readDashboardSettings(f.config), preferences = readDevicePreferences(f.config);
    const next = saveDashboardSettings(f.config, [card()], before.revision);
    expect(() => saveDashboardSettings(f.config, [card()], before.revision)).toThrow('revision changed');
    const lock = acquireConfigurationLock(f.config, 'device');
    try {
      expect(() => saveDashboardSettings(f.config, [], next.revision)).toThrow('busy');
      expect(() => saveDevicePreferences(f.config, { theme: 'dark' }, preferences.revision)).toThrow('busy');
      expect(readDashboardSettings(f.config)).toEqual(next);
    } finally { lock.release(); }
    saveDevicePreferences(f.config, { theme: 'dark' }, preferences.revision);
    expect(readDashboardSettings(f.config)).toEqual(next);
    expect(fs.readdirSync(f.config.deviceHome).sort()).toEqual(['dashboard.json', 'preferences.json']);
  } finally { f.close(); }
});

test('dashboard unsafe roots/files and corrupt or non-whitelisted documents fail closed without repair or secret errors', () => {
  for (const kind of ['root-mode', 'root-link', 'ancestor-link', 'file-mode', 'file-link', 'hardlink', 'directory',
    'corrupt', 'oversized', 'unknown', 'secret-card', 'version', 'missing-cards']) {
    const f = fixture();
    try {
      const initial = readDashboardSettings(f.config);
      const saved = saveDashboardSettings(f.config, [card()], initial.revision);
      const external = path.join(f.root, 'external'); fs.writeFileSync(external, 'PRIVATE DO NOT READ', { mode: 0o600 });
      if (kind === 'root-mode') fs.chmodSync(f.config.deviceHome, 0o755);
      if (kind === 'root-link' || kind === 'ancestor-link') {
        const target = kind === 'root-link' ? f.config.deviceHome : path.dirname(f.config.deviceHome);
        fs.renameSync(target, target + '-original'); fs.symlinkSync(target + '-original', target);
      }
      if (kind === 'file-mode') fs.chmodSync(f.file, 0o644);
      if (['file-link', 'hardlink', 'directory'].includes(kind)) {
        fs.unlinkSync(f.file);
        if (kind === 'directory') fs.mkdirSync(f.file, { mode: 0o700 });
        else if (kind === 'file-link') fs.symlinkSync(external, f.file);
        else fs.linkSync(external, f.file);
      }
      if (kind === 'corrupt') fs.writeFileSync(f.file, 'PRIVATE INVALID JSON');
      if (kind === 'oversized') fs.writeFileSync(f.file, 'x'.repeat(256 * 1024 + 1));
      if (kind === 'unknown') fs.writeFileSync(f.file, JSON.stringify({ version: 1, cards: [], secret: 'PRIVATE' }));
      if (kind === 'secret-card') fs.writeFileSync(f.file, JSON.stringify({ version: 1, cards: [{ ...card(), balance: 'PRIVATE' }] }));
      if (kind === 'version') fs.writeFileSync(f.file, JSON.stringify({ version: 3, cards: [], hidden_projects: [], layout: [], content: [] }));
      if (kind === 'missing-cards') fs.writeFileSync(f.file, JSON.stringify({ version: 1 }));
      expect(() => readDashboardSettings(f.config)).toThrow('cannot be safely read');
      expect(() => saveDashboardSettings(f.config, [], saved.revision)).toThrow();
      expect(fs.readFileSync(external, 'utf8')).toBe('PRIVATE DO NOT READ');
    } finally { f.close(); }
  }
});

test('dashboard reading rejects a replaced inode rather than returning an unconfirmed snapshot', () => {
  const f = fixture(), original = fs.readFileSync;
  try {
    saveDashboardSettings(f.config, [card()], readDashboardSettings(f.config).revision);
    fs.readFileSync = function(file, ...args) {
      const result = original.call(this, file, ...args);
      if (typeof file === 'number') {
        fs.renameSync(f.file, f.file + '.old');
        fs.writeFileSync(f.file, JSON.stringify({ version: 1, cards: [] }), { mode: 0o600 });
      }
      return result;
    };
    expect(() => readDashboardSettings(f.config)).toThrow('cannot be safely read');
  } finally { fs.readFileSync = original; f.close(); }
});

test('cross-process dashboard writers cannot both publish the same revision and a restarted reader sees the result', async () => {
  const f = fixture();
  try {
    const before = readDashboardSettings(f.config), module = path.resolve('src/core/dashboard-settings.js');
    const choices = [[card()], [card()]];
    const children = choices.map(cards => Bun.spawn([process.execPath, '--eval', `
      import {saveDashboardSettings} from ${JSON.stringify(module)};
      try { saveDashboardSettings(${JSON.stringify(f.config)}, ${JSON.stringify(cards)}, ${JSON.stringify(before.revision)}); console.log('saved'); }
      catch { console.log('rejected'); }
    `], { stdout: 'pipe', stderr: 'pipe' }));
    const results = await Promise.all(children.map(async child => ({ code: await child.exited,
      out: (await new Response(child.stdout).text()).trim(), err: await new Response(child.stderr).text() })));
    expect(results.map(row => row.code)).toEqual([0, 0]); expect(results.map(row => row.err)).toEqual(['', '']);
    expect(results.map(row => row.out).sort()).toEqual(['rejected', 'saved']);
    const published = readDashboardSettings(f.config);
    expect(published.cards).toEqual(choices[results.findIndex(row => row.out === 'saved')]);
    const reader = Bun.spawn([process.execPath, '--eval', `import {readDashboardSettings} from ${JSON.stringify(module)};
      console.log(JSON.stringify(readDashboardSettings(${JSON.stringify(f.config)})));`], { stdout: 'pipe', stderr: 'pipe' });
    expect(await reader.exited).toBe(0); expect(await new Response(reader.stderr).text()).toBe('');
    expect(JSON.parse(await new Response(reader.stdout).text())).toEqual(published);
    expect(fs.readdirSync(f.config.deviceHome)).toEqual(['dashboard.json']);
  } finally { f.close(); }
});

test('quick actions projects v1-v6 read-only and v7 saves retain unrelated selection and layout', () => {
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const f = fixture();
    try {
      fs.mkdirSync(f.config.deviceHome, { recursive: true, mode: 0o700 });
      const data = { version, cards: [card()] };
      if (version >= 2) Object.assign(data, { hidden_projects: ['a'.repeat(16)], layout: [{ id: 'widget:quick-actions', x: 6, y: 30, w: 6, h: 10 }], content: [] });
      if (version < 4 && data.layout) data.layout = [];
      if (version >= 3) data.account_view = 'tiles';
      if (version >= 4) data.widgets = [];
      if (version >= 5) data.diagnostics = false;
      if (version >= 6) data.quick_actions = false;
      const source = JSON.stringify(data); fs.writeFileSync(f.file, source, { mode: 0o600 });
      const before = readDashboardSettings(f.config);
      expect(before.version).toBe(7); expect(before.quick_actions).toBe(version < 6);
      expect(before.quick_action_buttons).toEqual(['safe_restart', 'auto_select']);
      expect(fs.readFileSync(f.file, 'utf8')).toBe(source);
      const next = saveDashboardSettings(f.config, { quick_actions: !before.quick_actions }, before.revision);
      expect(next).toEqual({ ...before, quick_actions: !before.quick_actions, revision: next.revision });
      expect(next.revision).not.toBe(before.revision);
      expect(() => saveDashboardSettings(f.config, { quick_actions: true }, before.revision)).toThrow('revision changed');
      expect(readDashboardSettings(f.config)).toEqual(next);
      expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).version).toBe(7);
    } finally { f.close(); }
  }
});

test('quick actions rejects non-booleans, missing current fields and concurrent stale layout patches', async () => {
  const f = fixture();
  try {
    const before = readDashboardSettings(f.config);
    for (const value of [null, 0, 1, 'false', {}, []]) expect(() => saveDashboardSettings(f.config, { quick_actions: value }, before.revision)).toThrow();
    expect(fs.existsSync(f.config.deviceHome)).toBe(false);
    const saved = saveDashboardSettings(f.config, { quick_actions: false }, before.revision);
    const module = path.resolve('src/core/dashboard-settings.js');
    const children = [true, false].map((quick_actions, i) => Bun.spawn([process.execPath, '--eval', `
      import {saveDashboardSettings} from ${JSON.stringify(module)};
      try { saveDashboardSettings(${JSON.stringify(f.config)}, {quick_actions:${quick_actions},layout:[{id:'widget:quick-actions',x:0,y:${i},w:6,h:10}]}, '${saved.revision}'); console.log('saved'); }
      catch { console.log('rejected'); }
    `], { stdout: 'pipe', stderr: 'pipe' }));
    const results = await Promise.all(children.map(async child => { expect(await child.exited).toBe(0); return (await new Response(child.stdout).text()).trim(); }));
    expect(results.sort()).toEqual(['rejected', 'saved']);
    const data = JSON.parse(fs.readFileSync(f.file, 'utf8')); delete data.quick_actions;
    fs.writeFileSync(f.file, JSON.stringify(data));
    expect(() => readDashboardSettings(f.config)).toThrow('cannot be safely read');
  } finally { f.close(); }
});
