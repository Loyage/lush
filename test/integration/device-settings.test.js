import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, repo, env } from '../helpers.js';
import { cli } from './harness.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';

test('two real temporary daemons use device-only settings while daemons and project homes stay independent', async () => {
  const a = temp(), b = temp(), shared = temp(), settingsEnv = { LUSH_GLOBAL_CONFIG: shared };
  try {
    await Promise.all([repo(a), repo(b)]);
    const [sa, sb] = await Promise.all([cli(a, ['start'], settingsEnv), cli(b, ['start'], settingsEnv)]);
    expect(sa.pid).not.toBe(sb.pid);
    const ca = new UIClient(Config.fromEnv(env(settingsEnv), a)), cb = new UIClient(Config.fromEnv(env(settingsEnv), b));
    const capabilityKeys = ['progress_reporting', 'worker_delegation', 'worker_auto_title', 'context_retrieval'];
    await ca.request('system.configure', { settings: { call_timeout: 50, ...Object.fromEntries(capabilityKeys.map(key => [key, false])) }, scope: 'device' });
    const capabilityModel = await cb.request('system.settings');
    expect(capabilityModel.call_timeout).toMatchObject({ value: 50, source: 'device', overridden: true });
    for (const key of capabilityKeys) expect(capabilityModel[key]).toMatchObject({ value: false, default: true, source: 'device', overridden: true });
    await cb.request('system.configure', { settings: { worker_auto_title: null } });
    const resetCapability = await ca.request('system.settings');
    expect(resetCapability.worker_auto_title).toMatchObject({ value: true, source: 'default', overridden: false });
    expect(resetCapability.worker_delegation.value).toBe(false);
    await cb.request('system.configure', { settings: { call_timeout: 20 } });
    await ca.request('system.configure', { settings: { call_timeout: 70 }, scope: 'device' });
    expect((await cb.request('system.settings')).call_timeout).toMatchObject({ value: 70, source: 'device' });
    await expect(cb.request('system.configure', { settings: { call_timeout: 20 }, scope: 'project' })).rejects.toThrow('no longer');
    expect((await cb.request('system.settings', { scope: 'device' })).call_timeout.value).toBe(70);
    await cb.request('system.configure', { settings: { call_timeout: null } });
    expect((await cb.request('system.status')).settings.call_timeout.value).toBe(10800);
    for (const client of [ca, cb]) for (const key of ['concurrency', 'control_concurrency']) {
      expect((await client.request('system.settings'))).not.toHaveProperty(key);
      expect((await client.request('system.status'))).not.toHaveProperty(key);
      await expect(client.request('system.configure', { settings: { [key]: 1 } })).rejects.toThrow('unknown field');
    }
    await ca.request('agent.configure', { scope: 'device', config: { version: 1, default: { agent: 'pi', config_mode: 'pi' }, roles: {} } });
    const agents = await cb.request('agent.config');
    expect(agents.configuration_scope).toMatchObject({ selected: 'device', source: 'device', project_override: false });
    expect(agents.default.config_mode).toBe('pi');
    expect(agents.options.default_prompts.agent).not.toContain('lush progress');
    await ca.request('agent.environment.configure', { scope: 'device', target: 'common', values: { SHARED_TEST_VALUE: 'shared' } });
    expect((await cb.request('agent.environment', { target: 'common' })).values.SHARED_TEST_VALUE).toBe('shared');
    await ca.request('agent.network.configure', { scope: 'device', config: { version: 1, mode: 'direct', no_proxy: [] } });
    expect((await cb.request('agent.network')).configuration_scope.source).toBe('device');
    await expect(ca.request('quick_explain.configure', { scope: 'device', config: { prompt: 'Shared test explanation' } })).rejects.toThrow('unknown method');
    await expect(cb.request('quick_explain.config')).rejects.toThrow('unknown method');
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
