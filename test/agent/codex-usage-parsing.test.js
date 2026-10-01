import { test, expect } from 'bun:test';
import { queryAccountBalance } from '../../src/agent/usage-query.js';

const at = '2026-01-01T00:00:00.000Z';
const query = (data, options = {}) => queryAccountBalance('openai-codex', 'MOCK_PRIVATE_ACCESS', at,
  { fetch: async () => new Response(JSON.stringify(data)), ...options });

test('Codex exposes percent utilization and actual window duration without inventing absolute quota', async () => {
  const result = await query({ rate_limit: {
    primary_window: { used_percent: 0.5, limit_window_seconds: 18000, reset_after_seconds: 120 },
    secondary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 1768000000 },
  }, total_tokens: 1000000, local_usage: 99 });
  expect(result.items[0]).toMatchObject({ used_percent: 0.5, used: 0.5, remaining: 99.5, total: 100,
    unit: '%', window_seconds: 18000, reset_at: '2026-01-01T00:02:00.000Z' });
  expect(result.items[0].label).toContain('5 小时');
  expect(result.items[1]).toMatchObject({ used_percent: 100, remaining: 0, window_seconds: 604800 });
  expect(result.items[1].label).toContain('7 天（周）');
  expect(result.reason).toContain('不是实际 token');
  expect(JSON.stringify(result)).not.toContain('1000000');
  expect(JSON.stringify(result)).not.toContain('MOCK_PRIVATE_ACCESS');
});

test('Codex missing percentages, invalid numeric shapes and missing durations remain unknown', async () => {
  const result = await query({ rate_limit: { primary_window: { used_percent: 0 }, secondary_window: { reset_after_seconds: 3600 } } });
  expect(result.items[0]).toMatchObject({ used_percent: 0, remaining: 100, window_seconds: null });
  expect(result.items[0].label).not.toContain('每日');
  expect(result.items[1]).toMatchObject({ used_percent: null, remaining: null, total: null, used: null,
    window_seconds: null, reset_at: '2026-01-01T01:00:00.000Z' });
  for (const value of [null, '', false, NaN, 101, -1, {}, []]) {
    const response = await query({ rate_limit: { primary_window: { used_percent: value } } });
    expect(response).toMatchObject({ status: 'error', error_code: 'invalid_response', items: [] });
  }
});

test('Codex HTTP errors are classified independently, safely and never retried', async () => {
  for (const [status, code] of [[401,'unauthorized'],[403,'unauthorized'],[429,'rate_limited'],[500,'network']]) {
    let calls = 0;
    const result = await query(null, { fetch: async () => { calls++; return new Response('SECRET_UPSTREAM_TOKEN', { status }); } });
    expect(calls).toBe(1); expect(result).toMatchObject({ status: 'error', error_code: code, items: [], queried: true });
    expect(JSON.stringify(result)).not.toContain('SECRET_UPSTREAM_TOKEN');
    if (status === 429) expect(result.reason).toContain('未自动重试');
  }
});

test('Codex deadline includes body reads and format changes do not become empty successful quota', async () => {
  let aborted = false;
  const timeout = await query(null, { timeout: 5, fetch: async (_, init) => {
    init.signal.addEventListener('abort', () => { aborted = true; });
    return new Response(new ReadableStream({ start() {} }));
  } });
  expect(timeout).toMatchObject({ status: 'error', error_code: 'timeout', items: [] });
  expect(aborted).toBe(true);
  for (const fetch of [async () => new Response('not JSON'), async () => new Response('x'.repeat(65537)),
    async () => new Response(JSON.stringify({ rate_limit: { different_schema: { utilization: 10 } } }))]) {
    expect((await query(null, { fetch })).error_code).toBe('invalid_response');
  }
});
