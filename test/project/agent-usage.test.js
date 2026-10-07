import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { AgentUsageService, usageSourceKey } from '../../src/core/agent-usage.js';
import { normalizeUsageConfig, UsageSettings } from '../../src/agent/usage-settings.js';
import { fixture } from '../helpers.js';

const NOW = Date.parse('2026-01-10T12:00:00.000Z');
const iso = delta => new Date(NOW + delta).toISOString();
const source = usageSourceKey(normalizeUsageConfig({}), 'openai-codex');
const item = (remaining = 70, options = {}) => ({ id: 'primary', label: '5h quota', unit: '%', remaining, total: 100, used: 100 - remaining,
  reset_at: iso(3600000), window_seconds: 18000, ...options });
const observation = (options = {}) => ({ query_key: 'query-one', provider: 'openai-codex', account_key: 'account_one', source_key: source,
  at: iso(-60000), status: 'available', error_code: null, kind: 'quota', items: [item()], ...options });
const history = (f, overrides = {}) => f.store.readAgentUsageHistory({ from: iso(-86400000), to: iso(0), retention_days: 90, ...overrides });

function service(f, options = {}) {
  const usage = new AgentUsageService(f.project, { now: () => NOW, ...options });
  f.project.agentUsage = usage; return usage;
}

test('usage persistence retains zero/null, failures and resets; projects/accounts/sources never mix', async () => {
  const f = fixture();
  try {
    expect(f.store.recordAgentUsage(observation())).toBe(true); expect(f.store.recordAgentUsage(observation())).toBe(false);
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

test('store safe projections and explicit technical pruning remain available without service auto-pruning', async () => {
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

test('history preserves complete 7/30/90-day spans, extrema, representative failures and resets with bounded downsampling', async () => {
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
      for (let n = 1; n < entry.points.length; n++) expect(Date.parse(entry.points[n].at)).toBeGreaterThan(Date.parse(entry.points[n - 1].at));
    }
    const all = history(f, { from: iso(-90 * 24 * hour) }).series[0].points;
    expect(all.some(point => point.remaining === -100)).toBe(true); expect(all.some(point => point.remaining === 200)).toBe(true);
    expect(all.some(point => point.at === iso((400 - 1800) * hour) && point.status === 'error')).toBe(true);
    expect(all.some(point => point.at === iso((401 - 1800) * hour) && point.reset_at === iso(2 * hour))).toBe(true);
    expect(all.some(point => point.at === iso((1200 - 1800) * hour))).toBe(true);
  } finally { await f.close(); }
});

test('multi-series UTF-8 history stays below RPC frame budget, limits series and visibly truncates', async () => {
  const f = fixture();
  try {
    const items = Array.from({ length: 10 }, (_, n) => item(50, { id: `metric-${n}`, label: '额度曲线'.repeat(25) }));
    f.store.transaction(() => {
      for (let account = 0; account < 5; account++) for (let n = 0; n < 501; n++)
        f.store.recordAgentUsage(observation({ query_key: `${account}-${n}`, account_key: `account_${account}`, items, at: iso(-501000 + n * 1000) }));
    });
    const result = history(f); expect(result.series).toHaveLength(40); expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(750000);
    for (const entry of result.series) {
      expect(entry.sample_count).toBe(501); expect(entry.points.length).toBeLessThan(500);
      expect(entry.points[0].at).toBe(iso(-501000)); expect(entry.points.at(-1).at).toBe(iso(-1000));
    }
  } finally { await f.close(); }
});

test('legacy enabled=true survives restart unchanged but never schedules, discovers, prunes or rewrites', async () => {
  const f = fixture();
  try {
    new UsageSettings(f.config).save({ enabled: true, interval_minutes: 1, retention_days: 1, providers: ['openai-codex'] });
    const file = path.join(f.config.home, 'agent-usage.json'), before = fs.readFileSync(file, 'utf8'), stat = fs.statSync(file);
    f.store.recordAgentUsage(observation({ at: iso(-50 * 86400000) }));
    const fail = () => { throw new Error('retired path executed'); };
    const usage = service(f, { setTimeout: fail, discoverUsage: fail, discoverStatus: fail });
    f.store.pruneAgentUsage = fail; f.project.agentSettings.resolve = fail;
    for (let n = 0; n < 2; n++) {
      usage.start(); await usage.stop();
      const restarted = service(f, { setTimeout: fail, discoverUsage: fail }); restarted.start(); await restarted.stop();
    }
    expect(f.project.agentUsageConfig().enabled).toBe(true);
    expect(f.store.get('SELECT COUNT(*) AS n FROM agent_usage_queries').n).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(before); expect(fs.statSync(file).mtimeMs).toBe(stat.mtimeMs);
    expect(fs.statSync(file).ino).toBe(stat.ino);
  } finally { await f.close(); }
});

test('legacy query/configure reject as retired before discovery, project write admission or setting writes', async () => {
  const f = fixture();
  try {
    const usage = service(f), fail = () => { throw new Error('not retired'); };
    usage.settings.get = fail; usage.settings.save = fail; f.project.assertWritable = fail; f.project.write = fail;
    expect(() => usage.query(true)).toThrow('retired'); expect(() => usage.query(false)).toThrow('retired');
    expect(() => usage.configure({ enabled: true })).toThrow('retired');
    expect(() => f.project.configureAgentUsage({})).toThrow('retired');
  } finally { await f.close(); }
});

test('archived history is read-only and not clipped/deleted by old retention; damaged config does not hide it', async () => {
  const f = fixture();
  try {
    new UsageSettings(f.config).save({ enabled: true, retention_days: 1 });
    const usage = service(f); f.store.recordAgentUsage(observation({ at: iso(-50 * 86400000) }));
    const rows = () => [f.store.all('SELECT * FROM agent_usage_queries'), f.store.all('SELECT * FROM agent_usage_points')];
    const before = rows(); f.store.pruneAgentUsage = () => { throw new Error('must not prune'); };
    const result = usage.history({ days: 90 }); expect(result.retention_days).toBe(1);
    expect(result.from).toBe(iso(-90 * 86400000)); expect(result.series[0].points[0].remaining).toBe(70);
    expect(usage.history({ days: 7 }).series).toEqual([]); expect(rows()).toEqual(before);
    const file = path.join(f.config.home, 'agent-usage.json'); fs.writeFileSync(file, '{broken-secret');
    expect(usage.history({ days: 90 }).series).toHaveLength(1); expect(rows()).toEqual(before);
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken-secret');
    expect(() => usage.history({ days: 2 })).toThrow(); expect(() => usage.history({ provider: 'invalid/' })).toThrow();
    expect(() => usage.history({ account_key: 'invalid/' })).toThrow();
  } finally { await f.close(); }
});
