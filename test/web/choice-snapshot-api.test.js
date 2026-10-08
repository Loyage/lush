import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId } from '../../src/host/registry.js';
import { env, temp } from '../helpers.js';
import { setup, fetch } from './harness.js';

const params = { id: 8, answer: { answers: [{ selected: [1], custom: '' }] }, revision: 'snapshot-revision',
  request_id: '76e2c51f-474a-40da-979c-27c6affb4e23' };
const post = (url, input = params, headers = {}, method = 'notice.rechoose') => fetch(url + '/api/action', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ method, params: input }),
});

test('choice HTTP routes retain login, origin, user-only and strict parameter boundaries through real RPC', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'test-only-password' } }), calls = [];
  const snapshot = { notice_id: 8, status: 'ready', revision: params.revision, can_rechoose: true, blockers: [] };
  const restored = { notice_id: 8, task: { id: 9, worker_number: 'W9' }, reused: false };
  f.project.noticeSnapshot = id => { calls.push(['read', id]); return snapshot; };
  f.project.rechooseNotice = (...args) => { calls.push(['restore', ...args]); return restored; };
  try {
    expect((await fetch(f.url + '/api/notice/8/snapshot')).status).toBe(401);
    expect((await post(f.url)).status).toBe(401);
    expect(calls).toHaveLength(0);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=test-only-password&next=%2F' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    const read = await fetch(f.url + '/api/notice/8/snapshot', { headers: { Cookie } });
    expect(read.status).toBe(200); expect(await read.json()).toEqual(snapshot);
    expect(read.headers.get('cache-control')).toBe('no-store');
    const write = await post(f.url, params, { Cookie });
    expect(write.status).toBe(200); expect(await write.json()).toEqual(restored);
    expect(calls).toEqual([['read',8], ['restore',8,params.answer,params.revision,params.request_id]]);
    for (const query of ['?_token=forged','?path=/etc','?id=9','?revision=a&revision=b'])
      expect((await fetch(f.url + '/api/notice/8/snapshot' + query, { headers: { Cookie } })).status).toBe(400);
    for (const route of ['/api/notice/0/snapshot','/api/notice/W8/snapshot','/api/notice/8/rechoose'])
      expect((await fetch(f.url + route, { headers: { Cookie } })).status).toBe(404);
    for (const extra of ['_token','path','branch','profile','force','answer_source'])
      expect((await post(f.url, { ...params, [extra]: 'forged' }, { Cookie })).status).toBe(400);
    expect((await post(f.url, { id: 8 }, { Cookie }, 'notice.snapshot')).status).toBe(400);
    expect((await post(f.url, params, { Cookie, Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await fetch(f.url + '/api/notice/8/snapshot', { headers: { Cookie, Origin: 'https://evil.invalid' } })).status).toBe(403);
    expect((await post(f.url, params, { Cookie, 'Content-Type': 'text/plain' })).status).toBe(400);
    expect(calls).toHaveLength(2);
  } finally { await f.close(); }
});

test('choice snapshots and restore actions bind to the explicit project route, never another tab', async () => {
  const a = temp(), b = temp(), global = temp(), calls = [];
  const web = startWeb(null, 0, { env: env({ LUSH_GLOBAL_CONFIG: global }), openProject: async project => ({
    config: { project, home: path.join(project, '.lush') },
    client: { async request(method, params) { calls.push({ project, method, params }); return { project }; } },
  }) });
  const url = `http://127.0.0.1:${web.port}`;
  try {
    for (const project of [a, b]) await fetch(url + '/api/host/select', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) });
    calls.length = 0;
    for (const project of [a, b, a]) {
      const route = `${url}/p/${projectRouteId(project)}`;
      const read = await fetch(route + '/api/notice/8/snapshot');
      expect(read.status).toBe(200); expect(await read.json()).toEqual({ project });
      expect(calls.at(-1)).toEqual({ project, method: 'notice.snapshot', params: { id: 8 } });
      expect((await post(route)).status).toBe(200);
      expect(calls.at(-1)).toEqual({ project, method: 'notice.rechoose', params });
    }
    const count = calls.length;
    expect((await fetch(url + '/api/notice/8/snapshot')).status).toBe(400);
    expect((await post(url)).status).toBe(400);
    expect((await fetch(`${url}/p/${'0'.repeat(16)}/api/notice/8/snapshot`)).status).toBe(400);
    expect(calls).toHaveLength(count);
  } finally { web.stop(true); for (const dir of [a,b,global]) fs.rmSync(dir, { recursive: true, force: true }); }
});
