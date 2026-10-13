import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, gate } from '../helpers.js';
import { UsageIndex } from '../../src/core/usage-index.js';
import { readCompactUsageFile } from '../../src/core/usage-statistics.js';

test('Project recover starts one background index and shutdown drains its admitted stream before closing it', async () => {
  const f = fixture(), entered = gate(), release = gate(); let parsed = 0, stopped = false;
  const dir = path.join(f.config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
  for (const id of [1, 2]) fs.writeFileSync(path.join(dir, `life_lush-task-${id}.jsonl`), JSON.stringify({
    type: 'message', message: { role: 'assistant', usage: { input: id, cost: { total: 0 } } } }) + '\n');
  f.project.usageIndex = new UsageIndex(f.config, { parse: async (...args) => {
    parsed++; entered.resolve(); await release.promise; return readCompactUsageFile(...args);
  } });
  try {
    f.project.recover(); await entered.promise;
    const shutdown = f.project.shutdown().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(stopped).toBe(false); expect(parsed).toBe(1);
    expect(f.project.usageIndex.stopping).toBe(true);
    release.resolve(); await shutdown;
    expect(stopped).toBe(true); expect(parsed).toBe(1);
    expect(f.project.usageIndex.db).toBeNull(); expect(f.project.usageIndex.timer).toBeNull();
    // The admitted, completed source is persisted even though shutdown was requested mid-parse.
    const next = new UsageIndex(f.config);
    try {
      const file = path.join(dir, 'life_lush-task-1.jsonl');
      expect(next.get(file, fs.statSync(file)).resources).toMatchObject({ input: 1, known_tokens: 1, known_cost: 1 });
      const remaining = path.join(dir, 'life_lush-task-2.jsonl');
      expect(next.get(remaining, fs.statSync(remaining))).toBeNull();
    } finally { await next.stop(); }
  } finally { release.resolve(); await f.close(); }
});
