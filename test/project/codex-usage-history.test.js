import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/persistence/store.js';
import { temp } from '../helpers.js';

const at = '2026-01-01T00:00:00.000Z';
const observe = (query_key, extra = {}) => ({ query_key, provider: 'openai-codex', account_key: 'account', source_key: 'a'.repeat(64),
  at, status: 'available', kind: 'quota', error_code: null, items: [{ id: 'primary', label: '5 小时', unit: '%',
    remaining: 99.5, used: 0.5, total: 100, used_percent: 0.5, window_seconds: 18000, reset_at: null }], ...extra });
const history = store => store.readAgentUsageHistory({ from: at, to: at, retention_days: 90 });

test('quota history adds nullable percent metadata without rewriting old observations', () => {
  const root = temp(), file = path.join(root,'test.db'); let store = new Store(file, root);
  try {
    store.recordAgentUsage(observe('old', { items: [{ id: 'primary', label: '5 小时', unit: '%', remaining: 99.5,
      total: 100, used: 0.5, window_seconds: 18000 }] }));
    const before = store.get("SELECT payload FROM agent_usage_queries WHERE query_key='old'").payload;
    // Emulate the previous database version, then reopen through the additive migration.
    store.run('ALTER TABLE agent_usage_points DROP COLUMN used_percent'); store.close();
    store = new Store(file, root);
    expect(history(store).series[0].points[0].used_percent).toBeNull();
    expect(store.get("SELECT payload FROM agent_usage_queries WHERE query_key='old'").payload).toBe(before);
    store.recordAgentUsage(observe('new'));
    expect(history(store).series[0].points.map(point => point.used_percent)).toEqual([null,0.5]);
    expect(store.lastAgentUsageSuccess('openai-codex','account','a'.repeat(64)).balance.items[0].used_percent).toBe(0.5);
  } finally { store.close(); fs.rmSync(root,{recursive:true,force:true}); }
});

test('quota failures keep safe auth, rate-limit and timeout classifications but erase all numerical values', () => {
  const root=temp(), store=new Store(path.join(root,'test.db'),root);
  try {
    for(const code of ['rate_limited','timeout','auth_locked','auth_changed','refresh_failed','unauthorized']) {
      store.recordAgentUsage(observe(code,{status:'error',error_code:code}));
    }
    const points=history(store).series[0].points;
    expect(points).toHaveLength(6);
    expect(points.every(point=>point.remaining===null && point.used_percent===null)).toBe(true);
    expect(points.map(point=>point.error_code)).toEqual(['rate_limited','timeout','auth_locked','auth_changed','refresh_failed','unauthorized']);
    expect(store.lastAgentUsageSuccess('openai-codex','account','a'.repeat(64))).toBeNull();
  } finally {store.close();fs.rmSync(root,{recursive:true,force:true});}
});
