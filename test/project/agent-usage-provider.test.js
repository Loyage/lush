import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, gate } from '../helpers.js';
import { discoverAgentUsage } from '../../src/agent/status.js';

for (const changedSource of ['environment','agent.env','auth.json']) test(`in-flight usage does not hide changed ${changedSource} credentials`, async () => {
  const f = fixture(), oldResponse = gate(), started = gate(), requests = [];
  const piHome = path.join(f.config.home, 'pi'); fs.mkdirSync(piHome, { mode: 0o700 });
  f.config.env.HOME = f.root;
  f.config.env.LUSH_PI_COMMAND = path.join(f.root, 'must-not-execute-pi');
  delete f.config.env.DEEPSEEK_API_KEY;
  fs.writeFileSync(path.join(piHome, 'models.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(path.join(piHome, 'auth.json'), '{}', { mode: 0o600 });
  const updateKey = key => {
    if (changedSource === 'environment') f.config.env.USAGE_TEST_TOKEN = key;
    else if (changedSource === 'auth.json') fs.writeFileSync(path.join(piHome, 'auth.json'), JSON.stringify({ deepseek: { type: 'api_key', key } }), { mode: 0o600 });
    else f.project.configureAgentEnvironment('common', { USAGE_TEST_TOKEN: key });
  };
  updateKey('old-test-token');
  f.project.configureAgentUsage({ providers: ['deepseek'], ...(changedSource === 'auth.json' ? {} : {
    // Environment credentials are allowed only through an explicitly authorized custom HTTP mapping.
    custom: [{ provider: 'deepseek', label: 'Explicit fixture balance', url: 'https://quota.example.test/status', method: 'GET',
      headers: { Authorization: 'Bearer ${USAGE_TEST_TOKEN}' }, body: null, kind: 'balance',
      items: [{ id: 'balance-CNY', label: '账户余额', unit: 'CNY', remaining: 'balance_infos.0.total_balance', total: null, used: null }] }],
  }) });
  f.project.agentUsage.discoverUsage = (config, profile, options) => discoverAgentUsage(config, profile, { ...options, fetch: async (_url, init) => {
    const key = init.headers.Authorization; requests.push(key);
    if (key === 'Bearer old-test-token') { started.resolve(); await oldResponse.promise; }
    return new Response(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: key === 'Bearer old-test-token' ? '10' : '20' }] }));
  } });
  try {
    const old = f.project.agentUsage.query(false); await started.promise;
    updateKey('new-test-token');
    const newer = await f.project.agentUsage.query(false);
    expect(requests).toEqual(['Bearer old-test-token','Bearer new-test-token']);
    expect(newer.accounts.find(account => account.provider === 'deepseek').balance.items[0].remaining).toBe(20);
    oldResponse.resolve(); const older = await old;
    expect(older.accounts.find(account => account.provider === 'deepseek').balance.items[0].remaining).toBe(10);
    expect(older.query_id).not.toBe(newer.query_id);
    const history = f.project.agentUsageHistory({ provider: 'deepseek' });
    expect(history.series).toHaveLength(2);
    expect(history.series.flatMap(entry => entry.points.map(point => point.remaining)).sort()).toEqual([10,20]);
    expect(f.project.agentUsage.flights.size).toBe(0);
  } finally { oldResponse.resolve(); await f.close(); }
});

// Real discovery/mapping/store composition, with only HTTPS transport mocked and an isolated Pi home.
test('configured HTTP usage queries compose with lightweight discovery, history and stale success caching', async () => {
  const f = fixture(undefined, { USAGE_TEST_TOKEN: 'test-private-token' });
  const piHome = path.join(f.config.home, 'pi'); fs.mkdirSync(piHome, { mode: 0o700 });
  f.config.env.HOME = f.root;
  f.config.env.LUSH_PI_COMMAND = path.join(f.root, 'must-not-execute-pi');
  fs.writeFileSync(path.join(piHome, 'auth.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(path.join(piHome, 'models.json'), '{}', { mode: 0o600 });
  let requests = 0, fail = false;
  f.project.agentUsage.discoverUsage = (config, profile, options) => discoverAgentUsage(config, profile, { ...options, fetch: async (url, init) => {
    requests++; expect(url).toBe('https://quota.example.test/status');
    expect(init.headers.Authorization).toBe('Bearer test-private-token');
    if (fail) return new Response('secret upstream body', { status: 401 });
    return new Response(JSON.stringify({ data: { remaining: 40, limit: 100, used: 60, reset: 1800000000 } }));
  } });
  try {
    f.project.configureAgentUsage({ providers: ['custom-test'], custom: [{ provider: 'custom-test', label: 'Custom quota',
      url: 'https://quota.example.test/status', method: 'GET', headers: { Authorization: 'Bearer ${USAGE_TEST_TOKEN}' }, body: null,
      kind: 'quota', items: [{ id: 'credits', label: 'Credits', unit: 'USD', remaining: 'data.remaining', total: 'data.limit', used: 'data.used',
        reset_at: 'data.reset', window_seconds: null }] }] });
    const [first, same] = await Promise.all([f.project.agentUsage.query(false), f.project.agentUsage.query(false)]);
    expect(first.query_id).toBe(same.query_id); expect(requests).toBe(1);
    expect(first.accounts.find(account => account.provider === 'custom-test').balance.items[0].remaining).toBe(40);
    expect(f.project.agentUsageHistory({ provider: 'custom-test' }).series[0].sample_count).toBe(1);
    fail = true; const failed = await f.project.agentUsage.query(false);
    expect(failed.query_id).not.toBe(first.query_id); expect(requests).toBe(2);
    const account = failed.accounts.find(account => account.provider === 'custom-test');
    expect(account.balance.status).toBe('error'); expect(account.last_success.balance.items[0].remaining).toBe(40);
    expect(account.last_success.checked_at).toBe(first.checked_at);
    const history = f.project.agentUsageHistory({ provider: 'custom-test', days: 1 });
    expect(history.series).toHaveLength(1);
    expect(history.series[0].points.map(point => point.remaining)).toEqual([40, null]);
    expect(JSON.stringify(history)).not.toContain('test-private-token'); expect(JSON.stringify(failed)).not.toContain('secret upstream body');
  } finally { await f.close(); }
});
