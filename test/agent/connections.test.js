import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConnectionManager } from '../../src/agent/connections.js';

test('connection save, edit, query and runtime preparation use the selected account', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-connections-'));
  const home = path.join(root, '.lush'); fs.mkdirSync(home, { mode: 0o700 });
  const requests = [];
  const manager = new ConnectionManager({ home, deviceHome: home }, { fetch: async (url, options) => {
    requests.push({ url, options });
    return Response.json({ balance_infos: [{ currency: 'USD', total_balance: 2 }] });
  } });
  try {
    const row = manager.save({ label: 'local smoke', provider: 'deepseek', auth_type: 'api_key',
      enabled: true, models: ['deepseek-chat', 'vendor/physical-model'] }, { api_key: 'fixture-key' });
    const registry = manager.registeredModels();
    expect(registry.list()).toEqual({ version: 1, models: [], storage_scope: 'device' });
    const first = registry.save({ name: 'astra', connection_id: row.id, model: 'deepseek/deepseek-chat' });
    const second = registry.save({ name: 'slash', connection_id: row.id, model: 'deepseek/vendor/physical-model' });
    const frozen = registry.resolve('astra');
    expect(registry.resolve(second.id).model).toBe('deepseek/vendor/physical-model');
    expect(registry.list().models).toHaveLength(2);
    expect(() => registry.save({ name: 'astra', connection_id: row.id, model: 'deepseek/deepseek-chat' })).toThrow('already exists');
    expect(() => registry.resolve('astr')).toThrow('not found');
    registry.save({ id: first.id, name: 'renamed model', connection_id: row.id, model: second.model });
    expect(frozen.model).toBe('deepseek/deepseek-chat');
    expect(registry.resolve(first.id)).toMatchObject({ id: first.id, name: 'renamed model', model: second.model });
    registry.remove(first.id);
    expect(() => registry.save({ id: first.id, name: 'astra', connection_id: row.id, model: first.model })).toThrow('not found');
    expect(() => registry.resolve(first.id)).toThrow('not found');
    expect(requests).toHaveLength(0);
    const { credential, ...config } = row;
    manager.save({ ...config, label: 'renamed' }, { api_key: '' });
    const runtime = await manager.prepareRuntime(row.id);
    expect(runtime.credential.key).toBe('fixture-key');
    const query = await manager.query(row.id);
    expect(query.account_key).toBe(runtime.account_key);
    expect(query.source_key).toBe(runtime.source_key);
    expect(requests).toHaveLength(1);
    expect(manager.config().connections[0]).toMatchObject({ id: row.id, label: 'renamed' });
    expect(JSON.stringify(manager.config())).not.toContain('fixture-key');
    expect(JSON.stringify(registry.list())).not.toContain('fixture-key');
    manager.save({ ...config, enabled: false });
    expect(registry.list().models[0]).toMatchObject({ selectable: false, reason: 'source_disabled' });
    expect(() => registry.resolve(second.id)).toThrow('source_disabled');
    manager.save({ ...config, models: ['deepseek-chat'] });
    expect(registry.list().models[0]).toMatchObject({ selectable: false, reason: 'model_out_of_scope' });
    expect(manager.remove(row.id)).toEqual({ removed: row.id });
    expect(manager.config().connections).toEqual([]);
    expect(registry.list().models[0]).toMatchObject({ id: second.id, selectable: false, reason: 'source_missing', source: null });
    expect(fs.statSync(registry.file.file).mode & 0o777).toBe(0o600);
    const stored = fs.readFileSync(registry.file.file, 'utf8');
    fs.writeFileSync(registry.file.file, '{broken');
    expect(() => registry.list()).toThrow('storage unavailable');
    expect(() => registry.remove(second.id)).toThrow('storage unavailable');
    expect(fs.readFileSync(registry.file.file, 'utf8')).toBe('{broken');
    fs.writeFileSync(registry.file.file, stored);
    registry.remove(second.id);
  } finally { await manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
