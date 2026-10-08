import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { readWorkerResources, readUsageStatistics } from '../src/core/usage-statistics.js';

const message = (input = 10) => JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:00Z',
  message: { role: 'assistant', usage: { input, output: 2, totalTokens: input + 2, cost: { total: 0.1 } } } }) + '\n';

test('compact resource cache survives 129+ unchanged sessions; only changed files are parsed and deleted files disappear', async () => {
  const f = fixture(), original = fs.createReadStream;
  let reads = [];
  fs.createReadStream = function(file, ...args) { reads.push(file); return original.call(this, file, ...args); };
  try {
    const dir = path.join(f.config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
    const file = id => path.join(dir, `now_lush-task-${id}.jsonl`);
    const tasks = Array.from({ length: 140 }, (_, i) => ({ id: i + 1, parent_id: null, status: 'completed' }));
    for (const task of tasks) fs.writeFileSync(file(task.id), message());
    await readWorkerResources(f.config, tasks); expect(reads).toHaveLength(140);
    reads = []; const warm = await readWorkerResources(f.config, tasks); expect(reads).toHaveLength(0);
    expect(warm.get(1).own.input).toBe(10);
    fs.appendFileSync(file(1), message(7));
    reads = []; const appended = await readWorkerResources(f.config, tasks); expect(reads).toEqual([file(1)]);
    expect(appended.get(1).own.input).toBe(17);
    // A same-path replacement must replace the compact total, not add to the old value.
    fs.unlinkSync(file(1)); fs.writeFileSync(file(1), message(3));
    expect((await readWorkerResources(f.config, tasks)).get(1).own.input).toBe(3);
    fs.unlinkSync(file(2));
    expect((await readWorkerResources(f.config, tasks)).get(2).own.input).toBe(0);
    // Statistics still read every request row, not compact lifetime totals.
    const statistics = await readUsageStatistics(f.config);
    expect(statistics.totals.input).toBe(1383);
    reads = []; await readWorkerResources(f.config, tasks); expect(reads).toHaveLength(0);
  } finally { fs.createReadStream = original; await f.close(); }
});
