import { test, expect } from 'bun:test';
import { AgentUsageService, usageSourceKey } from '../../src/core/agent-usage.js';
import { normalizeUsageConfig } from '../../src/agent/usage-settings.js';
import { fixture, gate } from '../helpers.js';

const NOW = Date.parse('2026-01-10T12:00:00.000Z');
const iso = delta => new Date(NOW + delta).toISOString();
const source = usageSourceKey(normalizeUsageConfig({}), 'openai-codex');
const item = (remaining = 70, options = {}) => ({ id: 'primary', label: '5h quota', unit: '%', remaining, total: 100, used: 100 - remaining,
  reset_at: iso(3600000), window_seconds: 18000, ...options });
const observation = (options = {}) => ({ query_key: 'query-one', provider: 'openai-codex', account_key: 'account_one', source_key: source,
  at: iso(-60000), status: 'available', error_code: null, kind: 'quota', items: [item()], ...options });
const output = (options = {}) => ({ checked_at: iso(-60000), current_provider: 'openai-codex', accounts: [{ provider: 'openai-codex', account_key: 'account_one',
  balance: { status: 'available', kind: 'quota', items: [item()], checked_at: iso(-60000), queried: true, error_code: null, ...options } }], warnings: [] });
const history = (f, overrides = {}) => f.store.readAgentUsageHistory({ from: iso(-86400000), to: iso(0), retention_days: 90, ...overrides });

function service(f, options = {}) {
  const usage = new AgentUsageService(f.project, { now: () => NOW, ...options });
  f.project.agentUsage = usage; return usage;
}
// Unit stubs model Provider-owned single-flight; the service must call discovery for each caller.
function providerFlight(run) {
  let pending;
  return (...args) => {
    if (!pending) pending = Promise.resolve(run(...args)).finally(() => { pending = null; });
    return pending;
  };
}
function timers() {
  let id = 0; const waiting = new Map();
  return { waiting, setTimeout(fn, ms) { const key = ++id; waiting.set(key, { fn, ms }); return key; }, clearTimeout(key) { waiting.delete(key); },
    fire() { const [key, task] = waiting.entries().next().value; waiting.delete(key); return task.fn(); } };
}

test('usage persistence retains zero/null, failures and resets; projects/accounts/sources never mix', async () => {
  const f = fixture();
  try {
    expect(f.store.recordAgentUsage(observation())).toBe(true);
    expect(f.store.recordAgentUsage(observation())).toBe(false);
    f.store.recordAgentUsage(observation({ query_key: 'failure', at: iso(-40000), status: 'error', error_code: 'network', items: [] }));
    f.store.recordAgentUsage(observation({ query_key: 'reset', at: iso(-20000), items: [item(100, { reset_at: iso(7200000) })] }));
    f.store.recordAgentUsage(observation({ query_key: 'zero', at: iso(-10000), items: [item(0, { used: null, total: null })] }));
    f.store.recordAgentUsage(observation({ query_key: 'other-account', account_key: 'account_two' }));
    f.store.recordAgentUsage(observation({ query_key: 'other-source', source_key: 'a'.repeat(64) }));
    const result = history(f); expect(result.series).toHaveLength(3);
    const series = result.series.find(entry => entry.points.length === 4);
    expect(series.points.map(point => point.remaining)).toEqual([70, null, 100, 0]);
    expect(series.points[1].error_code).toBe('network'); expect(series.points[2].reset_at).toBe(iso(7200000));
    expect(series.points[3].total).toBeNull(); expect(series.points[3].used).toBeNull();
    expect(f.store.lastAgentUsageSuccess('openai-codex','account_one',source).checked_at).toBe(iso(-10000));
    expect(f.store.lastAgentUsageSuccess('openai-codex','absent',source)).toBeNull();
    expect(history(f, { account_key: 'account_two' }).series).toHaveLength(1);
    expect(history(f, { provider: 'other' }).series).toHaveLength(0);
  } finally { await f.close(); }
});

test('failed first query is retained; storage projects safe fields and retention cascades only technical rows', async () => {
  const f = fixture();
  try {
    f.store.recordAgentUsage(observation({ status: 'error', error_code: 'secret-error-body', items: [], upstream: 'SECRET',
      query_key: 'failure', at: iso(-2 * 86400000) }));
    f.store.recordAgentUsage(observation({ query_key: 'safe', items: [item(null, { token: 'SECRET', remaining: Infinity })] }));
    const result = history(f, { from: iso(-3 * 86400000) });
    expect(JSON.stringify(result)).not.toContain('SECRET'); expect(JSON.stringify(result)).not.toContain('secret-error-body');
    expect(result.series.some(entry => entry.points.some(point => point.error_code === 'unknown'))).toBe(true);
    const payload = f.store.get("SELECT payload FROM agent_usage_queries WHERE query_key='safe'").payload;
    expect(payload).not.toContain('token'); expect(payload).not.toContain('SECRET');
    expect(f.store.pruneAgentUsage(iso(-86400000))).toBe(1);
    expect(f.store.get('SELECT COUNT(*) AS n FROM agent_usage_queries').n).toBe(1);
    expect(f.store.get('SELECT COUNT(*) AS n FROM tasks').n).toBe(0);
  } finally { await f.close(); }
});

test('history is bounded and samples the whole range without hiding representative failures', async () => {
  const f = fixture();
  try {
    f.store.transaction(() => {
      for (let n = 0; n < 550; n++) f.store.recordAgentUsage(observation({ query_key: `q${n}`, at: iso(-550000 + n * 1000),
        ...(n === 500 ? { status: 'error', error_code: 'timeout', items: [] } : { items: [item(n % 100)] }) }));
    });
    const result = history(f), s = result.series[0];
    expect(result.truncated).toBe(true); expect(s.sample_count).toBe(550); expect(s.points.length).toBeLessThanOrEqual(500);
    expect(s.points[0].at).toBe(iso(-550000)); expect(s.points.at(-1).at).toBe(iso(-1000));
    expect(s.points.some(point => point.status === 'error')).toBe(true);
    for (let n = 1; n < s.points.length; n++) expect(Date.parse(s.points[n].at)).toBeGreaterThan(Date.parse(s.points[n - 1].at));
    f.store.transaction(() => {
      for (let n = 0; n < 45; n++) f.store.recordAgentUsage(observation({ query_key: `a${n}`, account_key: `account_${n}` }));
    });
    const large = history(f); expect(large.series).toHaveLength(40); expect(large.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(750000);
  } finally { await f.close(); }
});

test('7/30/90-day selection preserves the full span, extrema, representative failures and resets', async () => {
  const f = fixture(), hour = 3600000;
  try {
    f.store.transaction(() => {
      for (let n = 0; n < 1800; n++) f.store.recordAgentUsage(observation({ query_key: `hour-${n}`, at: iso((n - 1800) * hour),
        ...(n === 400 ? { status: 'error', error_code: 'network', items: [] } : { items: [item(n === 340 ? -100 : n === 1390 ? 200 : n % 99,
          { reset_at: n < 401 ? iso(hour) : n < 1200 ? iso(2 * hour) : iso(3 * hour) })] }) }));
    });
    for (const days of [7,30,90]) {
      const result = history(f, { from: iso(-days * 24 * hour) }), entry = result.series[0];
      expect(entry.sample_count).toBe(Math.min(days * 24, 1800));
      expect(entry.points[0].at).toBe(iso(-Math.min(days * 24,1800) * hour));
      expect(entry.points.at(-1).at).toBe(iso(-hour)); expect(entry.points.length).toBeLessThanOrEqual(500);
      expect(result.truncated).toBe(entry.sample_count > entry.points.length);
    }
    const all = history(f, { from: iso(-90 * 24 * hour) }).series[0].points;
    expect(all.some(point => point.remaining === -100)).toBe(true);
    expect(all.some(point => point.remaining === 200)).toBe(true);
    expect(all.some(point => point.at === iso((400 - 1800) * hour) && point.status === 'error')).toBe(true);
    expect(all.some(point => point.at === iso((401 - 1800) * hour) && point.reset_at === iso(2 * hour))).toBe(true);
    expect(all.some(point => point.at === iso((1200 - 1800) * hour) && point.reset_at === iso(3 * hour))).toBe(true);
  } finally { await f.close(); }
});

test('multi-series history stays below the RPC frame budget with a visible truncation flag', async () => {
  const f = fixture();
  try {
    const items = Array.from({ length: 10 }, (_, n) => item(50, { id: `metric-${n}`, label: '额度曲线'.repeat(25) }));
    f.store.transaction(() => {
      for (let account = 0; account < 4; account++) for (let n = 0; n < 501; n++)
        f.store.recordAgentUsage(observation({ query_key: `${account}-${n}`, account_key: `account_${account}`, items, at: iso(-501000 + n * 1000) }));
    });
    const result = history(f); expect(result.series).toHaveLength(40); expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(750000);
    for (const entry of result.series) {
      expect(entry.sample_count).toBe(501); expect(entry.points.length).toBeLessThan(500);
      expect(entry.points[0].at).toBe(iso(-501000)); expect(entry.points.at(-1).at).toBe(iso(-1000));
      for (let n = 1; n < entry.points.length; n++) expect(Date.parse(entry.points[n].at)).toBeGreaterThan(Date.parse(entry.points[n - 1].at));
    }
  } finally { await f.close(); }
});

test('single-flight status persists each observation once and exposes previous successful cache only with its old time', async () => {
  const f = fixture(), blocked = gate(); let calls = 0;
  const usage = service(f, { discoverStatus: providerFlight(async (_config, _profile, options) => {
    calls++; expect(options.usageConfig.retention_days).toBe(90); await blocked.promise; return output();
  }) });
  try {
    const a = f.project.agentStatus(), b = f.project.agentStatus(); expect(a).not.toBe(b); expect(calls).toBe(1);
    expect(usage.flights.size).toBe(2);
    blocked.resolve(); const [value] = await Promise.all([a,b]); expect(usage.flights.size).toBe(0);
    expect(value.usage_config.enabled).toBe(false); expect(f.store.get('SELECT COUNT(*) AS n FROM agent_usage_queries').n).toBe(1);
    usage.discoverStatus = async () => output({ status: 'error', items: [], checked_at: iso(-1000), error_code: 'network' });
    const failed = await usage.query(); expect(failed.accounts[0].balance.status).toBe('error');
    expect(failed.accounts[0].last_success.checked_at).toBe(iso(-60000));
    expect(failed.accounts[0].last_success.balance.items[0].remaining).toBe(70);
    expect(usage.history({ days: 1 }).series[0].points.map(point => point.status)).toEqual(['available','error']);
    expect(() => usage.history({ days: 2 })).toThrow(); expect(() => usage.history({ provider: 'invalid/' })).toThrow();
    expect(() => usage.history({ account_key: 'invalid/' })).toThrow();
  } finally { blocked.resolve(); await f.close(); }
});

test('last-success cache is whitelisted, budgeted in UTF-8 and never replaces current failures', async () => {
  const f = fixture();
  const largeItems = Array.from({ length: 10 }, (_, n) => item(70, { id: `metric-${n}`, label: '历史额度'.repeat(30), unit: '单位'.repeat(12), token: 'SECRET' }));
  const accounts = Array.from({ length: 20 }, (_, n) => ({ provider: `provider_${n}`, account_key: `account_${n}`,
    balance: { status: 'error', kind: null, items: [], checked_at: iso(-1000), queried: true, error_code: 'network' } }));
  const usage = service(f, { discoverStatus: async () => ({ checked_at: iso(-1000), accounts, warnings: [] }) });
  try {
    for (const account of accounts) f.store.recordAgentUsage(observation({ query_key: account.account_key, provider: account.provider,
      account_key: account.account_key, source_key: usageSourceKey(normalizeUsageConfig({}), account.provider), items: largeItems }));
    const result = await usage.query();
    const included = result.accounts.filter(account => account.last_success);
    expect(included.length).toBeGreaterThan(0); expect(included.length).toBeLessThan(20);
    expect(included.reduce((sum, account) => sum + Buffer.byteLength(JSON.stringify(account.last_success)), 0)).toBeLessThanOrEqual(65536);
    expect(result.accounts.every(account => account.balance.status === 'error')).toBe(true);
    expect(result.accounts.some(account => account.last_success_truncated)).toBe(true);
    expect(result.warnings.join('')).toContain('历史成功缓存');
    expect(JSON.stringify(included.map(account => account.last_success))).not.toContain('SECRET');
    expect(included.every(account => account.last_success.checked_at === iso(-60000))).toBe(true);
  } finally { await f.close(); }
});

test('lightweight/full shared query IDs deduplicate and unqueried accounts do not manufacture history', async () => {
  const f = fixture();
  const result = output({ query_id: 'shared-query' });
  result.accounts.push({ provider: 'deepseek', account_key: 'saved_other', balance: { queried: false, status: 'unsupported' } });
  const usage = service(f, { discoverStatus: async () => result, discoverUsage: async () => result });
  try {
    await Promise.all([usage.query(true), usage.query(false)]);
    expect(f.store.get('SELECT COUNT(*) AS n FROM agent_usage_queries').n).toBe(1);
    expect(history(f).series).toHaveLength(1);
    result.accounts[0].balance.query_id = 'new-real-query-same-millisecond'; await usage.query(false);
    expect(f.store.get('SELECT COUNT(*) AS n FROM agent_usage_queries').n).toBe(2);
  } finally { await f.close(); }
});

test('background sampling is opt-in, lightweight, single-flight and disabled mid-flight without rescheduling', async () => {
  const f = fixture(), clock = timers(), blocked = gate(); let light = 0, full = 0;
  const usage = service(f, { ...clock, discoverUsage: providerFlight(async () => { light++; await blocked.promise; return output(); }),
    discoverStatus: async () => { full++; return output(); } });
  try {
    usage.start(); expect(clock.waiting.size).toBe(0);
    usage.configure({ enabled: true }); expect(clock.waiting.size).toBe(1); expect([...clock.waiting.values()][0].ms).toBe(300000);
    const tick = clock.fire(); expect(light).toBe(1); expect(full).toBe(0); expect(clock.waiting.size).toBe(0);
    const shared = usage.query(false); expect(light).toBe(1);
    usage.configure({ enabled: false }); blocked.resolve(); await tick; await shared;
    expect(clock.waiting.size).toBe(0); expect(history(f).series[0].sample_count).toBe(1);
    usage.configure({ enabled: true, interval_minutes: 10 }); expect([...clock.waiting.values()][0].ms).toBe(600000);
    await usage.stop(); expect(clock.waiting.size).toBe(0); expect(() => usage.query()).toThrow('stopping');
  } finally { blocked.resolve(); await f.close(); }
});

test('shutdown waits in-flight persistence; restart schedules future sampling without replay', async () => {
  const f = fixture(), clock = timers(), blocked = gate(); let calls = 0;
  const usage = service(f, { ...clock, discoverUsage: async () => { calls++; await blocked.promise; return output(); } });
  try {
    usage.configure({ enabled: true }); const tick = clock.fire();
    let stopped = false; const done = f.project.shutdown().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false); expect(clock.waiting.size).toBe(0);
    blocked.resolve(); await tick; await done; expect(stopped).toBe(true); expect(history(f).series).toHaveLength(1);
    f.project.stopping = false;
    const restarted = service(f, { ...clock, discoverUsage: async () => { calls++; return output(); } });
    restarted.start(); expect(clock.waiting.size).toBe(1); expect(calls).toBe(1);
  } finally { blocked.resolve(); await f.close(); }
});

test('failed background requests reschedule safely and stop/config errors do not rewrite settings', async () => {
  const f = fixture(), clock = timers();
  const usage = service(f, { ...clock, discoverUsage: async () => { throw new Error('SECRET upstream failure'); } });
  try {
    usage.configure({ enabled: true }); await clock.fire();
    expect(clock.waiting.size).toBe(1); expect(usage.warning).not.toContain('SECRET');
    expect(history(f).series).toEqual([]);
    await usage.stop(); expect(clock.waiting.size).toBe(0);
  } finally { await f.close(); }
});

test('custom first failures use configured metric metadata and source edits split history', async () => {
  const f = fixture();
  const custom = { provider: 'openai-codex', label: 'Quota', url: 'https://quota.example.test/', method: 'GET', headers: {}, body: null,
    kind: 'quota', items: [{ id: 'primary', label: '5h quota', unit: '%', remaining: 'remaining', window_seconds: 18000 }] };
  const usage = service(f, { discoverStatus: async () => output({ status: 'error', items: [], kind: null, error_code: 'network' }) });
  try {
    usage.configure({ custom: [custom] }); await usage.query();
    expect(history(f).series[0].label).toBe('5h quota');
    usage.discoverStatus = async () => output({ checked_at: iso(-1000) }); await usage.query();
    expect(history(f).series).toHaveLength(1); expect(history(f).series[0].points.map(point => point.remaining)).toEqual([null,70]);
    usage.configure({ custom: [{ ...custom, url: 'https://other.example.test/' }] }); await usage.query();
    expect(history(f).series).toHaveLength(2);
  } finally { await f.close(); }
});

test('config changes keep old in-flight source separate; schedule and retention edits do not split series', async () => {
  const f = fixture(), blocked = gate(); let calls = 0;
  const usage = service(f, { discoverStatus: async () => { calls++; await blocked.promise; return output(); } });
  try {
    const old = usage.query(); usage.configure({ providers: ['deepseek'] }); const changed = usage.query(); expect(calls).toBe(2);
    blocked.resolve(); const [a,b] = await Promise.all([old,changed]);
    expect(a.usage_config.providers).toEqual([]); expect(b.usage_config.providers).toEqual(['deepseek']);
    expect(usageSourceKey(normalizeUsageConfig({}), 'deepseek')).toBe(usageSourceKey(normalizeUsageConfig({ retention_days: 10, interval_minutes: 30 }), 'deepseek'));
  } finally { blocked.resolve(); await f.close(); }
});
