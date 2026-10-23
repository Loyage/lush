import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo } from './helpers.js';
import { beginCLIHistory, finishCLIHistory, workerCLIHistory, clearWorkerCLIHistory } from '../src/core/worker-cli-history.js';

test('main CLI history privately persists an encrypted command and its completed output', async () => {
  const f = fixture(); await repo(f.root);
  const task = await f.project.ensureMainTask();
  const file = path.join(f.config.home, 'worker-cli-history', `${task.id}.json`);
  const keyFile = path.join(f.config.home, 'worker-cli-history.key');
  try {
    const item = beginCLIHistory(f.project, task.id, 'COMMAND_SECRET', '/WORKSPACE_SECRET');
    expect(workerCLIHistory(f.project, { id: task.id }).entries[0]).toMatchObject({ id: item.history_id, status: 'unknown', exit_code: null });
    finishCLIHistory(f.project, task.id, item.history_id, { stdout: 'OUTPUT_SECRET', stderr: 'ERROR_SECRET', exit_code: 0, signal: null,
      timed_out: false, truncated: false, duration_ms: 7, status: 'succeeded' });
    const encrypted = fs.readFileSync(file, 'utf8');
    for (const secret of ['COMMAND_SECRET', 'WORKSPACE_SECRET', 'OUTPUT_SECRET', 'ERROR_SECRET']) expect(encrypted).not.toContain(secret);
    for (const name of [file, keyFile]) expect(fs.statSync(name).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const fresh = { config: f.config, store: f.store };
    expect(workerCLIHistory(fresh, { id: task.id }).entries[0]).toMatchObject({ command: 'COMMAND_SECRET', stdout: 'OUTPUT_SECRET', status: 'succeeded' });
    expect(clearWorkerCLIHistory(f.project, { id: task.id })).toEqual({ cleared: true });
    expect(workerCLIHistory(fresh, { id: task.id }).entries).toEqual([]);
  } finally { await f.close(); }
});
