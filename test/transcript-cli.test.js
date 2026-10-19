import { test, expect } from 'bun:test';
import { run } from '../src/cli/commands/task.js';

test('single transcript query remains available to users and agents as JSON without polling', async () => {
  const page = { task_id: 7, steps: [{ seq: 10, kind: 'text', body: 'recorded text' }], next: 10, has_more: true };
  for (const token of [null, 'agent']) {
    const requests = [];
    const client = { token, async request(method, params) { requests.push({ method, params }); return page; } };
    expect(await run('worker', ['transcript', '7', '--after', '9'], { client, json: true })).toBe(page);
    expect(requests).toEqual([{ method: 'worker.transcript', params: { id: 7, after: 9 } }]);
  }
});
