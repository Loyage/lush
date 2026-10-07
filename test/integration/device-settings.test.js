import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, repo, env } from '../helpers.js';
import { cli } from './harness.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';

test('two real temporary daemons reuse shared settings while project overrides and homes stay independent', async () => {
  const a = temp(), b = temp(), shared = temp(), settingsEnv = { LUSH_GLOBAL_CONFIG: shared };
  try {
    await Promise.all([repo(a), repo(b)]);
    const [sa, sb] = await Promise.all([cli(a, ['start'], settingsEnv), cli(b, ['start'], settingsEnv)]);
    expect(sa.pid).not.toBe(sb.pid);
    const ca = new UIClient(Config.fromEnv(env(settingsEnv), a)), cb = new UIClient(Config.fromEnv(env(settingsEnv), b));
    await ca.request('system.configure', { settings: { concurrency: 5, progress_reporting: false }, scope: 'device' });
    expect((await cb.request('system.settings')).concurrency).toMatchObject({ value: 5, source: 'device', overridden: false });
    await cb.request('system.configure', { settings: { concurrency: 2 } });
    await ca.request('system.configure', { settings: { concurrency: 7 }, scope: 'device' });
    expect((await cb.request('system.settings')).concurrency).toMatchObject({ value: 2, source: 'project' });
    expect((await cb.request('system.settings', { scope: 'device' })).concurrency.value).toBe(7);
    await cb.request('system.configure', { settings: { concurrency: null } });
    expect((await cb.request('system.status')).settings.concurrency.value).toBe(7);
    await ca.request('agent.configure', { scope: 'device', config: { version: 1, default: { agent: 'pi', config_mode: 'pi' }, roles: {} } });
    const agents = await cb.request('agent.config');
    expect(agents.configuration_scope).toMatchObject({ selected: 'project', source: 'device', project_override: false });
    expect(agents.default.config_mode).toBe('pi');
    expect(agents.options.default_prompts.agent).not.toContain('lush progress');
    await ca.request('agent.environment.configure', { scope: 'device', target: 'common', values: { SHARED_TEST_VALUE: 'shared' } });
    expect((await cb.request('agent.environment', { target: 'common' })).values.SHARED_TEST_VALUE).toBe('shared');
    await ca.request('agent.network.configure', { scope: 'device', config: { version: 1, mode: 'direct', no_proxy: [] } });
    expect((await cb.request('agent.network')).configuration_scope.source).toBe('device');
    await ca.request('quick_explain.configure', { scope: 'device', config: { prompt: 'Shared test explanation' } });
    expect(await cb.request('quick_explain.config')).toMatchObject({ prompt: 'Shared test explanation', ready: false,
      configuration_scope: { source: 'device' } });
    for (const root of [a, b]) {
      expect(fs.existsSync(path.join(root, '.lush', 'project.db'))).toBe(true);
      expect(fs.existsSync(path.join(root, '.lush', 'agent.json'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.lush', 'quick-explanation.json'))).toBe(false);
    }
    expect(fs.existsSync(path.join(shared, 'shared', 'agent.json'))).toBe(true);
    expect((await cb.request('worker.list')).every(row => row.task_kind === 'main')).toBe(true);
  } finally {
    await Promise.all([cli(a, ['stop'], settingsEnv).catch(() => {}), cli(b, ['stop'], settingsEnv).catch(() => {})]);
    for (const root of [a, b, shared]) fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
