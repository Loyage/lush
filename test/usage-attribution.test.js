import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { readUsageStatistics } from '../src/core/usage-statistics.js';
const at = n => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
const message = (n, lush) => ({ type: 'message', timestamp: at(n), ...(lush ? { lush } : {}), message: {
  role: 'assistant', usage: { input: 10, cacheRead: 20, output: 3, totalTokens: 33, cost: { total: 0.2 } },
} });
function save(config, id, rows) {
  const dir = path.join(config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `sample_lush-task-${id}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

test('new run markers and Codex row metadata remain attributable after task deletion', async () => {
  const f = fixture();
  try {
    save(f.config, 7, [
      { type: 'custom', customType: 'lush.invocation', data: { task_id: 7, run_id: 11, role: 'worker' } }, message(1), message(2),
      { type: 'custom', customType: 'lush.invocation', data: { task_id: 7, run_id: 12, role: 'worker' } }, message(4),
    ]);
    save(f.config, 9, [message(3, { task_id: 9, run_id: 13, role: 'research' })]);
    const all = await readUsageStatistics(f.config);
    expect(all.totals.requests).toBe(4);
    expect(all.roles.map(row => [row.role, row.requests])).toEqual([['worker', 3], ['research', 1]]);
    expect(all.invocations.map(row => [row.task_id, row.run_id, row.requests])).toEqual([[7, 11, 2], [7, 12, 1], [9, 13, 1]]);
    expect(all.attribution.unknown_run_requests).toBe(0);
    const window = await readUsageStatistics(f.config, { start: at(2), end: at(4) });
    expect(window.totals.requests).toBe(2);
    expect(window.invocations.reduce((sum, row) => sum + row.tokens, 0)).toBe(window.totals.tokens);
  } finally { await f.close(); }
});

test('legacy attribution uses unique time matches only; cached usage does not cache mutable database attribution', async () => {
  const f = fixture();
  try {
    save(f.config, 7, [message(1), message(3), message(5)]);
    const metadata = { tasks: [{ id: 7, role: 'planner', status: 'failed', integration: 'none', goal: 'a'.repeat(1000) }], runs: [
      { id: 11, task_id: 7, role: 'planner', status: 'completed', started_at: at(0), ended_at: at(2) },
      { id: 12, task_id: 7, role: 'planner', status: 'failed', started_at: at(4), ended_at: at(6) },
    ] };
    const known = await readUsageStatistics(f.config, {}, metadata);
    expect(known.attribution).toMatchObject({ unknown_role_requests: 0, unknown_run_requests: 1 });
    expect(known.tasks[0].goal).toHaveLength(160);
    expect(known.tasks[0].integration).toBe('none');
    metadata.runs.push({ ...metadata.runs[0], id: 13 });
    expect((await readUsageStatistics(f.config, {}, metadata)).attribution.unknown_run_requests).toBe(2);
    const deleted = await readUsageStatistics(f.config);
    expect(deleted.totals).toEqual(known.totals);
    expect(deleted.attribution).toMatchObject({ unknown_role_requests: 3, unknown_run_requests: 3 });
  } finally { await f.close(); }
});

test('mismatched task metadata is not accepted; attribution tables are bounded without losing totals', async () => {
  const f = fixture();
  try {
    for (let id = 1; id <= 105; id++) save(f.config, id, [message(1, { task_id: id, run_id: id, role: 'worker' })]);
    save(f.config, 200, [message(2, { task_id: 999, run_id: 999, role: 'planner' })]);
    const result = await readUsageStatistics(f.config);
    expect(result.totals.requests).toBe(106);
    expect(result.tasks).toHaveLength(100); expect(result.invocations).toHaveLength(100);
    expect(result.attribution).toMatchObject({ task_groups: 106, invocation_groups: 106,
      tasks_truncated: true, invocations_truncated: true, unknown_role_requests: 1, unknown_run_requests: 1 });
    expect(result.roles.reduce((n, row) => n + row.requests, 0)).toBe(106);
  } finally { await f.close(); }
});
