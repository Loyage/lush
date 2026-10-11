import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { normalizeRuntimeSettings } from '../src/core/settings.js';
import { assertAllowed } from '../src/rpc/registry.js';
import { acquireConfigurationLock } from '../src/core/device-config.js';
import { fixture, temp, env, repo, gate, until } from './helpers.js';

const keys = ['progress_reporting', 'worker_delegation', 'worker_auto_title', 'context_retrieval'];
const patch = value => Object.fromEntries(keys.map(key => [key, value]));

test('capability booleans default on, preserve legacy files, and reset independently', () => {
  const root = temp(), config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) });
  const settings = config.runtimeSettings, file = settings.file;
  try {
    for (const key of keys) expect(settings.get()[key]).toEqual({ value: true, default: true, overridden: false, source: 'default' });
    expect(fs.existsSync(config.deviceHome)).toBe(false);
    fs.mkdirSync(config.deviceHome, { recursive: true, mode: 0o700 });
    const legacy = { version: 1, progress_reporting: false, concurrency: 2, control_concurrency: 3, max_depth: 4 };
    fs.writeFileSync(file, JSON.stringify(legacy), { mode: 0o600 });
    expect(settings.get().progress_reporting.value).toBe(false);
    for (const key of keys.slice(1)) expect(settings.get()[key].value).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(legacy);
    for (const key of keys) {
      const off = settings.save({ [key]: false });
      expect(off[key]).toEqual({ value: false, default: true, overridden: true, source: 'device' });
      expect(off.max_depth.value).toBe(4);
    }
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...legacy, ...patch(false) });
    const reset = settings.save({ worker_auto_title: null });
    expect(reset.worker_auto_title).toEqual({ value: true, default: true, overridden: false, source: 'default' });
    expect(reset.worker_delegation.value).toBe(false);
    settings.save(patch(null));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, concurrency: 2, control_concurrency: 3, max_depth: 4 });
    for (const key of keys) expect(settings.get()[key].value).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(config.deviceHome)).toEqual(['settings.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('capability patches reject bad types atomically and use the shared settings lock', () => {
  const root = temp(), config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) });
  try {
    const settings = config.runtimeSettings; settings.save(patch(false));
    const before = fs.readFileSync(settings.file, 'utf8');
    for (const key of keys) for (const value of [0, 1, 'false', [], {}, 'true']) {
      expect(() => normalizeRuntimeSettings({ version: 1, [key]: value })).toThrow('boolean');
      expect(() => settings.save({ call_timeout: 40, [key]: value })).toThrow('boolean');
      expect(fs.readFileSync(settings.file, 'utf8')).toBe(before);
    }
    expect(() => settings.save({ agent_capabilities: {} })).toThrow('unknown field');
    const lock = acquireConfigurationLock(config, 'device');
    try { expect(() => settings.save({ worker_delegation: true })).toThrow('busy'); }
    finally { lock.release(); }
    expect(fs.readFileSync(settings.file, 'utf8')).toBe(before);
    fs.chmodSync(settings.file, 0o644);
    expect(() => settings.get()).toThrow('chmod 600');
    expect(() => settings.save({ worker_delegation: true })).toThrow('chmod 600');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('two temporary projects read the same capabilities without changing project bindings or legacy files', () => {
  const root = temp(), global = path.join(root, 'device');
  const make = name => {
    const project = path.join(root, name); fs.mkdirSync(project, { mode: 0o700 });
    const config = new Config({ project, env: env({ LUSH_GLOBAL_CONFIG: global }) }); config.prepare(); return config;
  };
  try {
    const a = make('a'), b = make('b');
    const legacy = path.join(b.home, 'settings.json'); fs.writeFileSync(legacy, JSON.stringify({ version: 1, ...patch(true) }), { mode: 0o600 });
    const before = fs.readFileSync(legacy, 'utf8');
    a.configureRuntime(patch(false));
    const model = b.refreshRuntimeSettings();
    for (const key of keys) expect(model[key]).toMatchObject({ value: false, source: 'device', overridden: true });
    b.configureRuntime({ worker_auto_title: null });
    expect(a.runtimeSettings.get().worker_auto_title.value).toBe(true);
    expect(a.runtimeSettings.get().worker_delegation.value).toBe(false);
    expect(fs.readFileSync(legacy, 'utf8')).toBe(before);
    expect(a.env.LUSH_HOME).toBe(a.home); expect(b.env.LUSH_HOME).toBe(b.home);
    expect(a.home).not.toBe(b.home); expect(a.deviceHome).toBe(b.deviceHome);
    expect(() => a.configureRuntime({ worker_delegation: true }, 'project')).toThrow('no longer');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('disabling guidance retains existing child, title and history and does not add a spawn permission gate', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    await repo(f.root);
    const parent = (await f.project.order('capability compatibility')).task;
    const child = await f.project.spawn(parent.id, 'existing child', undefined, [], 'existing-child');
    f.store.setTaskAutoTitle(child.id, '保留标题');
    f.store.event(child.id, 'fixture.history', { keep: true });
    const before = f.store.task(child.id);
    f.project.configureRuntimeSettings({ worker_delegation: false, worker_auto_title: false, context_retrieval: false });
    expect(f.store.task(child.id)).toEqual(before);
    expect(f.project.inspect(child.id).auto_title).toBe('保留标题');
    expect(f.store.all("SELECT * FROM events WHERE task_id=? AND type='fixture.history'", child.id)).toHaveLength(1);
    const additional = await f.project.spawn(parent.id, 'CLI remains allowed', undefined, [], 'api-still-allowed');
    expect(additional.parent_id).toBe(parent.id);
    expect(f.project.running.size).toBe(0);
  } finally { await f.close(); }
});

test('changing capabilities does not abort or restart an already running invocation', async () => {
  const done = gate(), calls = [];
  const f = fixture({ run(ctx) { calls.push(ctx); ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once: true }); return done.promise; } });
  try {
    await repo(f.root);
    const task = (await f.project.order('keep current invocation')).task;
    await until(() => calls.length === 1);
    f.project.configureRuntimeSettings(patch(false));
    expect(calls[0].signal.aborted).toBe(false); expect(f.project.running.has(task.id)).toBe(true);
    expect(f.store.task(task.id).status).toBe('running'); expect(calls).toHaveLength(1);
    done.resolve('completed normally'); await until(() => !f.project.running.has(task.id));
    expect(f.store.task(task.id).result).toContain('completed normally'); expect(calls).toHaveLength(1);
  } finally { done.resolve('clean up'); await f.close(); }
});

test('capability configuration remains user-only with no Agent scope bypass', () => {
  for (const key of keys) {
    for (const scope of [undefined, 'device']) {
      const params = { settings: { [key]: false }, ...(scope ? { scope } : {}) };
      expect(() => assertAllowed('system.configure', params, 7)).toThrow('user approval');
      expect(assertAllowed('system.configure', params, null)).toBeNull();
    }
  }
});
