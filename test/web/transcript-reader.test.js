import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup, fetch } from './harness.js';
import { until } from '../helpers.js';

test('Web full-search, original-step and explanation routes use project RPC and preserve source history', async () => {
  const f = await setup();
  try {
    const task = f.store.create({ role: 'research', input_id: null, goal: 'read output' });
    f.store.update(task.id, { status: 'completed' });
    const dir = path.join(f.config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `001_lush-task-${task.id}.jsonl`), JSON.stringify({ type: 'message', message: {
      role: 'toolResult', toolName: 'bash', toolCallId: 'a', isError: true, content: [{ type: 'text', text: 'exit code 1' }],
    } }) + '\n');
    const search = await (await fetch(`${f.url}/api/task/${task.id}/transcript-search?query=exit&errors=true`)).json();
    expect(search.steps[0].seq).toBe(1);
    const source = await (await fetch(`${f.url}/api/task/${task.id}/transcript-step?seq=1`)).json();
    expect(source.step.body).toBe('exit code 1');
    const createdResponse = await fetch(`${f.url}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json', origin: f.url },
      body: JSON.stringify({ method: 'explanation.start', params: { id: task.id, seq: 1, quote: 'exit code 1' } }) });
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json();
    await until(() => f.store.task(created.id).status === 'completed');
    const result = await (await fetch(`${f.url}/api/explanation/${created.id}`)).json();
    expect(result.source.quote).toBe('exit code 1'); expect(result.result).toContain('Mock explainer');
    expect((await (await fetch(`${f.url}/api/task/${task.id}/explanations`)).json()).explanations[0].id).toBe(created.id);
    expect((await fetch(`${f.url}/api/task/${task.id}/transcript-step?seq=-1`)).status).toBe(400);
    expect((await fetch(`${f.url}/api/task/${task.id}/transcript-search?kind=no`)).status).toBe(400);
  } finally { await f.close(); }
});
