import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { sessionFixture as fixture } from './session-fixture.js';
import { sessionFiles, readTranscript } from '../src/core/transcript.js';
import { readUsageStatistics, readWorkerResources } from '../src/core/usage-statistics.js';
import { workerFiles } from '../src/core/deletion-resources.js';

const record = (id, text) => ({ type: 'message', lush: { task_id: id },
  message: { role: 'assistant', content: [{ type: 'text', text }],
    usage: { input: 10, output: 3, cacheRead: 20, cacheWrite: 5, cost: { total: .2 } } } });

test('both isolated mode sessions remain one Worker in transcript, usage and deletion ownership', async () => {
  const f = fixture();
  try {
    const dir = path.join(f.config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
    const normal = path.join(dir, '01_lush-task-1.jsonl');
    const pi = path.join(dir, '02_lush-task-1-pi.jsonl');
    const other = path.join(dir, '03_lush-task-11-pi.jsonl');
    fs.writeFileSync(normal, JSON.stringify(record(1, 'managed run')) + '\n');
    fs.writeFileSync(pi, JSON.stringify(record(1, 'Pi default run')) + '\n');
    fs.writeFileSync(other, JSON.stringify(record(11, 'other Worker')) + '\n');
    fs.writeFileSync(path.join(dir, '04_lush-task-1-pirate.jsonl'), JSON.stringify(record(1, 'unknown suffix')) + '\n');
    expect(sessionFiles(f.config, 1)).toEqual([path.basename(normal), path.basename(pi)]);
    expect(readTranscript(f.config, 1, 0, 100).steps.map(step => step.body)).toEqual(['managed run', 'Pi default run']);
    const tasks = [{ id: 1, parent_id: null, status: 'waiting' }, { id: 11, parent_id: 1, status: 'waiting' }];
    const resources = await readWorkerResources(f.config, tasks);
    expect(resources.get(1).own).toMatchObject({ input: 70, output: 6, cost: .4 });
    expect(resources.get(1).subtree).toMatchObject({ input: 105, output: 9 });
    const usage = await readUsageStatistics(f.config);
    expect(usage.coverage.files).toBe(3);
    expect(usage.totals).toMatchObject({ requests: 3, input: 30, output: 9 });
    expect(usage.totals.cost).toBeCloseTo(.6);
    expect(workerFiles(f.config, [tasks[0]], [])).toEqual([normal, pi]);
    const contexts = [{ commit_hash: 'a'.repeat(40), task_id: 1, session_path: pi }];
    expect(workerFiles(f.config, [tasks[0]], contexts)).toEqual([normal, pi]);
    expect(() => workerFiles(f.config, [tasks[0]], [{ ...contexts[0], session_path: other }])).toThrow('unknown Worker ownership');
  } finally { await f.close(); }
});
