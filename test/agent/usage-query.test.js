import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverAgentUsage, discoverAgentStatus } from '../../src/agent/status.js';
import { queryAccountBalance, queryCustomBalance } from '../../src/agent/usage-query.js';

const at = '2026-01-01T00:00:00.000Z';
const response = value => new Response(JSON.stringify(value));
function world() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-usage-query-'));
  const home = path.join(project, '.lush'), configDir = path.join(home, 'pi');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const config = { project, home, env: { PI_CODING_AGENT_DIR: configDir, LUSH_PI_COMMAND: '/never-execute-for-usage', PATH: process.env.PATH } };
  const profile = { agent: 'pi', model: 'openai-codex/test' };
  const auth = value => fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify(value), { mode: 0o600 });
  const models = value => fs.writeFileSync(path.join(configDir, 'models.json'), JSON.stringify(value), { mode: 0o600 });
  return { project, configDir, config, profile, auth, models, close() { fs.rmSync(project, { recursive: true, force: true }); } };
}
const oauth = (id = 'private-account-a', access = 'PRIVATE_ACCESS') => ({ type: 'oauth', accountId: id, access, refresh: 'PRIVATE_REFRESH', expires: Date.now() + 3600000 });
const codexPayload = () => ({ rate_limit: { primary_window: { used_percent: 0.5, limit_window_seconds: 18000, reset_after_seconds: 60 },
  secondary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 1768000000 } } });
const mapping = () => ({ provider: 'custom', label: 'Custom quota', url: 'https://usage.example.test/v1', method: 'GET',
  headers: { Authorization: 'Bearer ${USAGE_KEY}' }, body: null, kind: 'quota', items: [
    { id: 'quota', label: 'Quota', unit: 'credits', remaining: 'data.remaining', total: 'data.limit', used: 'data.used', reset_at: 'data.reset', window_seconds: 18000 },
  ] });

test('Codex uses read-only bearer, keeps true fractional percentages and distinct window/reset metadata', async () => {
  const value = await queryAccountBalance('openai-codex', 'SECRET', at, { fetch: async (url, init) => {
    expect(url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer SECRET' } });
    return response(codexPayload());
  } });
  expect(value).toMatchObject({ status: 'available', kind: 'quota', queried: true, error_code: null, items: [
    { id: 'primary', remaining: 99.5, used: 0.5, total: 100, unit: '%', window_seconds: 18000, reset_at: '2026-01-01T00:01:00.000Z' },
    { id: 'secondary', remaining: 0, used: 100, total: 100, unit: '%', window_seconds: 604800 },
  ] });
  expect(value.reason).toContain('非稳定公开 API'); expect(JSON.stringify(value)).not.toContain('SECRET');
});

test('Codex missing or invalid percentages stay unknown and a completely unrecognized response is an error', async () => {
  const partial = await queryAccountBalance('openai-codex', 'SECRET', at, { fetch: async () => response({ rate_limit: { primary_window: { used_percent: 0 } } }) });
  expect(partial.items[0].remaining).toBe(100);
  expect(partial.items[1]).toMatchObject({ remaining: null, total: null, used: null, reset_at: null });
  for (const data of [{}, { rate_limit: { primary_window: { used_percent: 101 }, secondary_window: { used_percent: -1 } } }]) {
    const value = await queryAccountBalance('openai-codex', 'SECRET', at, { fetch: async () => response(data) });
    expect(value).toMatchObject({ status: 'error', items: [], error_code: 'invalid_response' });
  }
});

test('Z.AI parses independent limits without inventing daily/weekly names or fractional scales', async () => {
  const value = await queryAccountBalance('zai', 'SECRET', at, { fetch: async url => {
    expect(url).toBe('https://api.z.ai/api/monitor/usage/quota/limit');
    return response({ data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 0.5, nextResetTime: 1768000000000 },
      { type: 'TIME_LIMIT', currentValue: 2, remaining: 8 }] } });
  } });
  expect(value.items[0]).toMatchObject({ id: 'tokens_limit', used: 0.5, remaining: 99.5, window_seconds: null, reset_at: new Date(1768000000000).toISOString() });
  expect(value.items[1]).toMatchObject({ id: 'time_limit', used: 2, remaining: 8, total: 10, unit: '额度单位' });
});

test('Kimi preserves missing buckets and numerical string quotas without mistaking null for zero', async () => {
  const value = await queryAccountBalance('kimi-coding', 'SECRET', at, { fetch: async url => {
    expect(url).toBe('https://api.kimi.com/coding/v1/usages');
    return response({ usage: { used: '10', remaining: '90', limit: '100', resetTime: '2026-01-03T00:00:00Z' },
      limits: [{ detail: { used: null, remaining: null, limit: null } }] });
  } });
  expect(value.items[0]).toMatchObject({ id: 'membership', used: 10, remaining: 90, total: 100, reset_at: '2026-01-03T00:00:00.000Z' });
  expect(value.items[1]).toMatchObject({ used: null, remaining: null, total: null });
  expect(value.items[1].label).not.toContain('每日');
});

test('lightweight discovery queries selected accounts without Pi executable or OAuth writes', async () => {
  const f = world();
  try {
    f.auth({ 'openai-codex': oauth(), deepseek: { type: 'api_key', key: 'PRIVATE_DEEPSEEK' } });
    const before = fs.readFileSync(path.join(f.configDir, 'auth.json'), 'utf8');
    let calls = 0;
    const value = await discoverAgentUsage(f.config, f.profile, { fetch: async url => { calls++; expect(url).toContain('chatgpt.com/'); return response(codexPayload()); } });
    expect(calls).toBe(1); expect(value.current_provider).toBe('openai-codex');
    expect(value.accounts.find(row => row.provider === 'deepseek').balance.queried).toBe(false);
    expect(value.accounts.find(row => row.provider === 'openai-codex').account_key).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(path.join(f.configDir, 'auth.json'), 'utf8')).toBe(before);
    expect(fs.readdirSync(f.configDir)).toEqual(['auth.json']);
    expect(JSON.stringify(value)).not.toContain('PRIVATE');
  } finally { f.close(); }
});

test('OAuth refresh token rotation preserves history identity, a different account does not', async () => {
  const f = world();
  try {
    const options = { fetch: async () => response(codexPayload()) };
    f.auth({ 'openai-codex': oauth() });
    const first = (await discoverAgentUsage(f.config, f.profile, options)).accounts[0].account_key;
    f.auth({ 'openai-codex': oauth('private-account-a', 'ROTATED_ACCESS') });
    expect((await discoverAgentUsage(f.config, f.profile, options)).accounts[0].account_key).toBe(first);
    f.auth({ 'openai-codex': oauth('private-account-b', 'ROTATED_ACCESS') });
    expect((await discoverAgentUsage(f.config, f.profile, options)).accounts[0].account_key).not.toBe(first);
  } finally { f.close(); }
});

test('expired OAuth refresh failure is a safe error, unsupported providers and proxy credentials are not queried', async () => {
  const f = world();
  try {
    f.auth({ 'openai-codex': { ...oauth(), expires: 1 }, unknown: { type: 'api_key', key: 'PRIVATE_KEY' }, zai: { type: 'api_key', key: 'PRIVATE_KEY' } });
    f.models({ providers: { zai: { baseUrl: 'https://proxy.invalid' } } });
    let calls = 0;
    const value = await discoverAgentUsage(f.config, f.profile, { usageConfig: { providers: ['openai-codex', 'unknown', 'zai'] }, fetch() { calls++; throw new Error(); } });
    expect(calls).toBe(1);
    expect(value.accounts.find(row => row.provider === 'openai-codex').balance).toMatchObject({ status: 'error', queried: true, error_code: 'network' });
    for (const provider of ['unknown', 'zai']) expect(value.accounts.find(row => row.provider === provider).balance.queried).toBe(false);
  } finally { f.close(); }
});

test('Codex subscription queries never treat an API key as an OAuth login', async () => {
  const f = world();
  try {
    f.auth({ 'openai-codex': { type: 'api_key', key: 'PRIVATE' } });
    let calls = 0;
    const result = await discoverAgentUsage(f.config, f.profile, { fetch() { calls++; throw new Error(); } });
    expect(calls).toBe(0); expect(result.accounts[0].balance).toMatchObject({ status: 'unsupported', queried: false });
    expect(result.accounts[0].balance.reason).toContain('OAuth');
  } finally { f.close(); }
});

test('custom HTTP mappings use only explicit environment auth and safely serialize POST JSON', async () => {
  const custom = { ...mapping(), method: 'POST', body: '{"token":"${USAGE_KEY}","fixed":1}', headers: {} };
  const value = await queryCustomBalance(custom, { USAGE_KEY: 'a"b\\c\nPRIVATE' }, at, { fetch: async (url, init) => {
    expect(url).toBe(custom.url); expect(init.redirect).toBe('error'); expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ token: 'a"b\\c\nPRIVATE', fixed: 1 });
    return response({ data: { limit: '100', used: '30', reset: 1768000000 }, secret: 'PRIVATE_RESPONSE' });
  } });
  expect(value).toMatchObject({ status: 'available', items: [{ remaining: 70, total: 100, used: 30, window_seconds: 18000, reset_at: new Date(1768000000000).toISOString() }] });
  expect(JSON.stringify(value)).not.toContain('PRIVATE');
});

test('custom standalone provider and changed source/credential produce distinct anonymous history keys', async () => {
  const f = world();
  try {
    f.config.env.USAGE_KEY = 'PRIVATE_ONE';
    const custom = mapping(), options = { usageConfig: { providers: ['custom'], custom: [custom] }, fetch: async (_, init) => {
      expect(init.headers.Authorization).toBe(`Bearer ${f.config.env.USAGE_KEY}`); return response({ data: { remaining: 6 } });
    } };
    const first = (await discoverAgentUsage(f.config, f.profile, options)).accounts.find(row => row.provider === 'custom');
    expect(first.balance).toMatchObject({ status: 'available', queried: true });
    custom.url = 'https://other.example.test/v1';
    const second = (await discoverAgentUsage(f.config, f.profile, options)).accounts.find(row => row.provider === 'custom');
    expect(second.account_key).not.toBe(first.account_key);
    f.config.env.USAGE_KEY = 'PRIVATE_TWO';
    const third = (await discoverAgentUsage(f.config, f.profile, options)).accounts.find(row => row.provider === 'custom');
    expect(third.account_key).not.toBe(second.account_key);
    expect(JSON.stringify(third)).not.toContain('PRIVATE');
  } finally { f.close(); }
});

test('custom configuration never sends implicit Pi credentials and rejects unsafe env/header/URL before fetch', async () => {
  const cases = [
    { headers: { Authorization: '${LUSH_AGENT_TOKEN}' } }, { headers: { Authorization: '${PI_SESSION_FILE}' } },
    { headers: { Authorization: '${MISSING}' } }, { headers: { Authorization: '${INJECT}' } },
    { headers: { Host: 'attacker.test' } }, { url: 'http://insecure.example.test' },
    { url: 'https://user:pass@example.test' }, { url: 'https://example.test/#fragment' },
    { url: 'https://example.test/${USAGE_KEY}' }, { method: 'DELETE' },
  ];
  for (const patch of cases) {
    let calls = 0;
    const value = await queryCustomBalance({ ...mapping(), ...patch }, { LUSH_AGENT_TOKEN: 'PRIVATE', PI_SESSION_FILE: 'PRIVATE', INJECT: 'Bearer x\r\nHost: attacker' }, at,
      { fetch() { calls++; throw new Error('PRIVATE'); } });
    expect(calls).toBe(0); expect(value.queried).toBe(true); expect(value.items).toEqual([]); expect(JSON.stringify(value)).not.toContain('PRIVATE');
  }
  const f = world();
  try {
    f.auth({ 'openai-codex': oauth() });
    const custom = { ...mapping(), provider: 'openai-codex', headers: {} };
    await discoverAgentUsage(f.config, f.profile, { usageConfig: { custom: [custom] }, fetch: async (_, init) => {
      expect(init.headers.Authorization).toBeUndefined(); return response({ data: { remaining: 2 } });
    } });
  } finally { f.close(); }
});

test('failed query codes are safe and bounded for authorization, body, timeout and non-JSON errors', async () => {
  for (const [fetch, code] of [
    [async () => new Response('PRIVATE', { status: 401 }), 'unauthorized'],
    [async () => new Response('PRIVATE', { status: 403 }), 'unauthorized'],
    [async () => new Response('PRIVATE', { status: 302 }), 'network'],
    [async () => new Response('x'.repeat(65537)), 'invalid_response'],
    [async () => new Response('PRIVATE'), 'invalid_response'],
    [async () => { throw new Error('PRIVATE'); }, 'network'],
    [async () => new Promise(() => {}), 'timeout'],
  ]) {
    const value = await queryAccountBalance('openai-codex', 'PRIVATE', at, { fetch, timeout: 10 });
    expect(value).toMatchObject({ status: 'error', error_code: code, items: [], queried: true });
    expect(JSON.stringify(value)).not.toContain('PRIVATE');
  }
});

test('field mapping reads only own fields and missing or empty numbers never become zero', async () => {
  const custom = mapping();
  for (const payload of [{ data: { remaining: null } }, { data: { remaining: '' } }, { data: { remaining: false } }, {}]) {
    const value = await queryCustomBalance(custom, { USAGE_KEY: 'PRIVATE' }, at, { fetch: async () => response(payload) });
    expect(value).toMatchObject({ status: 'error', error_code: 'invalid_response', items: [] });
  }
  custom.items[0].remaining = 'constructor.prototype.polluted';
  expect((await queryCustomBalance(custom, { USAGE_KEY: 'PRIVATE' }, at, { fetch: async () => response({}) })).error_code).toBe('invalid_response');
});

test('identical status and lightweight requests share remote query; configuration change cannot reuse old result', async () => {
  const f = world();
  try {
    f.auth({ 'openai-codex': oauth() });
    let calls = 0, resolve;
    const barrier = new Promise(done => { resolve = done; });
    const options = { fetch: async () => { calls++; await barrier; return response(codexPayload()); } };
    const light = discoverAgentUsage(f.config, f.profile, options);
    expect(discoverAgentUsage(f.config, f.profile, options)).toBe(light);
    const full = discoverAgentStatus(f.config, f.profile, options);
    const changed = discoverAgentUsage(f.config, f.profile, { ...options, usageConfig: { providers: ['deepseek'] } });
    expect(changed).not.toBe(light); resolve();
    const [a, b, c] = await Promise.all([light, full, changed]);
    expect(calls).toBe(1); expect(a.checked_at).toBe(b.checked_at); expect(a.accounts).toBe(b.accounts); expect(a.query_id).toBe(b.query_id);
    expect(c.accounts.find(row => row.provider === 'openai-codex').balance.queried).toBe(false);
    const next = discoverAgentUsage(f.config, f.profile, options);
    expect(next).not.toBe(light); expect((await next).query_id).not.toBe(a.query_id);
  } finally { f.close(); }
});

test('multiple selected custom providers have bounded remote concurrency', async () => {
  const f = world();
  try {
    let active = 0, peak = 0, count = 0;
    const custom = Array.from({ length: 12 }, (_, index) => ({ ...mapping(), provider: `custom-${index}`, headers: {} }));
    const value = await discoverAgentUsage(f.config, f.profile, { usageConfig: { providers: custom.map(row => row.provider), custom },
      fetch: async () => { active++; peak = Math.max(peak, active); count++; await new Promise(resolve => setTimeout(resolve, 2)); active--; return response({ data: { remaining: 0 } }); } });
    expect(peak).toBeLessThanOrEqual(4); expect(count).toBe(12);
    expect(value.accounts.filter(row => row.balance.status === 'available')).toHaveLength(12);
  } finally { f.close(); }
});
