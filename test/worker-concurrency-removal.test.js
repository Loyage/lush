import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { DeviceSettingsService } from '../src/host/device-settings.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { printTree, printTimeline } from '../src/cli/print.js';
import { projectProgress } from '../src/core/project/progress.js';
import { env, fixture, temp } from './helpers.js';

const retired = ['concurrency', 'control_concurrency'];

test('historical quotas are hidden and preserved verbatim through unrelated saves and resets', () => {
  const root = temp(), settingsEnv = env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device'),
    LUSH_CONCURRENCY: 'not-a-number', LUSH_CONTROL_CONCURRENCY: '-1' });
  try {
    const config = new Config({ project: root, env: settingsEnv });
    fs.mkdirSync(config.deviceHome, { recursive: true, mode: 0o700 });
    const file = config.runtimeSettings.file;
    for (const values of [{ concurrency: 1, control_concurrency: 1 }, { concurrency: null, control_concurrency: 0 },
      { concurrency: 'retired-invalid', control_concurrency: { old: true } }]) {
      const body = JSON.stringify({ version: 1, ...values });
      fs.writeFileSync(file, body, { mode: 0o600 });
      const restarted = new Config({ project: root, env: settingsEnv });
      for (const key of retired) expect(restarted.runtimeSettings.get()).not.toHaveProperty(key);
      expect(fs.readFileSync(file, 'utf8')).toBe(body); // Reads do not migrate/repair history.
      restarted.configureRuntime({ call_timeout: 120, max_depth: 3 });
      expect(JSON.parse(fs.readFileSync(file))).toEqual({ version: 1, ...values, call_timeout: 120, max_depth: 3 });
      restarted.configureRuntime({ call_timeout: null, max_depth: null });
      expect(JSON.parse(fs.readFileSync(file))).toEqual({ version: 1, ...values });
      const before = fs.readFileSync(file);
      for (const key of retired) for (const value of [1, null])
        expect(() => restarted.configureRuntime({ [key]: value })).toThrow('unknown field');
      expect(fs.readFileSync(file)).toEqual(before);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(config.deviceHome)).toEqual(['settings.json']);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('no-project Host settings ignore retired env, hide stored quotas and reject quota mutations', async () => {
  const root = temp(), host = new DeviceSettingsService(env({ LUSH_GLOBAL_CONFIG: root,
    LUSH_CONCURRENCY: 'invalid', LUSH_CONTROL_CONCURRENCY: '0' }));
  try {
    const initial = await host.request('system.settings');
    for (const key of retired) expect(initial).not.toHaveProperty(key);
    expect(fs.existsSync(host.config.home)).toBe(false);
    fs.mkdirSync(host.config.home, { recursive: true, mode: 0o700 });
    const file = host.runtime.file, body = '{"version":1,"concurrency":1,"control_concurrency":1}\n';
    fs.writeFileSync(file, body, { mode: 0o600 });
    for (const key of retired) {
      expect(await host.request('system.settings')).not.toHaveProperty(key);
      for (const value of [2, null]) await expect(host.request('system.configure', { settings: { [key]: value } })).rejects.toThrow();
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(body);
    await host.request('system.configure', { settings: { call_timeout: 120 } });
    expect(JSON.parse(fs.readFileSync(file))).toEqual({ version: 1, concurrency: 1, control_concurrency: 1, call_timeout: 120 });
    expect(fs.readdirSync(host.config.home)).toEqual(['settings.json']);
    expect(host.config.project).toBeNull();
  } finally { await host.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('real Project RPC exposes only active runtime fields and refuses retired quota keys', async () => {
  const f = fixture(), rpc = new Dispatcher(f.project);
  try {
    for (const key of retired) {
      expect(await rpc.dispatch('system.settings')).not.toHaveProperty(key);
      expect(await rpc.dispatch('system.status')).not.toHaveProperty(key);
      await expect(rpc.dispatch('system.configure', { settings: { [key]: 1 } })).rejects.toThrow('unknown field');
    }
    expect((await rpc.dispatch('system.configure', { settings: { task_call_limit: 10 } })).task_call_limit.value).toBe(10);
    expect(fs.existsSync(path.join(f.config.deviceHome, 'runtime-slots.json'))).toBe(false);
  } finally { await f.close(); }
});

test('CLI tree and timeline describe activity and admission, never a concurrency quota', () => {
  const lines = [], original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  const start = '2030-01-01T00:00:00Z', end = '2030-01-01T00:01:00Z';
  try {
    printTree([{ id: 1, role: 'agent', status: 'running', goal: 'running', children: [] },
      { id: 2, role: 'agent', status: 'queued', goal: 'queued', children: [] }], { agents: [{}] });
    printTimeline({ start, end, tasks: [{ id: 2, role: 'agent', segments: [{ kind: 'wait', start, end, reason: 'admission' }] }] });
  } finally { console.log = original; }
  const text = lines.join('\n');
  expect(text).toContain('1 个在跑 · 1 个排队');
  expect(text).toContain('等运行准入或安全边界');
  expect(text).toContain('等运行准入');
  expect(text).not.toMatch(/并发槽|并发上限|等槽|concurrency|undefined/);
});

test('queued progress wait labels do not invent quota exhaustion', () => {
  const progress = { version: 1, items: [{ key: 'work', label: 'work', status: 'pending', started_at: '2030-01-01T00:00:00Z' }] };
  const runs = [{ started_at: '2030-01-01T00:00:00Z', ended_at: '2030-01-01T00:00:01Z' }];
  const projected = projectProgress(progress, runs, 'queued', Date.parse('2030-01-01T00:01:00Z'));
  expect(projected.items.find(row => row.kind === 'wait').label).toBe('排队等待依赖或运行准入');
});

test('queued Worker graph describes safety admission without inventing a call slot', async () => {
  const f = fixture();
  try {
    const task = f.store.create({ role: 'agent', task_kind: 'child', input_id: null, goal: 'queued behind a safety gate' });
    const graph = await f.project.taskGraph({ details: false });
    expect(graph.nodes.find(row => row.id === task.id).waiting_reason).toBe('等待运行准入或安全边界');
  } finally { await f.close(); }
});

test('timeline unknown waiting reason is admission, without an invented slot limit', async () => {
  const f = fixture();
  try {
    const task = f.store.create({ role: 'agent', task_kind: 'child', input_id: null, goal: 'waiting for a safe point' });
    // Use a past timestamp, independent of the test runner clock.
    f.store.run('UPDATE tasks SET created_at=? WHERE id=?', '2020-01-01T00:00:00Z', task.id);
    const timeline = f.project.timeline();
    expect(timeline).not.toHaveProperty('concurrency');
    expect(timeline.tasks.find(row => row.id === task.id).segments.at(-1).reason).toBe('admission');
  } finally { await f.close(); }
});
