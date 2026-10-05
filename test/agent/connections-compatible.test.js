import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConnectionManager } from '../../src/agent/connections.js';
import { queryConnection } from '../../src/agent/connections-query.js';
import { createRuntimeConnection, validateRuntimeConnection, parseConnectionHeaders } from '../../src/agent/connection-runtime.js';
import { PiProvider } from '../../src/agent/provider.js';
import { Config } from '../../src/config.js';
import { env } from '../helpers.js';

const fixtures = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.manager.stop(); fs.rmSync(f.root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-compatible-api-'));
  const home = path.join(root, '.lush'); fs.mkdirSync(home, { mode: 0o700 });
  let requests = 0;
  const manager = new ConnectionManager({ home }, { fetch: async () => { requests++; throw new Error('unexpected network'); } });
  const f = { root, home, manager, requests: () => requests }; fixtures.push(f); return f;
}
const config = (extra = {}) => ({ label: 'Custom account', provider: 'openai-compatible', auth_type: 'api_key',
  endpoint: 'https://models.example/v1', models: ['vendor/chat-model', 'another-model'], enabled: true, ...extra });
const edit = row => { const { credential, ...value } = row; return value; };
const profile = row => ({ agent: 'pi', model: 'openai-compatible/vendor/chat-model', connection_id: row.id,
  thinking: '', extensions: [], skills: [] });
const assertNoKey = value => expect(JSON.stringify(value)).not.toContain('CUSTOM-PRIVATE-KEY');

test('compatible connections require explicit HTTPS endpoint, model IDs and API key auth', () => {
  const { manager } = fixture();
  for (const bad of [config({ endpoint: undefined }), config({ endpoint: '' }), config({ endpoint: ' ' }),
    config({ endpoint: 'http://models.example/v1' }), config({ endpoint: 'https://user:secret@models.example/v1' }),
    config({ endpoint: 'https://models.example/v1?key=private' }), config({ endpoint: 'https://models.example/v1#fragment' }),
    config({ models: undefined }), config({ models: [] }), config({ models: ['duplicate', 'duplicate'] }),
    config({ models: ['\u202eevil'] }), config({ auth_type: 'oauth' })]) {
    expect(() => manager.save(bad, { api_key: 'CUSTOM-PRIVATE-KEY' })).toThrow();
  }
  expect(fs.existsSync(manager.file.file)).toBe(false);
});

test('compatible API keys persist privately, without public secrets, and endpoints/accounts remain distinct', async () => {
  const { manager, home } = fixture();
  const a = manager.save(config(), { api_key: 'CUSTOM-PRIVATE-KEY' });
  const b = manager.save(config({ endpoint: 'https://another.example/v1' }), { api_key: 'OTHER-KEY' });
  assertNoKey(a); assertNoKey(manager.config());
  const reread = new ConnectionManager({ home });
  try {
    expect(reread.config().connections).toHaveLength(2);
    const ar = await reread.prepareRuntime(a.id), br = await reread.prepareRuntime(b.id);
    expect(ar.credential).toEqual({ type: 'api_key', key: 'CUSTOM-PRIVATE-KEY' });
    expect(ar.account_key).not.toBe(br.account_key); expect(ar.source_key).not.toBe(br.source_key);
    expect(fs.statSync(manager.file.dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(manager.file.file).mode & 0o777).toBe(0o600);
  } finally { await reread.stop(); }
  const changed = manager.save({ ...edit(a), endpoint: 'https://changed.example/v1' });
  expect(changed.credential.status).toBe('unconfigured');
  await expect(manager.prepareRuntime(a.id)).rejects.toThrow();
});

test('compatible balance query is unsupported even on a known official origin, never zero or a network probe', async () => {
  const f = fixture();
  for (const endpoint of ['https://models.example/v1', 'https://api.deepseek.com', 'https://api.openai.com/v1']) {
    const row = f.manager.save(config({ endpoint }), { api_key: 'CUSTOM-PRIVATE-KEY' });
    const result = await f.manager.query(row.id);
    expect(result.observation).toMatchObject({ status: 'unsupported', source: 'none', error_code: 'unsupported', resources: [] });
    assertNoKey(result);
    // Defensive direct adapter path must also refuse before accessing the credential or invoking request.
    expect(await queryConnection(row, null, '2026-10-05T12:00:00Z', () => { throw new Error('must not request'); }))
      .toMatchObject({ status: 'unsupported', resources: [] });
  }
  expect(f.requests()).toBe(0);
});

test('compatible disabled connections keep existing safe query/runtime behavior', async () => {
  const f = fixture(), row = f.manager.save(config({ enabled: false }), { api_key: 'CUSTOM-PRIVATE-KEY' });
  expect((await f.manager.query(row.id)).observation.error_code).toBe('disabled');
  await expect(f.manager.prepareRuntime(row.id)).rejects.toThrow(); expect(f.requests()).toBe(0);
});

test('compatible model registration freezes the selected endpoint/model and ignores all external provider overrides', async () => {
  const f = fixture(), row = f.manager.save(config(), { api_key: 'CUSTOM-PRIVATE-KEY' });
  const external = path.join(f.root, 'external-pi'); fs.mkdirSync(external);
  const original = JSON.stringify({ providers: { 'openai-compatible': {
    api: 'anthropic-messages', baseUrl: 'https://untrusted.example', apiKey: '!secret-command', headers: { Authorization: 'EXTERNAL-SECRET' },
    models: [{ id: 'vendor/chat-model', api: 'openai-responses', baseUrl: 'https://overridden.example',
      contextWindow: 999999, maxTokens: 999999, reasoning: true, input: ['image'], compat: { maxTokensField: 'max_tokens' } }],
    modelOverrides: { 'vendor/chat-model': { headers: { Authorization: 'EXTERNAL-MODEL-SECRET' }, reasoning: true } },
  } } });
  fs.writeFileSync(path.join(external, 'models.json'), original);
  fs.writeFileSync(path.join(external, 'auth.json'), 'EXTERNAL-AUTH');
  const runtime = await f.manager.prepareRuntime(row.id);
  const managed = createRuntimeConnection({ home: f.home, project: f.root, env: { HOME: f.root } }, profile(row), runtime,
    { PI_CODING_AGENT_DIR: external });
  const models = JSON.parse(fs.readFileSync(path.join(managed.dir, 'models.json'), 'utf8'));
  expect(models).toEqual({ providers: { 'openai-compatible': {
    baseUrl: row.endpoint, api: 'openai-completions',
    models: [{ id: 'vendor/chat-model', name: 'vendor/chat-model', reasoning: false, input: ['text'],
      contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } });
  expect(JSON.parse(fs.readFileSync(path.join(managed.dir, 'auth.json'), 'utf8')))
    .toEqual({ 'openai-compatible': { type: 'api_key', key: 'CUSTOM-PRIVATE-KEY' } });
  expect(fs.statSync(path.join(managed.dir, 'models.json')).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(path.join(external, 'models.json'), 'utf8')).toBe(original);
  expect(fs.readFileSync(path.join(external, 'auth.json'), 'utf8')).toBe('EXTERNAL-AUTH');
  assertNoKey(models);
});

test('compatible runtime validation refuses wrong models, empty scope, unsupported auth and secret commands', async () => {
  const f = fixture(), row = f.manager.save(config(), { api_key: 'CUSTOM-PRIVATE-KEY' });
  const runtime = await f.manager.prepareRuntime(row.id);
  expect(() => validateRuntimeConnection(profile(row), runtime)).not.toThrow();
  for (const model of ['openai/vendor/chat-model', 'openai-compatible/unlisted', 'vendor/chat-model'])
    expect(() => validateRuntimeConnection({ ...profile(row), model }, runtime)).toThrow();
  for (const connection of [{ ...runtime.connection, models: [] }, { ...runtime.connection, auth_type: 'oauth' },
    { ...runtime.connection, enabled: false }])
    expect(() => validateRuntimeConnection(profile(row), { ...runtime, connection })).toThrow();
  for (const key of ['!command', '$PRIVATE', 'bad\nkey'])
    expect(() => validateRuntimeConnection(profile(row), { ...runtime, credential: { type: 'api_key', key } })).toThrow();
  expect(parseConnectionHeaders('openai-compatible', { 'x-ratelimit-remaining-tokens': '1000' }, 200)).toBeNull();
});

for (const fail of [false, true]) test(`compatible Pi invocation uses isolated selected model and cleans up (failure=${fail})`, async () => {
  const f = fixture(), row = f.manager.save(config(), { api_key: 'CUSTOM-PRIVATE-KEY' });
  const runtime = await f.manager.prepareRuntime(row.id);
  const fake = path.join(f.root, 'fake-compatible-pi');
  fs.writeFileSync(fake, `#!/usr/bin/env bun\nimport fs from 'node:fs';import path from 'node:path';\nconst args=process.argv.slice(2),dir=process.env.PI_CODING_AGENT_DIR;\nconst auth=JSON.parse(fs.readFileSync(path.join(dir,'auth.json'),'utf8'));\nconst p=JSON.parse(fs.readFileSync(path.join(dir,'models.json'),'utf8')).providers['openai-compatible'];\nif(!args.includes('--no-approve')||!args.includes('openai-compatible/vendor/chat-model')||args.includes('--api-key')||p.api!=='openai-completions'||p.models.length!==1||!auth['openai-compatible'])process.exit(7);\nfs.writeFileSync(path.join(process.env.LUSH_HOME,'private-dir'),dir);\n${fail ? "console.error(auth['openai-compatible'].key);process.exit(1);" : "console.log('compatible finished');"}\n`, { mode: 0o755 });
  const cfg = new Config({ project: f.root, env: env({ LUSH_PI_COMMAND: fake }) }); cfg.prepare();
  const call = new PiProvider(cfg).run({ task: { id: 17, role: 'agent', goal: 'test compatible' }, context: { invocation: { run_id: 7 } },
    agent: profile(row), connectionRuntime: runtime, messages: [], cwd: f.root, token: 'mock-invocation-token',
    signal: new AbortController().signal, onSpawn() {} });
  if (fail) await expect(call).rejects.toThrow('managed Pi invocation failed');
  else expect(await call).toBe('compatible finished');
  const dir = fs.readFileSync(path.join(f.home, 'private-dir'), 'utf8'); expect(fs.existsSync(dir)).toBe(false);
  const prompt = fs.readFileSync(path.join(f.home, 'sessions/task-17-input.md'), 'utf8');
  expect(prompt).toContain(row.id); expect(prompt).not.toContain('CUSTOM-PRIVATE-KEY');
});
