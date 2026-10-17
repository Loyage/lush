import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConnectionManager } from '../../src/agent/connections.js';

test('connection save, edit, query and runtime preparation use the selected account', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-connections-'));
  const home = path.join(root, '.lush'); fs.mkdirSync(home, { mode: 0o700 });
  const requests = [];
  const manager = new ConnectionManager({ home }, { fetch: async (url, options) => {
    requests.push({ url, options });
    return Response.json({ balance_infos: [{ currency: 'USD', total_balance: 2 }] });
  } });
  try {
    const row = manager.save({ label: 'local smoke', provider: 'deepseek', auth_type: 'api_key',
      enabled: true, models: ['deepseek-chat'] }, { api_key: 'fixture-key' });
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
    expect(manager.remove(row.id)).toEqual({ removed: row.id });
    expect(manager.config().connections).toEqual([]);
  } finally { await manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
