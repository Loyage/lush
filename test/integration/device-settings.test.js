import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, repo, env } from '../helpers.js';
import { cli } from './harness.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';

test('two real temporary daemons share device settings while project homes stay independent', async () => {
  const a = temp(), b = temp(), shared = temp(), settingsEnv = { LUSH_GLOBAL_CONFIG: shared };
  try {
    await Promise.all([repo(a), repo(b)]);
    const [sa, sb] = await Promise.all([cli(a, ['daemon', 'start'], settingsEnv), cli(b, ['daemon', 'start'], settingsEnv)]);
    expect(sa.pid).not.toBe(sb.pid);
    const ca = new UIClient(Config.fromEnv(env(settingsEnv), a)), cb = new UIClient(Config.fromEnv(env(settingsEnv), b));
    await ca.request('system.configure', { settings: { call_timeout: 50 }, scope: 'device' });
    expect((await cb.request('system.settings')).call_timeout).toMatchObject({ value: 50, source: 'device', overridden: true });
    await cb.request('system.configure', { settings: { call_timeout: null } });
    expect((await ca.request('system.settings')).call_timeout).toMatchObject({ value: 10800, source: 'default', overridden: false });
    await ca.request('agent.configure', { scope: 'device', config: { version: 1, default: { agent: 'pi', config_mode: 'pi' }, roles: {} } });
    expect((await cb.request('agent.config')).default.config_mode).toBe('pi');
    const source = await ca.request('agent.connections.save', { connection: { label: 'shared fixture', provider: 'deepseek', auth_type: 'api_key', models: ['deepseek-chat'] }, credential: { api_key: 'shared-fixture-secret' } });
    const registered = await ca.request('agent.registered_models.save', { model: { name: 'astra', connection_id: source.id, model: 'deepseek/deepseek-chat' } });
    expect((await cb.request('agent.registered_models.list')).models[0]).toMatchObject({ id: registered.id, name: 'astra', selectable: true });
    const frozen = await cb.request('agent.registered_models.resolve', { selector: 'astra', scope: 'device' });
    await cb.request('agent.registered_models.save', { model: { id: registered.id, name: 'renamed', connection_id: source.id, model: frozen.model } });
    expect(await ca.request('agent.registered_models.resolve', { selector: registered.id })).toMatchObject({ id: registered.id, name: 'renamed' });
    await cb.request('agent.registered_models.remove', { id: registered.id });
    expect((await ca.request('agent.registered_models.list')).models).toEqual([]);
    await expect(ca.request('agent.registered_models.resolve', { selector: registered.id })).rejects.toThrow('not found');
    expect(frozen).toEqual({ id: registered.id, name: 'astra', connection_id: source.id, model: 'deepseek/deepseek-chat' });
    expect((await ca.request('agent.config')).default.config_mode).toBe('pi');
    await ca.request('agent.environment.configure', { scope: 'device', target: 'common', values: { SHARED_TEST_VALUE: 'shared' } });
    expect((await cb.request('agent.environment', { target: 'common' })).values.SHARED_TEST_VALUE).toBe('shared');
    await ca.request('agent.network.configure', { scope: 'device', config: { version: 1, mode: 'direct', no_proxy: [] } });
    expect((await cb.request('agent.network')).configuration_scope.source).toBe('device');
    for (const root of [a, b]) {
      expect(fs.existsSync(path.join(root, '.lush', 'project.db'))).toBe(true);
      expect(fs.existsSync(path.join(root, '.lush', 'agent.json'))).toBe(false);
    }
    expect(fs.existsSync(path.join(shared, 'shared', 'agent.json'))).toBe(true);
    expect((await cb.request('worker.list')).every(row => row.task_kind === 'main')).toBe(true);
  } finally {
    await Promise.all([cli(a, ['daemon', 'stop'], settingsEnv).catch(() => {}), cli(b, ['daemon', 'stop'], settingsEnv).catch(() => {})]);
    for (const root of [a, b, shared]) fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
