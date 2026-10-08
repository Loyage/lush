import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId } from '../../src/host/registry.js';
import { env, temp } from '../helpers.js';
import { setup, fetch } from './harness.js';

const post = (url, method = 'notice.rechoose') => fetch(url + '/api/action', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ method, params: { id: 8, answer: { answers: [{ selected: [1], custom: '' }] },
    revision: 'legacy', request_id: '76e2c51f-474a-40da-979c-27c6affb4e23' } }),
});

test('authenticated single-project Host rejects retired snapshot routes and actions without reaching runtime', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'test-only-password' } }), calls = [];
  f.project.noticeSnapshot = () => { calls.push('read'); };
  f.project.rechooseNotice = () => { calls.push('restore'); };
  try {
    expect((await fetch(f.url + '/api/notice/8/snapshot')).status).toBe(401);
    expect((await post(f.url)).status).toBe(401);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=test-only-password&next=%2F' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    for (const suffix of ['', '?revision=legacy', '?_token=forged'])
      expect((await fetch(f.url + '/api/notice/8/snapshot' + suffix, { headers: { Cookie } })).status).toBe(404);
    for (const method of ['notice.rechoose', 'notice.snapshot']) {
      const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie },
        body: JSON.stringify({ method, params: { id: 8 } }) });
      expect(response.status).toBe(400);
    }
    expect(calls).toEqual([]);
  } finally { await f.close(); }
});

test('workbench rejects retired choice APIs for every explicit project without forwarding', async () => {
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
      expect((await fetch(route + '/api/notice/8/snapshot')).status).toBe(404);
      expect((await post(route)).status).toBe(400);
    }
    expect(calls).toEqual([]);
  } finally { web.stop(true); for (const dir of [a,b,global]) fs.rmSync(dir, { recursive: true, force: true }); }
});
