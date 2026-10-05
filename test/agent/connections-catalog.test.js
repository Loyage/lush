import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConnectionManager } from '../../src/agent/connections.js';
import { DEFAULT_ENDPOINTS } from '../../src/agent/connections-utils.js';
import { catalogKey, listingUrl } from '../../src/agent/connections-catalog.js';

const fixtures = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await Promise.all(f.managers.map(m => m.stop())); fs.rmSync(f.root, { recursive: true, force: true }); } });
function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-catalog-')), home = path.join(root, '.lush');
  fs.mkdirSync(home, { mode: 0o700 });
  const manager = new ConnectionManager({ home }, options);
  const f = { root, home, manager, managers: [manager] }; fixtures.push(f); return f;
}
const config = (provider = 'deepseek', values = {}) => ({ label: '账号', provider,
  auth_type: provider === 'openai-codex' ? 'oauth' : 'api_key', enabled: true, models: [], ...values });
const edit = (row, values = {}) => ({ id: row.id, label: row.label, provider: row.provider, endpoint: row.endpoint,
  auth_type: row.auth_type, enabled: row.enabled, models: row.models, ...values });
const json = data => Response.json(data);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('listing catalog is qualified, cached without network and uses the connection origin only', async () => {
  const calls = [];
  const f = fixture({ fetch: async (url, init) => { calls.push({ url, init }); return json({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }); } });
  const row = f.manager.save(config(), { api_key: 'private-listing-key' });
  expect(f.manager.catalog(row.id).status).toBe('unknown');
  expect(calls).toHaveLength(0);
  const catalog = await f.manager.catalogRefresh(row.id);
  expect(catalog.status).toBe('fresh'); expect(catalog.source).toBe('listing');
  expect(catalog.models.map(model => model.id)).toEqual(['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner']);
  expect(calls).toHaveLength(1); expect(calls[0].url).toBe('https://api.deepseek.com/models');
  expect(calls[0].init.headers.Authorization).toBe('Bearer private-listing-key');
  // Cached read is local and returns the same identity-scoped entry.
  expect(f.manager.catalog(row.id)).toEqual(catalog);
  expect(calls).toHaveLength(1);
  const body = fs.readFileSync(f.manager.catalogs.file, 'utf8');
  expect(body).not.toContain('private-listing-key');
  expect(fs.statSync(f.manager.catalogs.file).mode & 0o777).toBe(0o600);
  expect(fs.statSync(f.manager.file.dir).mode & 0o777).toBe(0o700);
});

test('openrouter listing is public, bounded and carries only evidenced capabilities', async () => {
  const f = fixture({ fetch: async () => json({ data: [
    { id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['reasoning'] },
    { id: 'meta/llama', name: 'Llama', context_length: 8192 },
    { id: 'openai/gpt-4o', name: 'duplicate' },
  ] }) });
  const row = f.manager.save(config('openrouter'), { api_key: 'private-openrouter-key' });
  const catalog = await f.manager.catalogRefresh(row.id);
  expect(catalog.status).toBe('fresh'); expect(catalog.source).toBe('listing'); expect(catalog.models).toHaveLength(2);
  const first = catalog.models[0];
  expect(first.id).toBe('openrouter/openai/gpt-4o'); expect(first.images).toBe(true); expect(first.reasoning).toBe(true);
  expect(first.thinking_levels).toBe(null); expect(first.context).toBe(128000);
  expect(listingUrl({ endpoint: DEFAULT_ENDPOINTS.openrouter }, { path: '/api/v1/models' })).toBe('https://openrouter.ai/api/v1/models');
});

test('listing failure keeps manual range, then reports a safe error; no model probe is attempted', async () => {
  const f = fixture({ fetch: async () => { throw new Error('raw upstream SECRET'); } });
  const restricted = f.manager.save(config('deepseek', { models: ['deepseek-chat'] }), { api_key: 'private-key' });
  const fallback = await f.manager.catalogRefresh(restricted.id);
  expect(fallback.status).toBe('cached'); expect(fallback.source).toBe('manual');
  expect(fallback.models.map(model => model.id)).toEqual(['deepseek/deepseek-chat']);
  expect(JSON.stringify(fallback)).not.toContain('SECRET');
  const bare = f.manager.save(config('deepseek'), { api_key: 'private-key-2' });
  const failed = await f.manager.catalogRefresh(bare.id);
  expect(failed.status).toBe('error'); expect(failed.models).toEqual([]);
  expect(JSON.stringify(failed)).not.toContain('SECRET');
});

test('providers without a listing use injected Pi-local metadata or fall back to unsupported', async () => {
  const f = fixture({ piModels: async () => ({ models: [
    { provider: 'openai-codex', id: 'openai-codex/gpt-5.4', label: 'GPT-5.4', thinking: true, images: true, context: '400000', max_output: '128000' },
    { provider: 'other', id: 'other/x', label: 'x' },
  ] }) });
  const row = f.manager.save(config('openai-codex', { endpoint: DEFAULT_ENDPOINTS['openai-codex'], auth_type: 'oauth' }));
  const local = await f.manager.catalogRefresh(row.id);
  expect(local.status).toBe('cached'); expect(local.source).toBe('pi-local');
  expect(local.models.map(model => model.id)).toEqual(['openai-codex/gpt-5.4']);
  const empty = fixture({ piModels: async () => ({ models: [] }) });
  const bare = empty.manager.save(config('openai-codex', { endpoint: DEFAULT_ENDPOINTS['openai-codex'], auth_type: 'oauth' }));
  expect((await empty.manager.catalogRefresh(bare.id)).status).toBe('unsupported');
});

test('catalogs are isolated per account and endpoint, and a rescued OAuth access token does not resplit them', () => {
  const f = fixture({ piModels: async () => ({ models: [{ provider: 'openai-codex', id: 'openai-codex/m', label: 'm' }] }) });
  const a = f.manager.save(config('deepseek'), { api_key: 'key-a' });
  const b = f.manager.save(config('deepseek'), { api_key: 'key-b' });
  const keyOf = id => catalogKey(f.manager.file.read().connections.find(row => row.id === id), f.manager.identity(id));
  expect(keyOf(a.id)).not.toBe(keyOf(b.id));
  const identity = f.manager.identity(a.id);
  expect(catalogKey({ provider: 'deepseek', endpoint: DEFAULT_ENDPOINTS.deepseek, models: [] }, identity))
    .not.toBe(catalogKey({ provider: 'deepseek', endpoint: 'https://proxy.example/v1', models: [] }, identity));
  // Rotating the API key to a different account identity must not reuse the old catalog key.
  const before = f.manager.identity(a.id);
  f.manager.save(edit(a), { api_key: 'key-a-rotated' });
  expect(f.manager.identity(a.id).account_key).not.toBe(before.account_key);
});

test('late listing results are discarded when the connection changes mid-request', async () => {
  const blocked = deferred(), entered = deferred();
  const f = fixture({ fetch: async () => { entered.resolve(); await blocked.promise; return json({ data: [{ id: 'deepseek-chat' }] }); } });
  const row = f.manager.save(config('deepseek'), { api_key: 'private-key' });
  const pending = f.manager.catalogRefresh(row.id);
  await entered.promise;
  f.manager.save(edit(row, { endpoint: 'https://proxy.example/v1' }), { api_key: 'private-key' });
  blocked.resolve();
  expect(await pending).toBeNull();
  expect(f.manager.catalog(row.id).status).toBe('unknown');
  expect(f.manager.catalogs.read().entries).toEqual({});
});

test('stop aborts an in-flight listing and never writes a late catalog', async () => {
  const blocked = deferred();
  const f = fixture({ fetch: async () => { await blocked.promise; return json({ data: [{ id: 'deepseek-chat' }] }); } });
  const row = f.manager.save(config('deepseek'), { api_key: 'private-key' });
  const pending = f.manager.catalogRefresh(row.id).catch(error => error?.connectionCode || 'failed');
  const stopped = f.manager.stop();
  blocked.resolve();
  expect(['stopped', 'auth_changed', 'network', null]).toContain((await pending) ?? null);
  await stopped;
  expect(f.manager.catalogs.read().entries).toEqual({});
});

test('disabled connections are not listed and keep only their manual range locally', async () => {
  const f = fixture({ fetch: () => { throw new Error('must not fetch'); } });
  const row = f.manager.save(config('deepseek', { enabled: false, models: ['deepseek-chat'] }), { api_key: 'private-key' });
  const catalog = await f.manager.catalogRefresh(row.id);
  expect(catalog.status).toBe('unknown'); expect(catalog.source).toBe('manual');
  expect(catalog.models.map(model => model.id)).toEqual(['deepseek/deepseek-chat']);
  expect(f.manager.catalogs.read().entries).toEqual({});
});

test('concurrent per-connection refreshes persist each catalog without locking each other out', async () => {
  const f = fixture({ fetch: async url => url.includes('/api/v1/models')
    ? json({ data: [{ id: 'meta/llama' }] }) : json({ data: [{ id: 'deepseek-chat' }] }) });
  const deep = f.manager.save(config('deepseek'), { api_key: 'key-a' });
  const router = f.manager.save(config('openrouter'), { api_key: 'key-b' });
  const [first, second] = await Promise.all([f.manager.catalogRefresh(deep.id), f.manager.catalogRefresh(router.id)]);
  expect(first.status).toBe('fresh'); expect(second.status).toBe('fresh');
  expect(f.manager.catalog(deep.id).models[0].id).toBe('deepseek/deepseek-chat');
  expect(f.manager.catalog(router.id).models[0].id).toBe('openrouter/meta/llama');
  expect(Object.keys(f.manager.catalogs.read().entries)).toHaveLength(2);
});
