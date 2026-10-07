import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, temp } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { DeviceSettingsService } from '../../src/host/device-settings.js';

test('confirmed RPC migration switches real project settings to shared inheritance without moving history or creating a Host project', async () => {
  const deviceRoot = temp();
  const source = fixture(undefined, { LUSH_GLOBAL_CONFIG: deviceRoot });
  const other = fixture(undefined, { LUSH_GLOBAL_CONFIG: deviceRoot });
  const host = new DeviceSettingsService(source.config.env);
  const dispatcher = new Dispatcher(source.project);
  try {
    source.project.agentConnections.managerOptions.fetch = async () => Response.json({
      balance_infos: [{ currency: 'USD', total_balance: '20' }],
    });
    const row = await source.project.saveAgentConnection({ label: 'Migration source', provider: 'deepseek',
      auth_type: 'api_key', models: ['deepseek-chat'] }, { api_key: 'migration-private-key' });
    source.project.configureRuntimeSettings({ concurrency: 3, progress_reporting: false });
    source.project.configureAgents({ version: 1, default: { agent: 'pi', config_mode: 'lush',
      connection_id: row.id, model: 'deepseek/deepseek-chat', extensions: ['./extension.mjs'], skills: [] }, roles: {} });
    source.project.configureAgentEnvironment('common', { MIGRATION_VALUE: 'migration-private-env' });
    await source.project.configureAgentNetwork({ version: 1, mode: 'direct', no_proxy: [] });
    source.project.configureQuickExplanation({ connection_id: row.id, model: 'deepseek-chat', prompt: 'Shared explanation' });
    await source.project.queryAgentConnections(row.id);
    const history = source.project.agentConnectionHistory(row.id, 7);
    expect(history.series).toHaveLength(1);
    const db = path.join(source.config.home, 'project.db');
    expect(fs.existsSync(db)).toBe(true);

    const preview = await dispatcher.dispatch('settings.migration.preview', {});
    expect(preview.can_migrate).toBe(true);
    expect(fs.existsSync(source.config.deviceHome)).toBe(false);
    const result = await dispatcher.dispatch('settings.migration.apply', { revision: preview.revision, confirm: true });
    expect(result.migrated).toBe(true);
    expect(source.config.home).toBe(path.join(source.root, '.lush'));
    expect(fs.existsSync(db)).toBe(true);
    expect(source.project.agentConnectionHistory(row.id, 7).series).toEqual(history.series);
    expect(other.project.agentConnectionHistory(row.id, 7).series).toEqual([]);

    for (const f of [source, other]) {
      expect(f.project.runtimeSettings().concurrency).toMatchObject({ value: 3, source: 'device', overridden: false });
      expect(f.project.agentConfig().configuration_scope).toMatchObject({ source: 'device', project_override: false });
      expect(f.project.agentSettings.resolve('agent')).toMatchObject({ connection_id: row.id,
        extensions: [path.join(source.root, 'extension.mjs')] });
      expect(f.project.agentEnvironment('common').values.MIGRATION_VALUE).toBe('migration-private-env');
      expect(f.project.agentNetwork().configuration_scope.source).toBe('device');
      expect(f.project.quickExplanationConfig()).toMatchObject({ connection_id: row.id, ready: true,
        configuration_scope: { source: 'device', project_override: false } });
      expect(f.project.agentConnectionsList().connections[0]).toMatchObject({ id: row.id, storage_scope: 'device' });
      expect(fs.existsSync(path.join(f.config.home, 'credentials', 'agent-connections.json'))).toBe(false);
    }
    expect((await host.request('agent.config')).default.connection_id).toBe(row.id);
    expect((await host.request('quick_explain.config')).ready).toBe(true);
    const hostConnections = await host.request('agent.connections.list');
    expect(hostConnections).toMatchObject({ history_available: false, consumers_scope: 'none' });
    expect(hostConnections.connections[0]).toMatchObject({ id: row.id, storage_scope: 'device', consumers: [] });
    expect(host.config.project).toBeNull();
    for (const value of [preview, result, hostConnections]) {
      expect(JSON.stringify(value)).not.toContain('migration-private-key');
      expect(JSON.stringify(value)).not.toContain('migration-private-env');
    }
    for (const relative of ['agent.json', 'quick-explanation.json', path.join('credentials', 'agent-connections.json')]) {
      const stored = JSON.parse(fs.readFileSync(path.join(source.config.deviceHome, relative), 'utf8'));
      expect(stored).not.toHaveProperty('configuration_scope');
      if (stored.connections) expect(stored.connections[0]).not.toHaveProperty('storage_scope');
    }
    expect((await dispatcher.dispatch('settings.migration.apply', {
      revision: (await dispatcher.dispatch('settings.migration.preview', {})).revision, confirm: true,
    })).already_migrated).toBe(true);
  } finally {
    await host.stop();
    await Promise.all([source.close(), other.close()]);
    fs.rmSync(deviceRoot, { recursive: true, force: true });
  }
});
