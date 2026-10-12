import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, fixture } from './helpers.js';
import { RuntimeDiagnostics } from '../src/core/runtime-diagnostics.js';
import { assertAllowed } from '../src/rpc/registry.js';
import { handlers } from '../src/rpc/handlers/system.js';

const usage = (at, input = 10, extra = {}) => ({ type: 'message', timestamp: new Date(at).toISOString(),
  message: { role: 'assistant', usage: { input, output: 5, cacheRead: 2, cacheWrite: 3, reasoning: 100, cost: { total: 0.1 } }, ...extra } });
function setup(options = {}) {
  const root = temp(), dir = path.join(root, 'sessions'); fs.mkdirSync(dir);
  let now = Date.now();
  const file = path.join(dir, '2026_lush-task-2.jsonl');
  const reader = new RuntimeDiagnostics({ home: root }, { now: () => now, throttleMs: 0, ...options });
  return { root, dir, file, reader, get now() { return now; }, set now(n) { now = n; },
    write(records) { fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n'); },
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

test('diagnostics uses actual window boundaries, cached input, UTC buckets and idle zero', async () => {
  const f = setup();
  try {
    f.write([usage(f.now - 300_001, 1000), usage(f.now - 300_000, 100), usage(f.now - 60_001, 20), usage(f.now - 60_000, 30), usage(f.now, 40)]);
    const r = await f.reader.read();
    expect(r.windows[0]).toMatchObject({ seconds: 60, input: 80, output: 10, requests: 2, input_per_second: 80 / 60, cost_per_minute: 0.2, complete: true });
    expect(r.windows[1]).toMatchObject({ seconds: 300, input: 210, requests: 4, complete: true });
    expect(r.buckets).toHaveLength(60);
    expect(Date.parse(r.buckets[59].at) % 10_000).toBe(0);
    f.now += 601_000;
    const idle = await f.reader.read();
    expect(idle.windows.every(w => w.input === 0 && w.cost === 0 && w.complete)).toBe(true);
    expect(idle.buckets.every(b => b.output === 0)).toBe(true);
  } finally { f.close(); }
});

test('diagnostics singleflight/throttle caches snapshots and only consumes appended complete lines', async () => {
  const f = setup({ throttleMs: 2000 });
  try {
    f.write([usage(f.now)]);
    const [a, b] = await Promise.all([f.reader.read(), f.reader.read()]); expect(a).toEqual(b);
    b.windows[0].input = -1; expect((await f.reader.read()).windows[0].input).toBe(15);
    fs.appendFileSync(f.file, JSON.stringify(usage(f.now, 50)));
    expect((await f.reader.read()).windows[0].requests).toBe(1);
    f.now += 2001;
    const partial = await f.reader.read();
    expect(partial.windows[0].requests).toBe(1); expect(partial.coverage.partial_files).toBe(1); expect(partial.coverage.complete).toBe(false);
    fs.appendFileSync(f.file, '\n'); f.now += 2001;
    const appended = await f.reader.read(); expect(appended.windows[0].requests).toBe(2); expect(appended.windows[0].input).toBe(70);
    expect(appended.coverage.complete).toBe(true);
    expect(appended.coverage.bytes_read).toBeLessThan(1024);
    appended.windows[0].input = -1; expect((await f.reader.read()).windows[0].input).toBe(70);
  } finally { f.close(); }
});

test('missing usage/cost/time and malformed lines never become complete zero; explicit fork context is excluded', async () => {
  const f = setup();
  try {
    f.write([{ type: 'custom', customType: 'lush.invocation', data: { task_id: 1, run_id: 1 } }, usage(f.now, 1000),
      { type: 'custom', customType: 'lush.invocation', data: { task_id: 2, run_id: 2 } },
      usage(f.now, 20, { usage: { input: 20, output: 2 } }), usage(f.now, 0, { usage: null }),
      { type: 'message', message: { role: 'assistant', usage: { input: 90, output: 1 } } },
      { ...usage(f.now, 1000), lush: { task_id: 1 } }]);
    fs.appendFileSync(f.file, 'invalid\n');
    const r = await f.reader.read();
    expect(r.windows[0]).toMatchObject({ input: 20, output: 2, requests: 2, unknown_cost: 4, unknown_tokens: 3, complete: false });
    expect(r.coverage).toMatchObject({ complete: false, undated_requests: 1, malformed_lines: 1 });
  } finally { f.close(); }
});

test('truncate, same-inode rewrite, atomic replacement and deletion invalidate previous expenditure', async () => {
  const f = setup();
  try {
    f.write([usage(f.now, 10)]); await f.reader.read();
    f.write([usage(f.now, 20)]); expect((await f.reader.read()).windows[0].input).toBe(25);
    f.write([]); expect((await f.reader.read()).windows[0].input).toBe(0);
    const replacement = path.join(f.dir, 'replacement'); fs.writeFileSync(replacement, JSON.stringify(usage(f.now, 30)) + '\n');
    fs.renameSync(replacement, f.file); expect((await f.reader.read()).windows[0].input).toBe(35);
    fs.unlinkSync(f.file); expect((await f.reader.read()).windows[0].requests).toBe(0);
    expect(f.reader.files.size).toBe(0);
  } finally { f.close(); }
});

test('large files, budgets, row limits and symlinks are bounded and explicitly incomplete', async () => {
  const f = setup({ maxBytes: 4096, fileBytes: 1024, maxRows: 2 });
  try {
    f.write(Array.from({ length: 100 }, () => usage(f.now)));
    const r = await f.reader.read(); expect(r.coverage.bytes_read).toBeLessThanOrEqual(4096);
    expect(r.coverage.truncated_files).toBe(1); expect(r.coverage.complete).toBe(false);
    fs.symlinkSync(f.file, path.join(f.dir, 'alias_lush-task-3.jsonl'));
    expect((await f.reader.read()).coverage.unreadable_files).toBe(1);
    f.reader.maxEntries = 1; expect((await f.reader.read()).coverage.budget_exhausted).toBe(true);
  } finally { f.close(); }
});

test('row cache is bounded across files, with incomplete counts rather than silent dropped requests', async () => {
  const f = setup({ maxRows: 2 });
  try {
    f.write([usage(f.now), usage(f.now)]);
    fs.copyFileSync(f.file, path.join(f.dir, 'second_lush-task-3.jsonl'));
    const r = await f.reader.read();
    expect(r.windows[0].requests).toBe(2); expect(r.coverage.budget_exhausted).toBe(true);
    expect(r.windows[0].unknown_tokens).toBeGreaterThan(0);
    expect([...f.reader.files.values()].reduce((n, state) => n + state.rows.length, 0)).toBeLessThanOrEqual(2);
  } finally { f.close(); }
});

test('recent Codex or missing local request data is an unknown contributor, not zero spend', async () => {
  const now = Date.now(), rows = [{ id: 1, task_id: 2, provider: 'codex', started_at: new Date(now - 10_000).toISOString(), ended_at: null }];
  const f = setup({ runs: () => ({ rows, truncated: false }) });
  try {
    const r = await f.reader.read();
    expect(r.windows[0]).toMatchObject({ requests: 0, input: 0, cost: 0, unknown_tokens: 1, unknown_cost: 1, complete: false });
    expect(r.coverage.missing_runs).toBe(1);
  } finally { f.close(); }
});

test('one untagged legacy response cannot hide missing usage in a later invocation of the same Worker', async () => {
  const now = Date.now(), rows = [
    { id: 1, task_id: 2, started_at: new Date(now - 10_000).toISOString(), ended_at: new Date(now - 4000).toISOString() },
    { id: 2, task_id: 2, started_at: new Date(now - 1000).toISOString(), ended_at: null },
  ];
  const f = setup({ runs: () => ({ rows, truncated: false }) });
  try {
    f.write([usage(now - 5000)]);
    const r = await f.reader.read();
    expect(r.coverage.missing_runs).toBe(1); expect(r.windows[0].requests).toBe(1);
    expect(r.windows[0].unknown_tokens).toBe(1); expect(r.windows[0].complete).toBe(false);
  } finally { f.close(); }
});

test('bounded tail reads can report explicitly owned Codex tokens without inventing cost or replaying foreign context', async () => {
  const now = Date.now(), rows = [{ id: 7, task_id: 2, provider: 'codex', started_at: new Date(now - 1000).toISOString(), ended_at: null }];
  const f = setup({ fileBytes: 2048, runs: () => ({ rows, truncated: false }) });
  try {
    const own = { ...usage(f.now, 50, { provider: 'codex', usage: { input: 30, cacheRead: 20, output: 10 } }), lush: { task_id: 2, run_id: 7 } };
    const foreign = { ...usage(f.now, 1000), lush: { task_id: 1, run_id: 1 } };
    f.write([...Array.from({ length: 40 }, () => foreign), own]);
    const r = await f.reader.read();
    expect(r.windows[0]).toMatchObject({ input: 50, output: 10, requests: 1, unknown_cost: 2, unknown_tokens: 1, complete: false });
    expect(r.coverage.missing_runs).toBe(0); expect(r.coverage.truncated_files).toBe(1);
    expect(r.coverage.bytes_read).toBeLessThan(3000);
  } finally { f.close(); }
});

test('cold-start Pi tails recover uniquely time-attributed own usage after a >512KiB tool body without replaying fork context', async () => {
  const now = Date.now(), rows = [{ id: 8, task_id: 2, provider: 'pi', started_at: new Date(now - 5000).toISOString(), ended_at: null }];
  const f = setup({ runs: () => ({ rows, truncated: false }) });
  try {
    f.write([{ type: 'session', version: 3, timestamp: new Date(now - 5000).toISOString(), id: 'lush-task-2' },
      { type: 'custom', customType: 'lush.invocation', data: { task_id: 2, run_id: 8 } },
      { type: 'message', message: { role: 'toolResult', content: 'x'.repeat(600 * 1024) } },
      usage(now - 6000, 1000), // copied old context precedes the local invocation
      { ...usage(now - 2000, 1000), lush: { task_id: 1, run_id: 1 } },
      usage(now - 1000, 40)]);
    expect(fs.statSync(f.file).size).toBeGreaterThan(512 * 1024);
    const r = await f.reader.read();
    expect(r.windows[0]).toMatchObject({ input: 45, output: 5, cost: 0.1, requests: 1, complete: false });
    expect(r.coverage).toMatchObject({ truncated_files: 1, missing_runs: 0, complete: false });
    expect(r.coverage.bytes_read).toBeLessThan(513 * 1024);
    fs.appendFileSync(f.file, JSON.stringify(usage(now, 20)) + '\n');
    const appended = await f.reader.read();
    expect(appended.windows[0]).toMatchObject({ input: 70, requests: 2, complete: false });
    expect(appended.coverage.bytes_read).toBeLessThan(2048);
  } finally { f.close(); }
});

test('Pi tail attribution stays unknown with no, ambiguous, non-Pi, truncated metadata, shared start boundary or explicit foreign marker', async () => {
  const now = Date.now(), base = { task_id: 2, provider: 'pi', started_at: new Date(now - 5000).toISOString(), ended_at: null };
  for (const metadata of [{ rows: [], truncated: false }, { rows: [{ ...base, id: 8 }, { ...base, id: 9 }], truncated: false },
    { rows: [{ ...base, id: 8 }], truncated: true },
    { rows: [{ ...base, id: 8, provider: 'codex' }], truncated: false },
    { rows: [{ ...base, id: 8, started_at: new Date(now).toISOString() }], truncated: false }]) {
    const f = setup({ fileBytes: 1024, runs: () => metadata });
    try {
      f.write([{ type: 'message', message: { role: 'toolResult', content: 'x'.repeat(2048) } }, usage(now, 1000)]);
      const r = await f.reader.read(); expect(r.windows[0].requests).toBe(0); expect(r.coverage.complete).toBe(false);
    } finally { f.close(); }
  }
  const f = setup({ fileBytes: 1024, runs: () => ({ rows: [{ ...base, id: 8 }], truncated: false }) });
  try {
    f.write([{ type: 'message', message: { role: 'toolResult', content: 'x'.repeat(2048) } },
      { type: 'custom', customType: 'lush.invocation', data: { task_id: 1, run_id: 1 } }, usage(now, 1000)]);
    expect((await f.reader.read()).windows[0].requests).toBe(0);
  } finally { f.close(); }
});

test('missing run intervals mark all intersecting buckets/windows but preserve independently observed flow', async () => {
  const f = setup(), now = f.now;
  f.reader.runs = () => ({ rows: [
    { id: 8, task_id: 2, started_at: new Date(now - 400_000).toISOString(), ended_at: new Date(now - 120_000).toISOString() },
    { id: 9, task_id: 2, started_at: new Date(now - 30_000).toISOString(), ended_at: null },
  ], truncated: false });
  try {
    f.write([{ ...usage(now - 1000, 30), lush: { task_id: 2, run_id: 9 } }]);
    const r = await f.reader.read();
    expect(r.windows[0]).toMatchObject({ input: 35, requests: 1, unknown_tokens: 0 });
    expect(r.windows[1]).toMatchObject({ input: 35, requests: 1, unknown_tokens: 1 });
    const affected = r.buckets.filter(b => b.unknown_tokens);
    expect(affected.length).toBeGreaterThan(20);
    expect(affected.every(b => Date.parse(b.at) <= now - 120_000 && Date.parse(b.at) + 10_000 > now - 400_000)).toBe(true);
    expect(r.buckets[r.buckets.length - 1].input + r.buckets[r.buckets.length - 2].input).toBe(35);
  } finally { f.close(); }
});

test('a symlink session directory is unavailable rather than a cross-project read', async () => {
  const f = setup(), elsewhere = temp();
  try {
    fs.rmdirSync(f.dir); fs.symlinkSync(elsewhere, f.dir);
    const r = await f.reader.read(); expect(r.coverage.unreadable_files).toBe(1); expect(r.coverage.complete).toBe(false);
    expect(r.windows[0].requests).toBe(0);
  } finally { f.close(); fs.rmSync(elsewhere, { recursive: true, force: true }); }
});

test('Project diagnostics wrapper and RPC protect user-only no-parameter interface', async () => {
  const f = fixture({ run: async () => '' });
  try {
    expect(assertAllowed('system.diagnostics', {}, null)).toBeNull();
    for (const actor of [{ task_id: 2 }, { role: 'manager' }, { role: 'integration' }]) {
      expect(() => assertAllowed('system.diagnostics', {}, actor)).toThrow('user approval');
      expect(() => handlers['system.diagnostics'](f.project, {}, actor)).toThrow('user approval');
    }
    expect(() => assertAllowed('system.diagnostics', { project: '/tmp' }, null)).toThrow('unknown parameter');
    const r = await handlers['system.diagnostics'](f.project, {}, null);
    expect(r.version).toBe(1); expect(r.coverage.complete).toBe(true); expect(r.buckets).toHaveLength(60);
  } finally { await f.close(); }
});
