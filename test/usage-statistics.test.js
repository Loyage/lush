import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { readUsageStatistics } from '../src/core/usage-statistics.js';

const message = (at, cost = 0.5, extra = {}) => ({ type: 'message', timestamp: at, message: {
  role: 'assistant', provider: 'vendor', model: 'model', content: [{ type: 'text', text: 'private text' }],
  usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 2, reasoning: 3, totalTokens: 37, ...(cost === null ? {} : { cost: { total: cost } }) }, ...extra,
} });
function sessions(config, rows, name = 'a_lush-task-999.jsonl') {
  const dir = path.join(config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name); fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); return file;
}
const range = { start: '2026-01-01T00:00:00Z', end: '2026-01-04T00:00:00Z', interval: 'day' };

test('project totals include every retained session, model changes, unknown vs zero prices, and zero-filled buckets', async () => {
  const f = fixture();
  try {
    const file = sessions(f.config, [
      message('2026-01-01T01:00:00Z'), message('2026-01-03T02:00:00Z', 0),
      message('2026-01-03T03:00:00Z', null, { provider: 'other' }),
      { type: 'model_change', provider: 'vendor', modelId: 'new-model' },
      message('2026-01-03T04:00:00Z', 0.25, { provider: undefined, model: undefined }),
      { type: 'message', message: { role: 'toolResult', content: 'not a request' } },
    ]);
    const before = fs.readFileSync(file, 'utf8');
    const result = await readUsageStatistics(f.config, range);
    expect(result.totals).toEqual({ requests: 4, input: 40, output: 20, cache_read: 80, cache_write: 8, tokens: 148, cost: 0.75, unknown_cost: 1, unknown_tokens: 0 });
    expect(result.buckets.map(b => b.cost)).toEqual([0.5, 0, 0.25]);
    expect(result.buckets.map(b => b.requests)).toEqual([1, 0, 3]);
    expect(result.models.map(m => [m.provider, m.model, m.cost])).toEqual([['vendor', 'model', 0.5], ['vendor', 'new-model', 0.25], ['other', 'model', 0]]);
    expect(result.models.reduce((sum, m) => sum + m.tokens, 0)).toBe(result.totals.tokens);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(JSON.stringify(result)).not.toContain('private text');
    expect((await readUsageStatistics(f.config)).totals).toEqual(result.totals);
  } finally { await f.close(); }
});

test('precise half-open range, offsets, message timestamps, leap days and automatic intervals', async () => {
  const f = fixture();
  try {
    sessions(f.config, [message('2026-01-01T00:00:00Z'), message('2026-01-01T01:00:00Z'),
      message(undefined, 0.2, { timestamp: Date.parse('2026-01-01T00:30:00Z') }), message('2024-02-29T12:00:00Z')]);
    const result = await readUsageStatistics(f.config, { start: '2026-01-01T08:00:00+08:00', end: '2026-01-01T09:00:00+08:00' });
    expect(result.totals.requests).toBe(2); expect(result.interval).toBe('hour'); expect(result.buckets.length).toBe(1);
    const leap = await readUsageStatistics(f.config, { start: '2024-02-01T00:00:00Z', end: '2024-03-01T00:00:00Z', interval: 'day' });
    expect(leap.buckets.length).toBe(29); expect(leap.buckets.at(-1).requests).toBe(1);
    expect((await readUsageStatistics(f.config, range)).interval).toBe('day');
    const months = await readUsageStatistics(f.config, { start: '2025-12-01T00:00:00Z', end: '2026-06-01T00:00:00Z' });
    expect(months.interval).toBe('month'); expect(months.buckets.length).toBe(6);
    expect(months.buckets[0].end).toBe('2026-01-01T00:00:00.000Z');
    expect((await readUsageStatistics(f.config, { end: '2025-01-01T00:00:00Z' })).totals.requests).toBe(1);
  } finally { await f.close(); }
});

test('undated and missing usage are explicit; malformed, incomplete and foreign files never fabricate totals', async () => {
  const f = fixture();
  try {
    const file = sessions(f.config, [message(null, null), message('2026-01-01T01:00:00Z', null, { usage: undefined })]);
    fs.appendFileSync(file, '{bad json}\n' + JSON.stringify(message('2026-01-02T00:00:00Z')));
    sessions(f.config, [message('2026-01-01T01:00:00Z', 999)], 'unrelated.jsonl');
    fs.writeFileSync(path.join(f.config.home, 'sessions', 'codex-task-1.json'), '{}');
    fs.symlinkSync(file, path.join(f.config.home, 'sessions', 'link_lush-task-1.jsonl'));
    const all = await readUsageStatistics(f.config);
    expect(all.totals).toMatchObject({ requests: 2, unknown_cost: 2, unknown_tokens: 1 });
    expect(all.coverage).toMatchObject({ undated_requests: 1, malformed_lines: 1, incomplete_files: 1, unreadable_files: 1, codex_threads: 1 });
    const selected = await readUsageStatistics(f.config, range);
    expect(selected.totals.requests).toBe(1);
    fs.appendFileSync(file, '\n');
    expect((await readUsageStatistics(f.config, range)).totals.requests).toBe(2);
  } finally { await f.close(); }
});

test('cache invalidates on append, replacement, truncation, regrowth and removal without double counting', async () => {
  const f = fixture();
  try {
    const file = sessions(f.config, [message('2026-01-01T00:00:00Z')]);
    expect((await readUsageStatistics(f.config, range)).totals.cost).toBe(0.5);
    fs.appendFileSync(file, JSON.stringify(message('2026-01-02T00:00:00Z')) + '\n');
    const concurrent = await Promise.all([readUsageStatistics(f.config, range), readUsageStatistics(f.config, range)]);
    expect(concurrent.map(r => r.totals.cost)).toEqual([1, 1]);
    fs.writeFileSync(file, JSON.stringify(message('2026-01-01T00:00:00Z', 3)) + '\n');
    expect((await readUsageStatistics(f.config, range)).totals.cost).toBe(3);
    fs.writeFileSync(file, Array(4).fill(JSON.stringify(message('2026-01-01T00:00:00Z', 2))).join('\n') + '\n');
    expect((await readUsageStatistics(f.config, range)).totals.cost).toBe(8);
    fs.renameSync(file, file + '.old');
    sessions(f.config, [message('2026-01-01T00:00:00Z', 7)]);
    expect((await readUsageStatistics(f.config, range)).totals.cost).toBe(7);
    fs.unlinkSync(file);
    expect((await readUsageStatistics(f.config, range)).totals.cost).toBe(0);
  } finally { await f.close(); }
});

test('statistics read beyond the task transcript 8 MiB window and keep scanning after oversized lines', async () => {
  const f = fixture();
  try {
    const file = sessions(f.config, [message('2026-01-01T01:00:00Z')]);
    const tool = JSON.stringify({ type: 'message', message: { role: 'toolResult', content: 'x'.repeat(1024 * 1024) } }) + '\n';
    for (let i = 0; i < 9; i++) fs.appendFileSync(file, tool);
    fs.appendFileSync(file, JSON.stringify(message('2026-01-02T00:00:00Z')) + '\n');
    expect((await readUsageStatistics(f.config, range)).totals.requests).toBe(2);
    fs.appendFileSync(file, 'x'.repeat(17 * 1024 * 1024) + '\n' + JSON.stringify(message('2026-01-03T00:00:00Z')) + '\n');
    const result = await readUsageStatistics(f.config, range);
    expect(result.totals.requests).toBe(3); expect(result.coverage.malformed_lines).toBe(1);
  } finally { await f.close(); }
});

test('empty projects and invalid queries are bounded and do not write history', async () => {
  const f = fixture();
  try {
    expect((await readUsageStatistics(f.config)).totals.requests).toBe(0);
    expect((await readUsageStatistics(f.config, range)).buckets.length).toBe(3);
    for (const options of [
      { start: 'yesterday' }, { start: '2026-02-30T00:00:00Z' }, { start: '2026-01-01T00:00:00' }, { start: 123 },
      { ...range, end: range.start }, { interval: 'week' }, { ...range, end: '2027-01-01T00:00:00Z', interval: 'hour' },
    ]) await expect(readUsageStatistics(f.config, options)).rejects.toThrow();
    expect(fs.existsSync(path.join(f.config.home, 'sessions'))).toBe(false);
  } finally { await f.close(); }
});
