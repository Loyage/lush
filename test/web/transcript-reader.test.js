import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup, fetch } from './harness.js';

test('Web transcript search, original step and page read a real session record', async () => {
  const f = await setup();
  try {
    const task = f.store.create({ role: 'research', input_id: null, goal: 'read output' });
    f.store.update(task.id, { status: 'completed' });
    const dir = path.join(f.config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `001_lush-task-${task.id}.jsonl`), JSON.stringify({ type: 'message', message: {
      role: 'toolResult', toolName: 'bash', toolCallId: 'a', content: [{ type: 'text', text: 'hello reader' }],
    } }) + '\n');
    const search = await (await fetch(`${f.url}/api/worker/${task.id}/transcript-search?query=hello`)).json();
    expect(search.steps[0].seq).toBe(1);
    const source = await (await fetch(`${f.url}/api/worker/${task.id}/transcript-step?seq=1`)).json();
    expect(source.step.body).toBe('hello reader');
    const page = await (await fetch(`${f.url}/api/worker/${task.id}/transcript-page`)).json();
    expect(page.steps[0]).toMatchObject({ seq: 1, offset: 0, body: 'hello reader' });
    expect(page).toMatchObject({ next_seq: 2, next_offset: 0, has_more: false });
  } finally { await f.close(); }
});
