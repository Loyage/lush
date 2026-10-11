import { test, expect } from 'bun:test';
import * as commands from '../src/cli/commands/task.js';

const page = { task_id: 7, files: ['session-a'], steps: [{ seq: 10, kind: 'text', title: 'assistant',
  file: 'session-a', line: 1, body: 'recorded text' }], next: 10, has_more: true, truncated: false };

function client(token = null) {
  const requests = [];
  return { token, requests, async request(method, params) {
    requests.push({ method, params });
    if (method !== 'worker.transcript') throw Error('unexpected polling or mutation');
    return page;
  } };
}

test('single transcript query remains available to users and agents as JSON without polling', async () => {
  for (const token of [null, 'agent']) {
    const c = client(token);
    expect(await commands.run('worker', ['transcript', '7', '--after', '9'], { client: c, json: true })).toBe(page);
    expect(c.requests).toEqual([{ method: 'worker.transcript', params: { id: 7, after: 9 } }]);
  }
});

test('single text query prints one page only even when more history is available', async () => {
  const c = client(), lines = [], original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { await commands.run('worker', ['transcript', '7'], { client: c, json: false }); }
  finally { console.log = original; }
  expect(lines.join('\n')).toContain('recorded text');
  expect(c.requests).toEqual([{ method: 'worker.transcript', params: { id: 7, after: 0 } }]);
});

test('removed follow flag fails for users, agents and JSON before RPC or signal installation', async () => {
  const before = process.listenerCount('SIGINT');
  for (const token of [null, 'agent']) for (const json of [false, true]) {
    const c = client(token);
    await expect(commands.run('worker', ['transcript', '7', '--follow'], { client: c, json }))
      .rejects.toThrow('纯文本跟随已移除');
    expect(c.requests).toEqual([]);
    expect(process.listenerCount('SIGINT')).toBe(before);
  }
  expect(commands).not.toHaveProperty('followTranscript');
  expect(commands).not.toHaveProperty('FOLLOW_INTERVAL_MS');
});
