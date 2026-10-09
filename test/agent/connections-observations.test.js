import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from '../helpers.js';
import { ConnectionFile } from '../../src/agent/connections-file.js';
import { ConnectionObservationFile } from '../../src/agent/connections-observations.js';
import { ConnectionManager } from '../../src/agent/connections.js';

const key = 'a'.repeat(64);
const observation = (value, at = '2026-10-09T00:00:00Z') => ({ status: 'available', source: 'usage_api', checked_at: at,
  resources: [{ id: 'balance', kind: 'balance', scope: 'account', remaining: value }], token: 'PRIVATE-RAW-TOKEN', reason: 'PRIVATE-RAW-ERROR' });
function setup() {
  const root = temp(); fs.chmodSync(root, 0o700);
  const file = new ConnectionObservationFile(new ConnectionFile(root, { privateRoot: true }));
  return { root, file, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

test('cache reads never create files, sanitized values persist, late results cannot replace newer observations or successes', async () => {
  const f = setup();
  try {
    expect(f.file.get(key)).toBeNull(); expect(fs.existsSync(path.join(f.root, 'credentials'))).toBe(false);
    await f.file.put(key, observation(12));
    await f.file.put(key, { status: 'error', source: 'usage_api', checked_at: '2026-10-09T00:02:00Z', error_code: 'network', reason: 'PRIVATE-ERROR' });
    await f.file.put(key, observation(99, '2026-10-08T23:59:00Z'));
    expect(f.file.get(key)).toMatchObject({ observation: { status: 'error', checked_at: '2026-10-09T00:02:00.000Z' },
      last_success: { observation: { resources: [{ remaining: 12 }] } } });
    // An intermediate success may update last_success without hiding a newer failure.
    await f.file.put(key, observation(20, '2026-10-09T00:01:00Z'));
    expect(f.file.get(key).observation.status).toBe('error');
    expect(f.file.get(key).last_success.observation.resources[0].remaining).toBe(20);
    expect(fs.readFileSync(f.file.file, 'utf8')).not.toContain('PRIVATE');
    expect(new ConnectionObservationFile(new ConnectionFile(f.root)).get(key)).toEqual(f.file.get(key));
  } finally { f.close(); }
});

test('multiple processes publish independent observations without lost updates, and cache is bounded', async () => {
  const f = setup();
  try {
    // Prepare private root before spawning to avoid unrelated mkdir races.
    f.file.connections.directory(true);
    const children = Array.from({ length: 4 }, (_, i) => Bun.spawn([process.execPath, '--eval', `
      import { ConnectionFile } from './src/agent/connections-file.js';
      import { ConnectionObservationFile } from './src/agent/connections-observations.js';
      const f = new ConnectionObservationFile(new ConnectionFile(${JSON.stringify(f.root)}, {privateRoot:true}));
      await f.put(${JSON.stringify(String(i).repeat(64))}, ${JSON.stringify(observation(i))});
    `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' }));
    for (const child of children) {
      const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe(''); expect(exit).toBe(0);
    }
    expect(Object.keys(f.file.read())).toHaveLength(4);
    for (let i = 0; i < 65; i++) await f.file.put(i.toString(16).padStart(64, '0'), observation(i, new Date(Date.UTC(2026, 9, 9, 1, i)).toISOString()));
    expect(Object.keys(f.file.read())).toHaveLength(60);
    expect(fs.statSync(f.file.file).size).toBeLessThanOrEqual(2 * 1024 * 1024);
  } finally { f.close(); }
});

test('observation cache rejects unsafe modes, symlinks, hard links, malformed and oversized files without modifying them', async () => {
  const f = setup();
  try {
    await f.file.put(key, observation(12));
    const original = fs.readFileSync(f.file.file, 'utf8');
    fs.chmodSync(f.file.file, 0o644);
    expect(() => f.file.get(key)).toThrow(); await expect(f.file.put(key, observation(99))).rejects.toThrow();
    fs.chmodSync(f.file.file, 0o600);
    const target = path.join(f.root, 'original'); fs.renameSync(f.file.file, target);
    fs.symlinkSync(target, f.file.file);
    expect(() => f.file.get(key)).toThrow(); await expect(f.file.put(key, observation(99))).rejects.toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    fs.unlinkSync(f.file.file); fs.linkSync(target, f.file.file);
    expect(() => f.file.get(key)).toThrow();
    fs.unlinkSync(target);
    fs.writeFileSync(f.file.file, '{INVALID-PRIVATE');
    expect(() => f.file.get(key)).toThrow(); await expect(f.file.put(key, observation(99))).rejects.toThrow();
    expect(fs.readFileSync(f.file.file, 'utf8')).toBe('{INVALID-PRIVATE');
    fs.writeFileSync(f.file.file, ' '.repeat(2 * 1024 * 1024 + 1));
    expect(() => f.file.get(key)).toThrow();
    expect(fs.readdirSync(f.file.connections.dir).some(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toBe(false);
  } finally { f.close(); }
});

test('cache namespaces separate same-provider connections and survive same-account OAuth token renewal only', async () => {
  const f = setup(), manager = new ConnectionManager({ home: f.root });
  try {
    const a = manager.save({ label: 'a', provider: 'deepseek', auth_type: 'api_key' }, { api_key: 'PRIVATE-SAME-KEY' });
    const b = manager.save({ label: 'b', provider: 'deepseek', auth_type: 'api_key' }, { api_key: 'PRIVATE-SAME-KEY' });
    const identity = manager.identity(a.id);
    await manager.recordObservation(a.id, identity.account_key, identity.source_key, observation(12));
    expect(manager.cachedObservation(a.id).observation.resources[0].remaining).toBe(12);
    expect(manager.cachedObservation(b.id)).toBeNull();
    const oauth = manager.save({ label: 'oauth', provider: 'openai-codex', auth_type: 'oauth' });
    manager.file.transaction(data => { data.connections.find(row => row.id === oauth.id).credential = {
      type: 'oauth', access: 'PRIVATE-ACCESS', refresh: 'PRIVATE-REFRESH', expires: Date.now() + 3600000, accountId: 'same-account' }; });
    const binding = manager.identity(oauth.id);
    await manager.recordObservation(oauth.id, binding.account_key, binding.source_key, observation(24));
    manager.file.transaction(data => { const row = data.connections.find(row => row.id === oauth.id);
      row.credential.access = 'PRIVATE-ROTATED'; row.credential.refresh = 'PRIVATE-REFRESH-ROTATED'; row.credential.expires += 3600000; });
    expect(manager.cachedObservation(oauth.id).observation.resources[0].remaining).toBe(24);
    manager.file.transaction(data => { data.connections.find(row => row.id === oauth.id).credential.accountId = 'new-account'; });
    expect(manager.cachedObservation(oauth.id)).toBeNull();
    await expect(manager.recordObservation(oauth.id, binding.account_key, binding.source_key, observation(0))).rejects.toThrow();
  } finally { await manager.stop(); f.close(); }
});
