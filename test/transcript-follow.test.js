import { test, expect } from 'bun:test';
import { followTranscript, run } from '../src/cli/commands/task.js';

const step = (seq, body, extra = {}) => ({ seq, kind: 'result', title: 'bash', file: 'session-a', line: seq, body, ...extra });

test('follow prints existing pages first, then only steps newer than the cursor', async () => {
  const requests = [];
  const controller = new AbortController();
  let polls = 0;
  const client = { token: null, async request(method, params) {
    requests.push({ method, params });
    if (method === 'task.transcript') {
      return params.after === 0
        ? { task_id: 7, files: ['session-a'], steps: [step(1, 'first'), step(2, 'second')], next: 2, has_more: true, truncated: false }
        : { task_id: 7, files: ['session-a'], steps: [step(3, 'third')], next: 3, has_more: false, truncated: false };
    }
    polls += 1;
    if (polls === 1) return { task_id: 7, files: ['session-a'], steps: [step(4, 'fourth')], next: 4, oldest: 4, has_older: false, truncated: false };
    return { task_id: 7, files: ['session-a'], steps: [], next: 4, oldest: 4, has_older: false, truncated: false };
  } };
  const out = [], err = [];
  await followTranscript(client, 7, {
    signal: controller.signal, print: text => out.push(text), note: text => err.push(text),
    sleep: async () => { if (polls >= 2) controller.abort(); },
  });
  const text = out.join('');
  expect(text).toContain('[1] result\tbash\nfirst\n');
  expect(text).toContain('[2] result\tbash\nsecond\n');
  expect(text).toContain('[3] result\tbash\nthird\n');
  expect(text).toContain('[4] result\tbash\nfourth\n');
  expect(requests).toEqual([
    { method: 'task.transcript', params: { id: 7, after: 0, limit: 200 } },
    { method: 'task.transcript', params: { id: 7, after: 2, limit: 200 } },
    { method: 'task.transcript_latest', params: { id: 7, after: 3, before: 0, limit: 200 } },
    { method: 'task.transcript_latest', params: { id: 7, after: 4, before: 0, limit: 200 } },
  ]);
  expect(err.join('')).toContain('以上是已有记录');
  expect(err.join('')).toContain('已停止跟随');
});

test('follow starts from --after and stops without polling when there is no session file', async () => {
  const requests = [];
  const client = { token: null, async request(method, params) {
    requests.push({ method, params });
    return { task_id: 9, files: [], steps: [], next: params.after ?? 0, has_more: false, truncated: false };
  } };
  const err = [];
  await followTranscript(client, 9, { after: 5, print: () => {}, note: text => err.push(text), sleep: async () => {} });
  expect(requests).toEqual([{ method: 'task.transcript', params: { id: 9, after: 5, limit: 200 } }]);
  expect(err.join('')).toContain('还没有 pi 会话记录');
});

test('follow is a user-only, human-readable command', async () => {
  const client = token => ({ token, request: async () => ({ task_id: 1, files: [], steps: [], next: 0, has_more: false, truncated: false }) });
  await expect(run('task', ['transcript', '1', '--follow'], { client: client('live'), json: false }))
    .rejects.toThrow('must end their invocation');
  await expect(run('task', ['transcript', '1', '--follow'], { client: client(null), json: true }))
    .rejects.toThrow('--json is not supported');
});
