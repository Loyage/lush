import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { PARAMS, USER_ONLY } from '../src/rpc/registry.js';
import { run } from '../src/cli/commands/notice.js';
import { HELP } from '../src/cli/help.js';
import { temp } from './helpers.js';

const answer = { answers: [{ selected: [1], custom: '' }] };
const requestId = '76e2c51f-474a-40da-979c-27c6affb4e23';
const params = { id: 8, answer, revision: 'fixed-snapshot', request_id: requestId };

test('choice snapshot RPCs are user-only, narrow and preserve restore envelope without private profile', async () => {
  const calls = [];
  const rpc = new Dispatcher({ actor: token => token ? 7 : null,
    noticeSnapshot(id) { calls.push(['read', id]); return { notice_id: id, status: 'ready', revision: 'fixed-snapshot' }; },
    rechooseNotice(...args) { calls.push(['restore', ...args]); return { notice_id: 8, reused: false,
      task: { id: 9, worker_number: 'W9', retry_profile: '{"secret":"private"}' } }; },
  });
  expect(PARAMS['notice.snapshot']).toEqual(['id']);
  expect(PARAMS['notice.rechoose']).toEqual(['id','answer','revision','request_id']);
  for (const [method, input] of [['notice.snapshot', { id: 8 }], ['notice.rechoose', params]]) {
    expect(USER_ONLY.has(method)).toBe(true);
    await expect(rpc.dispatch(method, { ...input, _token: 'agent' })).rejects.toThrow('requires user approval');
    for (const extra of ['path','branch','task','profile','force','answer_source'])
      await expect(rpc.dispatch(method, { ...input, [extra]: 'forged' })).rejects.toThrow('unknown parameter');
    await expect(rpc.dispatch(method, { ...input, id: 'W8' })).rejects.toThrow('positive integer');
  }
  expect(calls).toEqual([]);
  expect(await rpc.dispatch('notice.snapshot', { id: 8 })).toEqual({ notice_id: 8, status: 'ready', revision: 'fixed-snapshot' });
  expect(await rpc.dispatch('notice.rechoose', params)).toEqual({ notice_id: 8, reused: false, task: { id: 9, worker_number: 'W9' } });
  expect(calls).toEqual([['read', 8], ['restore', 8, answer, 'fixed-snapshot', requestId]]);
});

test('notice CLI requires explicit snapshot revision and reusable request identity before creating a route', async () => {
  const root = temp(), calls = [], result = { notice_id: 8, task: { id: 9 }, reused: false };
  const client = { async request(method, params) { calls.push({ method, params }); return result; } };
  const file = path.join(root, 'answer.json');
  fs.writeFileSync(file, JSON.stringify(answer));
  try {
    await run('notice', ['snapshot', '8'], { client });
    expect(calls).toEqual([{ method: 'notice.snapshot', params: { id: 8 } }]);
    const args = ['rechoose','8','--answers-file',file,'--revision','fixed-snapshot','--request-id',requestId];
    expect(await run('notice', [...args], { client })).toBe(result);
    expect(await run('notice', [...args], { client })).toBe(result);
    expect(calls.slice(1)).toEqual([{ method: 'notice.rechoose', params }, { method: 'notice.rechoose', params }]);
    for (const flag of ['--answers-file','--revision','--request-id']) {
      const missing = [...args], index = missing.indexOf(flag); missing.splice(index, 2);
      await expect(run('notice', missing, { client })).rejects.toThrow('rechoose requires');
    }
    for (const invalid of [['snapshot','W8'], ['snapshot','8','--force'], [...args,'--force'], [...args,'--revision','another']])
      await expect(run('notice', invalid, { client })).rejects.toThrow();
    fs.writeFileSync(file, 'not JSON');
    await expect(run('notice', [...args], { client })).rejects.toThrow();
    expect(calls).toHaveLength(3);
    expect(HELP).toContain('notice snapshot ID');
    expect(HELP).toContain('notice rechoose ID');
    expect(HELP).toContain('重试沿用 UUID');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
