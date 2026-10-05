import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSources, runResources } from '../src/cli/commands/agent-sources.js';

const connection = extra => ({ id: 'conn-one', label: '账号', provider: 'deepseek', endpoint: 'https://api.deepseek.com',
  auth_type: 'api_key', enabled: true, models: [], credential: { status: 'configured', identity: null, expires_at: null },
  observation: { status: 'available', checked_at: '2026-01-10T12:00:00.000Z', source: 'usage_api', error_code: null, reason: null, resources: [] },
  last_success: null, consumers: [], secret_field: 'MUST_NOT_PRINT', ...extra });

function fixture(response = { connections: [connection()], checked_at: '2026-01-10T12:00:00.000Z', sampling: null }) {
  const calls = [];
  const client = { token: null, request: async (method, params) => { calls.push({ method, params }); return typeof response === 'function' ? response(method, params) : response; } };
  return { calls, client };
}
const temp_file = (name, body) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-sources-cli-')); const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode: 0o600 }); return { dir, file }; };

test('sources list/show/refresh project only the safe read face and never print unknown fields', async () => {
  const f = fixture();
  const list = await runSources(['list'], f.client);
  expect(f.calls).toEqual([{ method: 'agent.connections.list', params: {} }]);
  expect(list.connections[0].id).toBe('conn-one'); expect(list.connections[0].secret_field).toBeUndefined();
  expect(JSON.stringify(list)).not.toContain('MUST_NOT_PRINT');
  const shown = await runSources(['show', 'conn-one'], f.client);
  expect(shown.provider).toBe('deepseek');
  const refreshed = await runSources(['refresh', 'conn-one'], f.client);
  expect(f.calls.at(-2)).toEqual({ method: 'agent.connections.query', params: { id: 'conn-one' } });
  expect(f.calls.at(-1)).toEqual({ method: 'agent.connections.list', params: {} });
  expect(refreshed.queried).toBe('conn-one');
  await runSources(['refresh'], f.client);
  expect(f.calls.at(-2)).toEqual({ method: 'agent.connections.query', params: {} });
});

test('sources models reads the cache and only refreshes with --refresh', async () => {
  const catalog = { version: 1, id: 'conn-one', checked_at: '2026-01-10T12:00:00.000Z', status: 'fresh', source: 'listing',
    models: [{ id: 'deepseek/deepseek-chat', name: 'chat', thinking_levels: null, context: null, max_output: null, images: null, reasoning: null }],
    warning: null, error_code: null, extra: 'MUST_NOT_PRINT' };
  const f = fixture(() => catalog);
  const cached = await runSources(['models', 'conn-one'], f.client);
  expect(f.calls.at(-1)).toEqual({ method: 'agent.connections.models', params: { id: 'conn-one' } });
  expect(cached.models[0].id).toBe('deepseek/deepseek-chat'); expect(JSON.stringify(cached)).not.toContain('MUST_NOT_PRINT');
  await runSources(['models', 'conn-one', '--refresh'], f.client);
  expect(f.calls.at(-1)).toEqual({ method: 'agent.connections.models.refresh', params: { id: 'conn-one' } });
});

test('sources save reads credentials from a private file, never argv or output', async () => {
  const f = fixture(connection({ credential: { status: 'configured', identity: null, expires_at: null } }));
  const input = temp_file('source.json', JSON.stringify({ connection: { id: 'conn-one', label: '账号', provider: 'deepseek', auth_type: 'api_key', enabled: true, models: [] }, credential: { api_key: 'PRIVATE-KEY' } }));
  try {
    const saved = await runSources(['save', '--file', input.file], f.client);
    expect(f.calls).toEqual([{ method: 'agent.connections.save', params: { connection: input_json(), credential: { api_key: 'PRIVATE-KEY' } } }]);
    expect(JSON.stringify(saved)).not.toContain('PRIVATE-KEY');
  } finally { fs.rmSync(input.dir, { recursive: true, force: true }); }
  function input_json() { return { id: 'conn-one', label: '账号', provider: 'deepseek', auth_type: 'api_key', enabled: true, models: [] }; }
});

test('sources remove and login device/callback flows stay narrow and hide callback codes', async () => {
  const f = fixture(method => method === 'agent.connections.device.start'
    ? { id: 'conn-one', login_id: 'login-1', verification_uri: 'https://auth.openai.com/codex/device', user_code: 'AB-12', expires_at: '2026-01-10T12:15:00.000Z', interval_seconds: 5 }
    : method === 'agent.connections.login.start'
      ? { id: 'conn-one', login_id: 'login-2', url: 'https://auth.openai.com/oauth/authorize?state=x', expires_at: '2026-01-10T12:15:00.000Z', redirect_uri: 'http://localhost:1455/auth/callback', instructions: '手动粘贴回调' }
      : { removed: 'conn-one' });
  await runSources(['remove', 'conn-one'], f.client);
  expect(f.calls.at(-1)).toEqual({ method: 'agent.connections.remove', params: { id: 'conn-one' } });
  const started = await runSources(['login', 'conn-one'], f.client);
  expect(f.calls.at(-1)).toEqual({ method: 'agent.connections.device.start', params: { id: 'conn-one' } });
  expect(started.user_code).toBe('AB-12');
  await runSources(['login', 'conn-one', '--poll', 'login-1'], f.client);
  expect(f.calls.at(-1)).toEqual({ method: 'agent.connections.device.poll', params: { id: 'conn-one', login_id: 'login-1' } });
  await runSources(['login', 'conn-one', '--cancel', 'login-1'], f.client);
  expect(f.calls.at(-1)).toEqual({ method: 'agent.connections.device.cancel', params: { id: 'conn-one', login_id: 'login-1' } });
  await runSources(['login', 'conn-one', '--callback'], f.client);
  expect(f.calls.at(-1)).toEqual({ method: 'agent.connections.login.start', params: { id: 'conn-one' } });
  const url = temp_file('callback.txt', 'http://localhost:1455/auth/callback?code=PRIVATE-CODE&state=x');
  const finisher = fixture(connection());
  try {
    const finished = await runSources(['login', 'conn-one', '--finish', 'login-2', '--url-file', url.file], finisher.client);
    expect(finisher.calls).toEqual([{ method: 'agent.connections.login.finish', params: { id: 'conn-one', login_id: 'login-2', redirect_url: 'http://localhost:1455/auth/callback?code=PRIVATE-CODE&state=x' } }]);
    expect(JSON.stringify(finished)).not.toContain('PRIVATE-CODE');
  } finally { fs.rmSync(url.dir, { recursive: true, force: true }); }
});

test('agent tokens and malformed arguments fail before any RPC', async () => {
  const f = fixture(); f.client.token = 'invocation-capability';
  for (const args of [['list'], ['show', 'conn-one'], ['save', '--file', '/missing']]) {
    await expect(runSources(args, f.client)).rejects.toThrow('agents cannot read or change');
    await expect(runResources([], f.client)).rejects.toThrow('agents cannot read or change');
  }
  expect(f.calls).toHaveLength(0);
  const g = fixture();
  for (const args of [['list', 'extra'], ['show'], ['models'], ['models', 'conn-one', 'extra'], ['save'], ['remove'], ['remove', 'a', 'b'], ['login'], ['login', 'x', '--poll', 'a', '--cancel', 'b'], ['unknown']]) {
    await expect(runSources(args, g.client)).rejects.toThrow();
  }
  await expect(runSources(['login', 'conn-one', '--finish', 'login-2'], g.client)).rejects.toThrow('--url-file');
  await expect(runSources(['save', '--file', '/definitely/missing.json'], g.client)).rejects.toThrow('cannot safely read');
  expect(g.calls).toHaveLength(0);
});

test('resources exposes the shared read face only and requires no arguments', async () => {
  const f = fixture({ version: 1, checked_at: '2026-01-10T12:00:00.000Z',
    connections: [{ ...connection(), supported_agents: ['pi'], model_catalog: { version: 1, id: 'conn-one', checked_at: '2026-01-10T12:00:00.000Z', status: 'fresh', source: 'listing', models: [], warning: null, error_code: null, extra: 'MUST_NOT_PRINT' } }] });
  const value = await runResources([], f.client);
  expect(f.calls).toEqual([{ method: 'agent.selection.resources', params: {} }]);
  expect(value.connections[0].supported_agents).toEqual(['pi']);
  expect(value.connections[0].model_catalog.source).toBe('listing');
  expect(JSON.stringify(value)).not.toContain('MUST_NOT_PRINT');
  await expect(runResources(['extra'], f.client)).rejects.toThrow();
});

test('nested observation/resource/last_success/consumer fields are allow-listed, never passed through', async () => {
  const f = fixture({ checked_at: '2026-01-10T12:00:00.000Z',
    sampling: { enabled: false, interval_minutes: 5, retention_days: 90, api_key: 'SECRET-SAMPLING' },
    connections: [connection({
      observation: { status: 'available', checked_at: '2026-01-10T12:00:00.000Z', source: 'usage_api', error_code: null, reason: 'ok',
        api_key: 'SECRET-OBS', resources: [{ id: 'r', kind: 'quota', scope: 'account', label: 'q', unit: '%', remaining: 5, total: 100, used: 95,
          used_percent: 95, reset_at: null, window_seconds: 18000, models: ['deepseek/x'], api_key: 'SECRET-KEY', headers: { authorization: 'SECRET-HEADER' } }] },
      last_success: { checked_at: '2026-01-10T11:00:00.000Z', token: 'SECRET-LAST',
        observation: { status: 'available', checked_at: '2026-01-10T11:00:00.000Z', source: 'usage_api', error_code: null, reason: null,
          resources: [{ id: 'r', kind: 'quota', scope: 'account', label: 'q', unit: '%', remaining: 70, token: 'SECRET-TOKEN' }] } },
      consumers: [{ task_id: 7, model: 'deepseek/x', api_key: 'SECRET-CONSUMER', headers: { authorization: 'SECRET-H' } }],
    })] });
  const list = await runSources(['list'], f.client);
  expect(JSON.stringify(list)).not.toMatch(/SECRET/);
  const row = list.connections[0];
  expect(row.observation).not.toHaveProperty('api_key');
  expect(row.observation.resources[0]).not.toHaveProperty('api_key');
  expect(row.observation.resources[0]).not.toHaveProperty('headers');
  expect(row.observation.resources[0]).toMatchObject({ id: 'r', kind: 'quota', remaining: 5, window_seconds: 18000, models: ['deepseek/x'] });
  expect(row.last_success).not.toHaveProperty('token');
  expect(row.last_success.observation.resources[0]).not.toHaveProperty('token');
  expect(row.consumers[0]).toEqual({ task_id: 7, model: 'deepseek/x' });
  expect(list.sampling).toEqual({ enabled: false, interval_minutes: 5, retention_days: 90 });
  expect(list.sampling).not.toHaveProperty('api_key');
});

test('private input files must be owner-only regular files and errors leak no path or content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-sources-sec-'));
  const f = fixture();
  const body = JSON.stringify({ connection: { id: 'conn-one', label: '账号', provider: 'deepseek', auth_type: 'api_key', enabled: true, models: [] }, credential: { api_key: 'PRIVATE-KEY' } });
  const write = (name, mode = 0o600, text = body) => { const file = path.join(dir, name); fs.writeFileSync(file, text, { mode }); fs.chmodSync(file, mode); return file; };
  try {
    const good = write('good.json');
    await runSources(['save', '--file', good], f.client);
    const readable = write('world.json', 0o644);
    const link = path.join(dir, 'link.json'); fs.symlinkSync(good, link);
    const huge = write('huge.json', 0o600, body + ' '.repeat(70000));
    const fifo = path.join(dir, 'fifo'); Bun.spawnSync(['mkfifo', fifo]);
    for (const file of [readable, link, dir, huge, fifo]) {
      try { await runSources(['save', '--file', file], f.client); throw new Error('expected rejection'); }
      catch (error) {
        expect(error.message).toBe('cannot safely read the input file: owner-only regular file required');
        expect(error.message).not.toContain(dir); expect(error.message).not.toContain('PRIVATE-KEY');
      }
    }
    // Callback URL files use the same guarantees and never echo the code.
    const url = path.join(dir, 'callback.txt'); fs.writeFileSync(url, 'http://localhost:1455/auth/callback?code=PRIVATE-CODE&state=x', { mode: 0o644 });
    fs.chmodSync(url, 0o644);
    try { await runSources(['login', 'conn-one', '--finish', 'login-2', '--url-file', url], f.client); throw new Error('expected rejection'); }
    catch (error) {
      expect(error.message).toBe('cannot safely read the callback file: owner-only regular file required');
      expect(error.message).not.toContain('PRIVATE-CODE');
    }
    const urlLink = path.join(dir, 'callback-link.txt'); fs.symlinkSync(good, urlLink);
    await expect(runSources(['login', 'conn-one', '--finish', 'login-2', '--url-file', urlLink], f.client)).rejects.toThrow('owner-only regular file required');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
