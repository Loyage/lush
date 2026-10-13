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
    expect(appended.coverage.bytes_read).toBeLessThan(513 * 1024); // append plus bounded head replay
    const recovered = await f.reader.read();
    expect(recovered.coverage).toMatchObject({ truncated_files: 0, missing_runs: 0, malformed_lines: 0, complete: true });
    expect(recovered.windows[0]).toMatchObject({ input: 70, output: 10, cost: 0.2, requests: 2, complete: true });
    expect(recovered.buckets.every(bucket => !bucket.unknown_tokens && !bucket.unknown_cost)).toBe(true);
    expect(recovered.coverage.bytes_read).toBeLessThan(513 * 1024);
    const unchanged = await f.reader.read();
    expect(unchanged.windows).toEqual(recovered.windows);
    expect(unchanged.coverage.bytes_read).toBeLessThan(1024);
  } finally { f.close(); }
});

async function finishReplay(f, attempts = 32) {
  let result;
  for (let i = 0; i < attempts; i++) {
    result = await f.reader.read();
    expect(result.coverage.bytes_read).toBeLessThanOrEqual(f.reader.maxBytes);
    expect(result.coverage.bytes_read).toBeLessThan(f.reader.fileBytes + 1024);
    if (!f.reader.files.get(f.file)?.recovery) return result;
  }
  throw new Error('fixture head replay did not finish');
}
const marker = (task_id = 2, run_id = 8) => ({ type: 'custom', customType: 'lush.invocation', data: { task_id, run_id } });
const largeTool = bytes => ({ type: 'message', message: { role: 'toolResult', content: 'x'.repeat(bytes) } });

test('elapsed time and a newly complete response cannot clear an unparsed prefix', async () => {
  const f = setup({ fileBytes: 1024 }), started = f.now;
  f.reader.runs = () => ({ rows: [{ id: 8, task_id: 2, provider: 'pi', started_at: new Date(started - 1000).toISOString(), ended_at: null }], truncated: false });
  try {
    f.write([marker(), largeTool(12_000), usage(f.now)]);
    await f.reader.read();
    f.now += 601_000;
    fs.appendFileSync(f.file, JSON.stringify(usage(f.now, 20)) + '\n');
    const stillUnknown = await f.reader.read();
    expect(stillUnknown.windows[0]).toMatchObject({ input: 25, requests: 1, complete: false });
    expect(stillUnknown.coverage.truncated_files).toBe(1);
    expect(stillUnknown.buckets.every(bucket => bucket.unknown_tokens > 0 && bucket.unknown_cost > 0)).toBe(true);
    expect(f.reader.files.get(f.file).recovery.offset).toBeLessThan(fs.statSync(f.file).size);
    const recovered = await finishReplay(f);
    expect(recovered.windows[0]).toMatchObject({ input: 25, requests: 1, complete: true });
    expect(recovered.coverage.complete).toBe(true);
  } finally { f.close(); }
});

test('a >512KiB assistant body is compacted across reads without losing usage or duplicating it', async () => {
  const f = setup();
  try {
    const message = usage(f.now, 30);
    message.message.content = '🦊\\\"\n'.repeat(120_000);
    f.write([marker(), message]);
    const first = await f.reader.read();
    expect(first.coverage.complete).toBe(false);
    const recovered = await finishReplay(f);
    expect(recovered.windows[0]).toMatchObject({ input: 35, output: 5, cost: 0.1, requests: 1, complete: true });
    expect(recovered.coverage).toMatchObject({ malformed_lines: 0, partial_files: 0, truncated_files: 0, complete: true });
    expect((await f.reader.read()).windows[0].input).toBe(35);
  } finally { f.close(); }
});

test('head replay recovers multiple invocations and excludes explicit foreign fork context', async () => {
  const f = setup({ fileBytes: 1024 }), now = f.now;
  f.reader.runs = () => ({ rows: [
    { id: 8, task_id: 2, provider: 'pi', started_at: new Date(now - 10_000).toISOString(), ended_at: new Date(now - 5000).toISOString() },
    { id: 9, task_id: 2, provider: 'pi', started_at: new Date(now - 5000).toISOString(), ended_at: null },
  ], truncated: false });
  try {
    f.write([marker(1, 1), usage(now - 9000, 1000), marker(), usage(now - 6000, 10), largeTool(3000),
      marker(2, 9), { ...usage(now - 1000, 1000), lush: { task_id: 1, run_id: 1 } }, usage(now - 1000, 20)]);
    const first = await f.reader.read();
    expect(first.coverage.missing_runs).toBe(1);
    const recovered = await finishReplay(f);
    expect(recovered.windows[0]).toMatchObject({ input: 40, requests: 2, complete: true });
    expect(recovered.coverage).toMatchObject({ missing_runs: 0, truncated_files: 0, complete: true });
  } finally { f.close(); }
});

test('replay removes only truncation uncertainty, retaining malformed, undated, future and missing-cost evidence', async () => {
  for (const kind of ['malformed', 'undated', 'future', 'cost']) {
    const f = setup({ fileBytes: 1024 });
    try {
      let problem = usage(f.now, 20);
      if (kind === 'undated') delete problem.timestamp;
      if (kind === 'future') problem.timestamp = new Date(f.now + 60_000).toISOString();
      if (kind === 'cost') delete problem.message.usage.cost;
      f.write([marker(), problem, largeTool(3000), usage(f.now)]);
      if (kind === 'malformed') fs.writeFileSync(f.file, fs.readFileSync(f.file).toString().replace(JSON.stringify(problem), 'invalid'));
      await f.reader.read();
      const recovered = await finishReplay(f);
      expect(recovered.coverage.truncated_files).toBe(0);
      expect(recovered.coverage.complete).toBe(false);
      if (kind === 'malformed') expect(recovered.coverage.malformed_lines).toBe(1);
      if (kind === 'undated') expect(recovered.coverage.undated_requests).toBe(1);
      if (kind === 'future') expect(recovered.coverage.future_requests).toBe(1);
      if (kind === 'cost') expect(recovered.windows[0].unknown_cost).toBe(1);
    } finally { f.close(); }
  }
});

test('discarded oversized strings still validate invalid escapes, unicode and control bytes', async () => {
  for (const invalid of ['\\q', '\\u12G4', '\t']) {
    const f = setup({ fileBytes: 1024 });
    try {
      const tool = JSON.stringify(largeTool(3000)).replace('x'.repeat(3000), 'x'.repeat(2990) + invalid);
      fs.writeFileSync(f.file, [JSON.stringify(marker()), tool, JSON.stringify(usage(f.now))].join('\n') + '\n');
      await f.reader.read();
      const recovered = await finishReplay(f);
      expect(recovered.coverage).toMatchObject({ truncated_files: 0, malformed_lines: 1, complete: false });
      expect(recovered.windows[0].input).toBe(15);
    } finally { f.close(); }
  }
});

test('valid unicode escapes crossing all byte-budget alignments survive string compaction', async () => {
  for (let alignment = 0; alignment < 6; alignment++) {
    const f = setup({ fileBytes: 1024 });
    try {
      const tool = JSON.stringify(largeTool(1)).replace('"content":"x"', `"content":"${'x'.repeat(alignment)}${'\\u0041'.repeat(800)}"`);
      fs.writeFileSync(f.file, [JSON.stringify(marker()), tool, JSON.stringify(usage(f.now))].join('\n') + '\n');
      await f.reader.read();
      const result = await finishReplay(f);
      expect(result.windows[0]).toMatchObject({ input: 15, requests: 1, complete: true });
      expect(result.coverage.malformed_lines).toBe(0);
    } finally { f.close(); }
  }
});

test('large append backlogs and partial giant strings recover by continuous reads without a sticky truncation flag', async () => {
  const f = setup({ fileBytes: 1024 });
  try {
    f.write([marker(), usage(f.now)]); await f.reader.read();
    const tool = JSON.stringify(largeTool(3500));
    fs.appendFileSync(f.file, tool.slice(0, 2500));
    const first = await f.reader.read(); expect(first.coverage.complete).toBe(false);
    fs.appendFileSync(f.file, tool.slice(2500) + '\n' + JSON.stringify(usage(f.now, 20)) + '\n');
    let result;
    for (let i = 0; i < 4; i++) result = await f.reader.read();
    expect(result.coverage).toMatchObject({ truncated_files: 0, partial_files: 0, malformed_lines: 0, complete: true });
    expect(result.windows[0]).toMatchObject({ input: 40, requests: 2, complete: true });
  } finally { f.close(); }
});

test('replacement, rewrite, truncation and deletion discard incomplete replay checkpoints', async () => {
  for (const operation of ['replace', 'rewrite', 'truncate', 'delete']) {
    const f = setup({ fileBytes: 1024 });
    try {
      f.write([marker(), largeTool(6000), usage(f.now, 1000)]);
      await f.reader.read(); await f.reader.read();
      expect(f.reader.files.get(f.file).recovery.offset).toBeGreaterThan(0);
      const replacement = JSON.stringify(marker()) + '\n' + JSON.stringify(usage(f.now, 20)) + '\n';
      if (operation === 'replace') {
        fs.writeFileSync(f.file + '.replacement', replacement); fs.renameSync(f.file + '.replacement', f.file);
      } else if (operation === 'rewrite') {
        fs.writeFileSync(f.file, replacement + JSON.stringify(largeTool(6000)) + '\n');
      } else if (operation === 'truncate') fs.writeFileSync(f.file, replacement);
      else fs.unlinkSync(f.file);
      await f.reader.read();
      const result = operation === 'delete' ? await f.reader.read() : await finishReplay(f);
      expect(result.windows[0].input).toBe(operation === 'delete' ? 0 : 25);
      expect(result.coverage.complete).toBe(true);
      if (operation === 'delete') expect(f.reader.files.size).toBe(0);
    } finally { f.close(); }
  }
});

test('a row-limited replay cannot replace an already known tail subtotal with dropped duplicate rows', async () => {
  const f = setup({ fileBytes: 1024, maxRows: 1 });
  try {
    f.write([marker(), usage(f.now, 10), largeTool(3000), { ...usage(f.now, 20), lush: { task_id: 2, run_id: 8 } }]);
    const first = await f.reader.read(); expect(first.windows[0].input).toBe(25);
    const result = await finishReplay(f);
    expect(result.windows[0].input).toBe(25);
    expect(result.coverage).toMatchObject({ truncated_files: 1, complete: false });
    expect(f.reader.files.get(f.file).rows).toHaveLength(1);
  } finally { f.close(); }
});

test('bounded metadata overflow is incomplete, not silently accepted or mislabeled as malformed JSON', async () => {
  const f = setup({ fileBytes: 1024 });
  try {
    f.write([marker(), { type: 'message', message: { role: 'toolResult', content: Array.from({ length: 2000 }, () => 1) } },
      { ...usage(f.now, 20), lush: { task_id: 2, run_id: 8 } }]);
    await f.reader.read();
    const result = await finishReplay(f);
    expect(result.windows[0].input).toBe(25);
    expect(result.coverage).toMatchObject({ truncated_files: 1, malformed_lines: 0, complete: false });
  } finally { f.close(); }
});

test('a changed head-replay checkpoint invalidates earlier progress even while the tail is appended', async () => {
  const f = setup({ fileBytes: 1024 });
  try {
    f.write([marker(), largeTool(6000), usage(f.now)]);
    await f.reader.read(); await f.reader.read();
    const offset = f.reader.files.get(f.file).recovery.offset;
    const fd = fs.openSync(f.file, 'r+');
    try { fs.writeSync(fd, Buffer.from('y'), 0, 1, offset - 1); } finally { fs.closeSync(fd); }
    fs.appendFileSync(f.file, JSON.stringify(usage(f.now, 20)) + '\n');
    const reset = await f.reader.read();
    expect(reset.coverage.complete).toBe(false);
    expect(f.reader.files.get(f.file).recovery.offset).toBe(0);
    const result = await finishReplay(f);
    expect(result.windows[0]).toMatchObject({ input: 40, requests: 2, complete: true });
  } finally { f.close(); }
});

test('global and row budgets remain incomplete during replay instead of clearing a marker unconditionally', async () => {
  const f = setup({ fileBytes: 1024, maxBytes: 512, maxRows: 1 });
  try {
    f.write([marker(), usage(f.now, 10), largeTool(3000), usage(f.now, 20)]);
    for (let i = 0; i < 16; i++) {
      const result = await f.reader.read();
      expect(result.coverage.bytes_read).toBeLessThanOrEqual(512);
      expect(result.coverage.complete).toBe(false);
      expect([...f.reader.files.values()].reduce((n, state) => n + state.rows.length + (state.recovery?.rows.length ?? 0), 0)).toBeLessThanOrEqual(1);
      expect([...f.reader.files.values()].reduce((n, state) => n + state.tail.length + (state.recovery?.tail.length ?? 0), 0)).toBeLessThanOrEqual(512);
    }
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
